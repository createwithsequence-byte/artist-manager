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

/**
 * Candidate keys for an artist's CUSTOMER dataset, ordered primary-first.
 *
 * The primary is NAME-based (`nm:<name>`) because the name is the one field
 * present on every report no matter how the artist was loaded (CSV scout,
 * library, single-lookup) — so it resolves identically every session. The
 * Spotify-derived keys (`sp:…`) follow as *healing fallbacks*: if a dataset
 * was saved under an older Spotify-keyed id, the panel finds it via these and
 * re-saves under the stable primary, auto-migrating it.
 *
 * This fixes the "customer data keeps disappearing" bug: `artistIdentity`
 * preferred `sp:` and so produced a different key on loads where Spotify
 * didn't resolve, orphaning the saved dataset.
 */
export function customerKeys(r: ArtistReport): string[] {
  const name = (r.name || "").trim().toLowerCase();
  const fromUrl = r.csvSpotifyUrl?.match(/artist[/:]([A-Za-z0-9]{22})/)?.[1];
  const keys: string[] = [];
  if (name) keys.push(`nm:${name}`);
  if (fromUrl) keys.push(`sp:${fromUrl}`);
  if (r.spotify?.id) keys.push(`sp:${r.spotify.id}`);
  if (keys.length === 0) keys.push(artistIdentity(r)); // total fallback
  return [...new Set(keys)];
}
