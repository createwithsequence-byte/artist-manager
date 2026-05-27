import type { Release, ArtistLocation } from "./types";
import { createRateLimiter } from "./rate-limit";

const BASE = "https://musicbrainz.org/ws/2";
const UA = `ArtistScout/0.1 (${process.env.MUSICBRAINZ_CONTACT || "contact@example.com"})`;

// MusicBrainz official policy: 1 req/sec per IP. Pacing at 1 per 1100ms for safety.
const waitForSlot = createRateLimiter(1, 1100);

async function mb<T>(path: string, retries = 2): Promise<T> {
  await waitForSlot();
  const res = await fetch(`${BASE}${path}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 503 && retries > 0) {
    await new Promise((r) => setTimeout(r, 1500));
    return mb<T>(path, retries - 1);
  }
  if (!res.ok) throw new Error(`MusicBrainz ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

type SearchArtist = {
  id: string;
  name: string;
  score: number;
  country?: string;
  area?: { name?: string };
  "begin-area"?: { name?: string };
  relations?: {
    type?: string;
    url?: { resource?: string };
  }[];
};

export type ArtistMatch = {
  mbid: string;
  location: ArtistLocation;
};

function extractSpotifyIdFromUrl(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/artist[/:]([A-Za-z0-9]{22})/);
  return m?.[1] ?? null;
}

/**
 * Find an MB artist record. When `spotifyUrl` is provided (from the CSV),
 * verify the top match's url-relationships include that Spotify ID — this
 * blocks "Tori" → "Tori Kelly" identity poisoning where the most-popular
 * homonym wins. Without a Spotify anchor, fall back to a name-exact-match
 * over the top 3 results before accepting any score≥90 hit.
 */
export async function findArtist(
  name: string,
  spotifyUrl?: string,
): Promise<ArtistMatch | null> {
  const targetSpotifyId = extractSpotifyIdFromUrl(spotifyUrl);
  const q = encodeURIComponent(`artist:"${name}"`);
  // inc=url-rels lets us see Spotify links on each candidate so we can verify
  // identity. Free, costs one extra query parameter.
  const data = await mb<{ artists?: SearchArtist[] }>(
    `/artist/?query=${q}&fmt=json&limit=5&inc=url-rels`,
  );
  const candidates = data.artists ?? [];

  // If CSV gave us a Spotify URL, the only valid match is one with that
  // Spotify ID in its relations. Reject all else — even if MB's top score is 100.
  if (targetSpotifyId) {
    for (const c of candidates) {
      const hasSpotifyLink = (c.relations ?? []).some(
        (rel) =>
          rel.type === "free streaming" &&
          rel.url?.resource?.includes(targetSpotifyId),
      );
      if (hasSpotifyLink) {
        return {
          mbid: c.id,
          location: {
            country: c.country,
            area: c.area?.name,
            beginArea: c["begin-area"]?.name,
            source: "musicbrainz",
          },
        };
      }
    }
    // No candidate matched the Spotify ID — refuse to guess.
    console.warn(
      `[MB] no candidate matched Spotify ID ${targetSpotifyId} for "${name}" (top: ${candidates[0]?.name ?? "none"})`,
    );
    return null;
  }

  // No Spotify anchor — require name-exact match (case-insensitive) AND
  // score≥90 to accept. The old "top result if score≥90" rule was the entire
  // Tori/Charlie identity-poisoning vector for artists with no CSV Spotify URL.
  const nameLc = name.toLowerCase().trim();
  const exact = candidates.find(
    (c) => c.name.toLowerCase().trim() === nameLc && c.score >= 90,
  );
  if (!exact) {
    if (candidates[0]?.score && candidates[0].score >= 90) {
      console.warn(
        `[MB] rejected fuzzy match for "${name}" → "${candidates[0].name}" (no Spotify anchor + name mismatch)`,
      );
    }
    return null;
  }
  return {
    mbid: exact.id,
    location: {
      country: exact.country,
      area: exact.area?.name,
      beginArea: exact["begin-area"]?.name,
      source: "musicbrainz",
    },
  };
}

// Backwards-compat shim for callers that only need the id.
export async function findArtistId(name: string): Promise<string | null> {
  const match = await findArtist(name);
  return match?.mbid ?? null;
}

export async function getRecentReleases(
  mbid: string,
  monthsBack = 24,
): Promise<Release[]> {
  const data = await mb<{
    "release-groups"?: {
      "first-release-date"?: string;
      "primary-type"?: string;
      title: string;
    }[];
  }>(`/release-group?artist=${mbid}&type=album|single|ep&fmt=json&limit=25`);

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsBack);

  return (data["release-groups"] ?? [])
    .filter((r) => r["first-release-date"])
    .map((r) => ({
      date: r["first-release-date"]!,
      type: r["primary-type"] ?? "Release",
      title: r.title,
    }))
    .filter((r) => new Date(r.date) >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date));
}
