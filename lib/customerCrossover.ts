import type { Event as ArtistEvent } from "./types";

// State name → 2-letter postal abbreviation. Used to normalize input data so
// "Massachusetts" and "MA" both match the same tour stops.
const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
  "washington dc": "DC",
  "washington d.c.": "DC",
};

const CODE_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_NAME_TO_CODE).map(([name, code]) => [
    code,
    name.replace(/\b\w/g, (c) => c.toUpperCase()),
  ]),
);

export type Customer = {
  name?: string;
  city?: string;
  state?: string;
  songCount?: number;
  // raw row preserved for future enrichment (geocoding etc.)
  raw?: Record<string, string>;
};

export type CustomerCrossover = {
  /** Total parseable customer rows (excludes ones missing state). */
  totalCustomers: number;
  /** Unique states represented in the customer list. */
  uniqueStates: number;
  /** Customer rows dropped because their state couldn't be normalized
   *  (empty, "USA", non-US country, misspelled). Surfaced in UI so the
   *  user knows why their 4006-row CSV shows 3555 customers. */
  droppedCount: number;
  /** Per-tour-stop matches. */
  perEvent: Array<{
    event: ArtistEvent;
    stateCode: string | null;
    sameStateCount: number;
    sameCityCount: number;
    sampleCustomers: Customer[];
  }>;
  /** Top customer states (for "where your audience is" sidebar). */
  topStates: Array<{ stateCode: string; stateName: string; count: number }>;
};

/** Normalize state input to a 2-letter postal code, or null if unrecognized. */
export function normalizeState(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Already a 2-letter code?
  if (/^[A-Z]{2}$/i.test(trimmed)) return trimmed.toUpperCase();
  // Full name?
  const lower = trimmed.toLowerCase();
  return STATE_NAME_TO_CODE[lower] ?? null;
}

function normalizeCity(input: string | undefined): string {
  return (input ?? "").trim().toLowerCase();
}

/**
 * Pull `city` and `state` from an arbitrary CSV row, tolerating common
 * capitalization variants ("City", "CITY", "city_name", "City Name").
 */
function extractCustomer(row: Record<string, string>): Customer {
  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const matchKey = Object.keys(row).find(
        (rk) => rk.toLowerCase() === k.toLowerCase(),
      );
      if (matchKey) return row[matchKey];
    }
    return undefined;
  };
  return {
    name: get("customer_name", "name", "full_name"),
    city: get("city", "city_name"),
    state: get("state", "state_name", "region"),
    songCount: (() => {
      const v = get("song_count", "songs", "count");
      const n = parseInt(v ?? "", 10);
      return Number.isFinite(n) ? n : undefined;
    })(),
    raw: row,
  };
}

/** Parse a raw CSV row list into normalized Customer objects. */
export function parseCustomers(rows: Record<string, string>[]): Customer[] {
  return rows.map(extractCustomer).filter((c) => c.state || c.city);
}

/**
 * Compute the intersection between an artist's upcoming events and a list
 * of customer locations. State-level only (no geocoding yet).
 */
export function crossover(
  customers: Customer[],
  events: ArtistEvent[],
): CustomerCrossover {
  // Pre-normalize customers
  const normalized = customers.map((c) => ({
    ...c,
    _stateCode: normalizeState(c.state),
    _cityKey: normalizeCity(c.city),
  }));

  const withState = normalized.filter((c) => c._stateCode);

  // Aggregate top states
  const stateBuckets = new Map<string, number>();
  for (const c of withState) {
    stateBuckets.set(c._stateCode!, (stateBuckets.get(c._stateCode!) ?? 0) + 1);
  }
  const topStates = [...stateBuckets.entries()]
    .map(([code, count]) => ({
      stateCode: code,
      stateName: CODE_TO_NAME[code] ?? code,
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Per-event analysis
  const perEvent = events.map((event) => {
    // Prefer explicit state when the orchestrator forwarded it (Ticketmaster
    // and Spotify-federated paths both supply state codes natively, post
    // sidecar v1.1 + ticketmaster.ts state-field-emit fixes). Fall back to
    // regex-extracting from the city string for any legacy event payload
    // (older cached reports, edge cases) where city is "Cohasset, MA" but
    // the discrete state field is missing.
    const cityField = event.city ?? "";
    let stateCode: string | null = event.state
      ? normalizeState(event.state)
      : null;
    if (!stateCode) {
      const stateMatch = cityField.match(
        /,\s*([A-Z]{2})\b|,\s*([A-Za-z][A-Za-z\s.]+?)\s*$/,
      );
      if (stateMatch) {
        stateCode = stateMatch[1]
          ? stateMatch[1].toUpperCase()
          : normalizeState(stateMatch[2]);
      }
    }
    // Pull just the city name part for city-match attempts
    const cityPart = cityField.split(",")[0].trim().toLowerCase();

    const sameState = stateCode
      ? withState.filter((c) => c._stateCode === stateCode)
      : [];
    const sameCity = stateCode
      ? sameState.filter((c) => c._cityKey === cityPart)
      : [];

    return {
      event,
      stateCode,
      sameStateCount: sameState.length,
      sameCityCount: sameCity.length,
      sampleCustomers:
        sameCity.slice(0, 5).length > 0
          ? sameCity.slice(0, 5)
          : sameState.slice(0, 5),
    };
  });

  return {
    totalCustomers: normalized.length,
    uniqueStates: stateBuckets.size,
    droppedCount: normalized.length - withState.length,
    perEvent,
    topStates,
  };
}
