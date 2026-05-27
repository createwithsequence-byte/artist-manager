import type { ArtistReport } from "./types";

/**
 * Ensure a cached ArtistReport has every required array field.
 *
 * Old cached reports in localStorage / Turso may predate fields that became
 * required later (events, releases, signals). Without this, ArtistRow's
 * `report.events.length` etc. throws "Cannot read properties of undefined"
 * and Next.js's global error boundary blanks the page.
 *
 * Run this at every external hydration boundary (Turso fetch, localStorage
 * read). In-app state mutations don't need it — those reports always come
 * from the synthesizer which guarantees full shape.
 */
export function normalizeReport(r: ArtistReport): ArtistReport {
  return {
    ...r,
    signals: r.signals ?? [],
    events: r.events ?? [],
    releases: r.releases ?? [],
    // summary is required-string in type, but be defensive against legacy
    // entries that somehow lost it (we'd rather show empty than crash).
    summary: r.summary ?? "",
    // name is the cache key — if it's missing, the row is unrecoverable.
    // Leave name alone; React will at least render *something* with an
    // empty string and the user can re-run that artist.
  };
}
