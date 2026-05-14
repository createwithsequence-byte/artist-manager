import type { SpotifyInfo } from "./types";

const SIDECAR_BASE = process.env.SPOTIFY_SIDECAR_URL || "http://localhost:5001";

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
