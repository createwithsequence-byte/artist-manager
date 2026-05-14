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
};

export type ArtistMatch = {
  mbid: string;
  location: ArtistLocation;
};

export async function findArtist(name: string): Promise<ArtistMatch | null> {
  const q = encodeURIComponent(`artist:"${name}"`);
  const data = await mb<{ artists?: SearchArtist[] }>(
    `/artist/?query=${q}&fmt=json&limit=3`,
  );
  const top = data.artists?.[0];
  if (!top || top.score < 90) return null;
  return {
    mbid: top.id,
    location: {
      country: top.country,
      area: top.area?.name,
      beginArea: top["begin-area"]?.name,
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
