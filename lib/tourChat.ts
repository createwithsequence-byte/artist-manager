import type { CustomerCrossover } from "./customerCrossover";

export type ChatMessage = { role: "user" | "assistant"; content: string };

/** A stop the agent proposes adding to the tour. */
export type ProposedStop = {
  date: string; // YYYY-MM-DD
  city: string;
  state: string; // 2-letter
  reason: string;
};

export type TourChatResult = {
  reply: string;
  proposedStops?: ProposedStop[];
};

/**
 * Compact, LLM-readable snapshot of the current tour + customer intelligence.
 * This is the grounding the agent reasons over: anchored dates (immovable),
 * the gaps between them, on-route fan-dense fill candidates, and the untapped
 * markets the route misses. Kept terse — every line earns its tokens.
 */
export function buildTourContext(
  result: CustomerCrossover,
  artistName: string,
  radiusMiles: number,
): string {
  const stops = [...result.perEvent]
    .filter((e) => e.lat !== undefined)
    .sort((a, b) =>
      a.event.date < b.event.date ? -1 : a.event.date > b.event.date ? 1 : 0,
    );

  const stopLines = stops
    .map(
      (s) =>
        `  ${s.event.date} · ${s.event.city}, ${s.stateCode ?? "?"} · ${s.withinRadiusCount} fans ≤${radiusMiles}mi${
          s.event.venue === "PROVISIONAL" ? " (PROPOSED, not yet booked)" : ""
        }`,
    )
    .join("\n");

  const legLines = result.legs
    .map((l) => {
      const dark = l.gapDays >= 3 ? " — DARK GAP (fillable)" : "";
      const fly =
        l.segmentMiles > 600 && l.gapDays <= 1 ? " [needs flight]" : "";
      return `  ${l.fromCity}→${l.toCity}: ${l.segmentMiles}mi over ${l.gapDays} day(s)${dark}${fly}`;
    })
    .join("\n");

  const candidateLines = result.legs
    .filter((l) => l.suggestions.length > 0)
    .map((l) => {
      const cands = l.suggestions
        .map(
          (s) =>
            `${s.city},${s.stateCode} (${s.customers} fans, +${s.detourMiles}mi, ~${s.suggestedDate})`,
        )
        .join("; ");
      return `  ${l.gapDays}-day gap ${l.fromCity}→${l.toCity}: ${cands}`;
    })
    .join("\n");

  const untappedLine = result.untappedMarkets
    .map((m) => `${m.city},${m.stateCode} (${m.customers})`)
    .join("; ");

  return [
    `ARTIST: ${artistName}`,
    `RADIUS: ${radiusMiles} mi — a customer within this distance of a stop is "reached".`,
    `CURRENT REACH: ${result.reachedCustomers}/${result.totalCustomers} customers (${Math.round(
      result.reachPct * 100,
    )}%) · total route ${result.totalRouteMiles.toLocaleString()} mi · longest gap ${result.longestGapDays} days`,
    ``,
    `ANCHORED DATES (booked — never move or remove these):`,
    stopLines || "  (none geocoded)",
    ``,
    `LEGS (gaps between consecutive dates):`,
    legLines || "  (single date — no legs)",
    ``,
    `ON-ROUTE FILL CANDIDATES (fan-dense cities that fit each gap, by detour):`,
    candidateLines || "  (none within the current radius corridor)",
    ``,
    `TOP UNTAPPED MARKETS (dense fan cities the route never reaches):`,
    `  ${untappedLine || "(none)"}`,
  ].join("\n");
}
