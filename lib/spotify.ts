import type { SpotifyInfo } from "./types";

const SIDECAR_BASE = process.env.SPOTIFY_SIDECAR_URL || "http://localhost:5001";

/** Loose case-insensitive name compare for sidecar match validation. */
function namesMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // Allow substring match if one fully contains the other (e.g., "Tori" vs "Tori Kelly"
  // would REJECT here, but "Jesse Labelle" vs "Jesse LaBelle" passes after normalization).
  // Substring is dangerous so we cap it: only accept if the shorter string is at least 6 chars
  // AND >= 60% of the longer string's length — kills "Tori" matching anything longer.
  const [short, long] = na.length < nb.length ? [na, nb] : [nb, na];
  if (short.length < 6) return false;
  if (long.includes(short) && short.length / long.length >= 0.6) return true;
  return false;
}

export async function getSpotifyInfo(args: {
  name?: string;
  spotifyUrl?: string;
}): Promise<SpotifyInfo | null> {
  const params = new URLSearchParams();
  if (args.spotifyUrl) params.set("spotify_id", args.spotifyUrl);
  else if (args.name) params.set("name", args.name);
  else return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(`${SIDECAR_BASE}/artist?${params}`, {
      signal: controller.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[SPOTIFY] sidecar ${res.status}`);
      return null;
    }
    const data = (await res.json()) as SpotifyInfo;

    // Identity guard: when we looked up by NAME (no spotifyUrl), validate the
    // returned artist's name matches our input. The sidecar's underlying
    // spotapi search is fuzzy and will happily return "Chad & Jeremy" for
    // "Abbey and Chad" or "Tori Kelly" for "Tori" — the same identity
    // poisoning we already locked down at MusicBrainz + Ticketmaster. When
    // we looked up by spotify_id (csvSpotifyUrl provided), no need to check
    // — the ID is the canonical anchor.
    if (!args.spotifyUrl && args.name && data?.name) {
      if (!namesMatch(args.name, data.name)) {
        console.warn(
          `[SPOTIFY] rejected fuzzy match for "${args.name}" → "${data.name}" (no Spotify-URL anchor in CSV)`,
        );
        return null;
      }
    }

    return data;
  } catch (err) {
    console.warn(
      "[SPOTIFY] sidecar unreachable:",
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function isSidecarReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${SIDECAR_BASE}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}
