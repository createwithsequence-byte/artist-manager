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
  const url = `${SIDECAR_BASE}/artist?${params}`;

  // One fetch attempt. Returns the parsed info, null for a real "not found"
  // (404) or rejected fuzzy match, or the sentinel "retry" for a transient
  // failure (timeout / network / 5xx) that's worth a second, wider attempt.
  const attempt = async (
    timeoutMs: number,
  ): Promise<SpotifyInfo | null | "retry"> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 404) return null;
      if (!res.ok) {
        console.warn(`[SPOTIFY] sidecar ${res.status}`);
        return "retry";
      }
      const data = (await res.json()) as SpotifyInfo;
      // Identity guard: when we looked up by NAME (no spotifyUrl), validate the
      // returned artist's name matches our input. The sidecar's underlying
      // spotapi search is fuzzy and will happily return "Chad & Jeremy" for
      // "Abbey and Chad" or "Tori Kelly" for "Tori". Looking up by spotify_id
      // (csvSpotifyUrl) needs no check — the ID is the canonical anchor.
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
        "[SPOTIFY] sidecar attempt failed:",
        err instanceof Error ? err.message : err,
      );
      return "retry";
    } finally {
      clearTimeout(timer);
    }
  };

  // The sidecar runs on a free tier that spins DOWN when idle and takes ~50s to
  // cold-start — longer than one tight timeout. A single 20s attempt was
  // silently returning null whenever the box was asleep, which dropped Spotify
  // listeners, top cities, AND tour dates from the scout with no error. So:
  // try once fast (warm box → instant); on a transient failure, nudge /health
  // to trigger the spin-up and retry once with a wide window.
  const first = await attempt(25000);
  if (first !== "retry") return first;
  console.warn("[SPOTIFY] sidecar cold — waking via /health, retrying once");
  try {
    await fetch(`${SIDECAR_BASE}/health`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // /health itself may time out mid-spin-up — the retry still gets the
    // wide window, by which point the box is usually up.
  }
  const second = await attempt(60000);
  return second === "retry" ? null : second;
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
