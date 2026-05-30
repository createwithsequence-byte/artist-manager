import type { ArtistReport } from "./types";

/**
 * Canonical identity for an artist, independent of which CSV they came from.
 * Spotify URL (from the CSV) is most authoritative, then the resolved
 * spotify.id, then a normalized name as last resort.
 *
 * Pure — no DB imports — so it's safe to use in client components (e.g. to
 * key a per-artist customer dataset) as well as on the server (lib/library).
 */
export function artistIdentity(r: ArtistReport): string {
  const fromUrl = r.csvSpotifyUrl?.match(/artist[/:]([A-Za-z0-9]{22})/)?.[1];
  if (fromUrl) return `sp:${fromUrl}`;
  if (r.spotify?.id) return `sp:${r.spotify.id}`;
  return `nm:${(r.name || "").trim().toLowerCase()}`;
}
