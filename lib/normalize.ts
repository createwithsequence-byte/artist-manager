import type { ArtistReport, DeepDive } from "./types";

/**
 * Ensure a cached ArtistReport has every required array/string field.
 *
 * Old cached reports in localStorage / Turso may predate fields that became
 * required later (events, releases, signals, deepDive sub-fields). Without
 * this, ArtistRow's `report.events.length` / `dive.facts.map` etc. throws
 * "Cannot read properties of undefined" and Next.js's global error boundary
 * blanks the page.
 *
 * Run this at every external hydration boundary (Turso fetch, localStorage
 * read, AND the streaming /api/scout consumer in app/page.tsx) — in-app
 * state mutations don't need it.
 */
export function normalizeReport(r: ArtistReport): ArtistReport {
  return {
    ...r,
    signals: r.signals ?? [],
    events: r.events ?? [],
    releases: r.releases ?? [],
    summary: r.summary ?? "",
    deepDive: r.deepDive ? normalizeDeepDive(r.deepDive) : undefined,
  };
}

/**
 * Defensive normalize for DeepDive — runs whenever a cached report is loaded.
 * Older reports may have a deepDive missing facts/sourcesChecked arrays or
 * with an undefined context string; this prevents ArtistRow's expanded
 * deep-dive panel from crashing during render.
 */
function normalizeDeepDive(dive: DeepDive): DeepDive {
  return {
    ...dive,
    artist: dive.artist ?? "",
    context: dive.context ?? "",
    facts: dive.facts ?? [],
    sourcesChecked: dive.sourcesChecked ?? [],
    sourcesRejected: dive.sourcesRejected ?? [],
    generatedAt: dive.generatedAt ?? new Date(0).toISOString(),
  };
}
