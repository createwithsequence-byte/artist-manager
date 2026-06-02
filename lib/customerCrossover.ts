import type { Event as ArtistEvent } from "./types";
import { US_CITY_TO_STATE } from "./usCityToState";

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

export type LatLng = readonly [number, number];
/** "<lowercased city>|<STATE_CODE>" → [lat, lng]. Supplied by the dynamically
 *  imported usCityToLatLng bundle so the 1MB dataset only loads on demand. */
export type GeocodeMap = Readonly<Record<string, LatLng>>;

export type Customer = {
  name?: string;
  city?: string;
  state?: string;
  songCount?: number;
  // raw row preserved for future enrichment (geocoding etc.)
  raw?: Record<string, string>;
};

/** A suggested net-new tour stop that sits roughly on-route between two
 *  existing dates and has dense customer coverage. */
export type RoutingSuggestion = {
  city: string;
  stateCode: string;
  customers: number;
  /** Extra miles vs. driving the two existing stops back-to-back. */
  detourMiles: number;
  /** Straight-line miles of the leg this fills (its A→B distance). */
  segmentMiles: number;
  gapDays: number;
  fromCity: string;
  fromDate: string;
  toCity: string;
  toDate: string;
  /** A reasonable date to slot the show — midpoint of the gap. */
  suggestedDate: string;
  lat: number;
  lng: number;
};

/** One leg of the route: the connector between two consecutive dated stops.
 *  First-class so the UI can render the journey chronologically with each
 *  gap (idle days) + drive (miles) as a clickable object between shows. */
export type Leg = {
  fromCity: string;
  fromDate: string;
  toCity: string;
  toDate: string;
  /** Straight-line miles between the two stops (great-circle). */
  segmentMiles: number;
  /** Idle days between the two dates. */
  gapDays: number;
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  /** Fan-dense cities on this corridor worth slotting into the gap. */
  suggestions: RoutingSuggestion[];
};

export type CustomerCrossover = {
  /** Total parseable customer rows, incl. rows whose state couldn't be
   *  resolved (those sit in the denominator but can never be "reached"; see
   *  droppedCount). reachPct uses this same denominator. */
  totalCustomers: number;
  /** Unique states represented in the customer list. */
  uniqueStates: number;
  /** Customer rows dropped because their state couldn't be normalized. */
  droppedCount: number;
  /** Radius (miles) used for "within range" counts + corridor width. */
  radiusMiles: number;
  /** Whether lat/lng geocoding was available (false → state-level only). */
  geocoded: boolean;
  /** Unique customers within `radiusMiles` of ANY tour stop. */
  reachedCustomers: number;
  /** reachedCustomers / totalCustomers, 0–1. */
  reachPct: number;
  /** Per-tour-stop matches. */
  perEvent: Array<{
    event: ArtistEvent;
    stateCode: string | null;
    sameStateCount: number;
    sameCityCount: number;
    /** Customers within `radiusMiles` of this stop (0 if stop not geocoded). */
    withinRadiusCount: number;
    sampleCustomers: Customer[];
    /** Within-radius customers grouped by their city — the venue's own city
     *  first (isSameCity), then secondary cities the radius pulls in. Each
     *  carries actual customer names for outreach. */
    nearby: Array<{
      city: string;
      stateCode: string;
      count: number;
      isSameCity: boolean;
      names: string[];
      /** Every within-radius customer's email (uncapped, deduped at use site)
       *  for BCC outreach. Empty when the dataset has no email column. */
      emails: string[];
    }>;
    lat?: number;
    lng?: number;
  }>;
  /** Top customer states (for "where your audience is" sidebar). */
  topStates: Array<{ stateCode: string; stateName: string; count: number }>;
  /** Suggested net-new stops to add between existing dates. */
  routingSuggestions: RoutingSuggestion[];
  /** The route as ordered legs between consecutive dated stops (chronological).
   *  Drives the timeline "routing sheet" view. */
  legs: Leg[];
  /** Sum of all leg straight-line miles. */
  totalRouteMiles: number;
  /** Largest idle gap (days) anywhere on the route. */
  longestGapDays: number;
  /** Customer cities NOT reached by the current tour, ranked — "tour next." */
  untappedMarkets: Array<{
    city: string;
    stateCode: string;
    customers: number;
    lat: number;
    lng: number;
  }>;
  /** Pre-shaped data for the Leaflet map. */
  mapData: {
    customerPoints: Array<{ lat: number; lng: number; weight: number }>;
    stops: Array<{
      lat: number;
      lng: number;
      city: string;
      date: string;
      venue: string;
    }>;
    suggestions: Array<{
      lat: number;
      lng: number;
      city: string;
      customers: number;
    }>;
  };
};

/** Normalize state input to a 2-letter postal code, or null if unrecognized. */
export function normalizeState(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (/^[A-Z]{2}$/i.test(trimmed)) return trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();
  return STATE_NAME_TO_CODE[lower] ?? null;
}

export function normalizeCity(input: string | undefined): string {
  return (input ?? "").trim().toLowerCase();
}

/** Per-city customer aggregate — the shape the globe and flat map consume.
 *  Pre-bucketed at upload time so the render path is zero-cost on load. */
export type CityAggregate = {
  city: string;
  stateCode: string;
  lat: number;
  lng: number;
  count: number;
};

/** World-cities lookup (non-US), keyed by `city|province` and `city|iso2`.
 *  Optional second geocoder for aggregateByCity so international fans plot. */
export type WorldGeocode = {
  admin: Readonly<Record<string, readonly [number, number]>>;
  country: Readonly<Record<string, readonly [number, number]>>;
};

// Strip accents so "Montréal" (customer) matches "montreal" (world key).
const stripAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

// Non-US province/state CODE → GeoNames admin NAME (lowercased), so a customer
// who wrote "ON" or "NSW" still resolves. Ambiguous codes that collide with US
// state codes (e.g. WA = Washington) are omitted — they fall through to the
// US path or the name form instead.
const PROVINCE_CODE_TO_NAME: Record<string, string> = {
  // Canada
  ON: "ontario",
  QC: "quebec",
  BC: "british columbia",
  AB: "alberta",
  MB: "manitoba",
  SK: "saskatchewan",
  NS: "nova scotia",
  NB: "new brunswick",
  NL: "newfoundland and labrador",
  PE: "prince edward island",
  NT: "northwest territories",
  YT: "yukon",
  NU: "nunavut",
  // Australia (unambiguous codes only)
  NSW: "new south wales",
  VIC: "victoria",
  QLD: "queensland",
  SA: "south australia",
  TAS: "tasmania",
  ACT: "australian capital territory",
};
const PROVINCE_NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(PROVINCE_CODE_TO_NAME).map(([code, name]) => [name, code]),
);
// Common country NAME → iso2, for customers whose "state" is a country.
const COUNTRY_NAME_TO_ISO: Record<string, string> = {
  canada: "CA",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  australia: "AU",
  germany: "DE",
  france: "FR",
  ireland: "IE",
  "new zealand": "NZ",
  netherlands: "NL",
  mexico: "MX",
  spain: "ES",
  italy: "IT",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  brazil: "BR",
  japan: "JP",
  india: "IN",
  "south africa": "ZA",
  philippines: "PH",
  switzerland: "CH",
  austria: "AT",
  belgium: "BE",
  poland: "PL",
  portugal: "PT",
  singapore: "SG",
};

function bump(
  buckets: Map<string, CityAggregate>,
  key: string,
  city: string,
  stateCode: string,
  coords: readonly [number, number],
): void {
  const ex = buckets.get(key);
  if (ex) ex.count++;
  else
    buckets.set(key, {
      city,
      stateCode,
      lat: coords[0],
      lng: coords[1],
      count: 1,
    });
}

/**
 * Roll up a customer list into one row per geocoded city. Tries the precise
 * US lookup first; if a `world` geocoder is supplied, non-US fans then resolve
 * via their province name/code (Ontario/ON, NSW…) or country. Rows that match
 * nowhere are dropped (the globe can't place what it can't geocode). Sorted by
 * count desc so the heaviest cities draw on top.
 */
export function aggregateByCity(
  customers: Customer[],
  geocode: GeocodeMap,
  world?: WorldGeocode,
): { aggregate: CityAggregate[]; dropped: number } {
  const buckets = new Map<string, CityAggregate>();
  let dropped = 0;
  for (const c of customers) {
    const cityKey = normalizeCity(c.city);
    if (!cityKey) {
      dropped++;
      continue;
    }

    // 1) US path — precise, via the bundled US lookup.
    const usState = normalizeState(c.state);
    if (usState) {
      const us = geocode[`${cityKey}|${usState}`];
      if (us) {
        bump(buckets, `${cityKey}|${usState}`, c.city ?? cityKey, usState, us);
        continue;
      }
    }

    // 2) World path — non-US, via province name/code, then country.
    if (world && c.state) {
      const cityAscii = stripAccents(cityKey);
      const raw = c.state.trim();
      const codeUp = raw.toUpperCase();
      const sNorm = stripAccents(raw.toLowerCase());
      const adminName = PROVINCE_CODE_TO_NAME[codeUp] ?? sNorm;
      let coords = world.admin[`${cityAscii}|${adminName}`];
      let region = adminName;
      if (!coords) {
        const iso =
          COUNTRY_NAME_TO_ISO[sNorm] ??
          (/^[A-Za-z]{2}$/.test(raw) ? codeUp : "");
        if (iso) {
          coords = world.country[`${cityAscii}|${iso.toLowerCase()}`];
          region = iso.toLowerCase();
        }
      }
      if (coords) {
        const display =
          PROVINCE_NAME_TO_CODE[region] ?? region.toUpperCase().slice(0, 3);
        bump(
          buckets,
          `${cityAscii}|${region}`,
          c.city ?? cityKey,
          display,
          coords,
        );
        continue;
      }
    }

    dropped++;
  }
  const aggregate = [...buckets.values()].sort((a, b) => b.count - a.count);
  return { aggregate, dropped };
}

/** Great-circle distance in miles between two [lat,lng] points. */
function haversineMiles(a: LatLng, b: LatLng): number {
  const R = 3958.8; // Earth radius, miles
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLng = (b[1] - a[1]) * toRad;
  const la1 = a[0] * toRad;
  const la2 = b[0] * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whole days between two YYYY-MM-DD strings (absolute). */
function dayGap(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  return Math.round(Math.abs(db - da) / 86_400_000);
}

/** Midpoint date (YYYY-MM-DD) between two dates. */
function midDate(a: string, b: string): string {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return a;
  return new Date((da + db) / 2).toISOString().slice(0, 10);
}

/**
 * Resolve a tour event to a 2-letter state code using three tiers of
 * confidence: explicit event.state → regex from "City, ST" → bundled
 * city→state lookup for bare Spotify-federated city strings.
 */
function resolveEventState(event: ArtistEvent): string | null {
  const cityField = event.city ?? "";
  let stateCode: string | null = event.state
    ? normalizeState(event.state)
    : null;
  if (!stateCode) {
    const m = cityField.match(
      /,\s*([A-Z]{2})\b|,\s*([A-Za-z][A-Za-z\s.]+?)\s*$/,
    );
    if (m) stateCode = m[1] ? m[1].toUpperCase() : normalizeState(m[2]);
  }
  if (!stateCode) {
    const bare = cityField.split(",")[0].trim().toLowerCase();
    const looked = US_CITY_TO_STATE[bare];
    if (looked) stateCode = looked;
  }
  return stateCode;
}

const MIN_GAP_DAYS = 3; // need at least this long a gap to slot a show
const MIN_SUGGESTION_CUSTOMERS = 3; // ignore trivially-small markets
const MAX_SUGGESTIONS_PER_GAP = 3;

/**
 * Compute the intersection between an artist's upcoming events and a list of
 * customer locations. State-level always; when a `geocode` map is supplied it
 * additionally computes radius reach, between-stop routing suggestions, and
 * map data — all client-side via haversine, no external API.
 */
export function crossover(
  customers: Customer[],
  events: ArtistEvent[],
  opts: { radiusMiles?: number; geocode?: GeocodeMap } = {},
): CustomerCrossover {
  const radiusMiles = opts.radiusMiles ?? 60;
  const geocode = opts.geocode;
  const geocoded = !!geocode;

  // Pre-normalize + geocode customers.
  const normalized = customers.map((c) => {
    const stateCode = normalizeState(c.state);
    const cityKey = normalizeCity(c.city);
    let coords: LatLng | undefined;
    if (geocode && stateCode && cityKey) {
      coords = geocode[`${cityKey}|${stateCode}`];
    }
    return { ...c, _stateCode: stateCode, _cityKey: cityKey, _coords: coords };
  });
  const withState = normalized.filter((c) => c._stateCode);

  // Top customer states.
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

  // Aggregate customers by geocoded city for routing/untapped/heatmap.
  type CityAgg = {
    city: string;
    stateCode: string;
    count: number;
    coords: LatLng;
  };
  const cityAggMap = new Map<string, CityAgg>();
  for (const c of normalized) {
    if (!c._coords || !c._stateCode || !c._cityKey) continue;
    const key = `${c._cityKey}|${c._stateCode}`;
    const existing = cityAggMap.get(key);
    if (existing) existing.count += 1;
    else
      cityAggMap.set(key, {
        city: c.city ?? c._cityKey,
        stateCode: c._stateCode,
        count: 1,
        coords: c._coords,
      });
  }
  const cityAggs = [...cityAggMap.values()];

  // Geocode events + per-event analysis.
  const eventsGeo = events.map((event) => {
    const stateCode = resolveEventState(event);
    const bareCity = (event.city ?? "").split(",")[0].trim().toLowerCase();
    let coords: LatLng | undefined;
    if (geocode && stateCode && bareCity) {
      coords = geocode[`${bareCity}|${stateCode}`];
    }
    return { event, stateCode, bareCity, coords };
  });

  // Track which customers are reached (within radius of any geocoded stop).
  const reachedIdx = new Set<number>();

  const perEvent = eventsGeo.map(({ event, stateCode, bareCity, coords }) => {
    const sameState = stateCode
      ? withState.filter((c) => c._stateCode === stateCode)
      : [];
    const sameCity = stateCode
      ? sameState.filter((c) => c._cityKey === bareCity)
      : [];

    let withinRadiusCount = 0;
    const nearbyMap = new Map<
      string,
      {
        city: string;
        stateCode: string;
        count: number;
        isSameCity: boolean;
        names: string[];
        emails: string[];
      }
    >();
    if (coords) {
      normalized.forEach((c, idx) => {
        if (!c._coords) return;
        if (haversineMiles(coords, c._coords) <= radiusMiles) {
          withinRadiusCount += 1;
          reachedIdx.add(idx);
          // Bucket this within-radius customer by their city, keeping names.
          const ckey = `${c._cityKey}|${c._stateCode}`;
          let b = nearbyMap.get(ckey);
          if (!b) {
            b = {
              city: c.city ?? c._cityKey ?? "?",
              stateCode: c._stateCode ?? stateCode ?? "?",
              count: 0,
              isSameCity: c._cityKey === bareCity && c._stateCode === stateCode,
              names: [],
              emails: [],
            };
            nearbyMap.set(ckey, b);
          }
          b.count += 1;
          if (c.name && b.names.length < 12) b.names.push(c.name);
          // Uncapped — a BCC list must reach every fan, not just the 12 shown.
          const em = customerEmail(c);
          if (em) b.emails.push(em);
        }
      });
    }
    // Same-city first, then densest secondary cities.
    const nearby = [...nearbyMap.values()].sort((a, b) =>
      a.isSameCity !== b.isSameCity
        ? a.isSameCity
          ? -1
          : 1
        : b.count - a.count,
    );

    return {
      event,
      stateCode,
      sameStateCount: sameState.length,
      sameCityCount: sameCity.length,
      withinRadiusCount,
      sampleCustomers:
        sameCity.slice(0, 5).length > 0
          ? sameCity.slice(0, 5)
          : sameState.slice(0, 5),
      nearby,
      lat: coords?.[0],
      lng: coords?.[1],
    };
  });

  const reachedCustomers = reachedIdx.size;
  const reachPct =
    normalized.length > 0 ? reachedCustomers / normalized.length : 0;

  // ---- Routing engine: insertion-cost detour between consecutive stops ----
  const datedStops = eventsGeo
    .filter((e) => e.coords && e.event.date)
    .sort((a, b) => (a.event.date < b.event.date ? -1 : 1));

  const maxDetour = radiusMiles * 2; // city within ~radius of the A→B line
  const routingSuggestions: RoutingSuggestion[] = [];
  const suggestedCityKeys = new Set<string>();
  const legs: Leg[] = [];

  for (let i = 0; i < datedStops.length - 1; i++) {
    const A = datedStops[i];
    const B = datedStops[i + 1];
    const gap = dayGap(A.event.date, B.event.date);
    const directMiles = haversineMiles(A.coords!, B.coords!);

    // Only search for fill candidates when the gap is bookable. Short legs
    // still get a Leg object (so the spine renders the whole journey) — they
    // just carry no suggestions.
    const legSuggestions: RoutingSuggestion[] = [];
    if (gap >= MIN_GAP_DAYS) {
      const candidates = cityAggs
        .map((agg) => {
          const detour =
            haversineMiles(A.coords!, agg.coords) +
            haversineMiles(agg.coords, B.coords!) -
            directMiles;
          return { agg, detour };
        })
        .filter(
          ({ agg, detour }) =>
            detour <= maxDetour &&
            agg.count >= MIN_SUGGESTION_CUSTOMERS &&
            // Skip cities already served by an existing stop this gap touches.
            haversineMiles(A.coords!, agg.coords) > radiusMiles &&
            haversineMiles(B.coords!, agg.coords) > radiusMiles,
        )
        // Rank: most customers per unit of detour (artist-beneficial stop).
        .sort(
          (x, y) => y.agg.count / (1 + y.detour) - x.agg.count / (1 + x.detour),
        )
        .slice(0, MAX_SUGGESTIONS_PER_GAP);

      for (const { agg, detour } of candidates) {
        const key = `${agg.city.toLowerCase()}|${agg.stateCode}`;
        if (suggestedCityKeys.has(key)) continue; // dedupe across gaps
        suggestedCityKeys.add(key);
        const sug: RoutingSuggestion = {
          city: agg.city,
          stateCode: agg.stateCode,
          customers: agg.count,
          detourMiles: Math.round(detour),
          segmentMiles: Math.round(directMiles),
          gapDays: gap,
          fromCity: A.event.city ?? "?",
          fromDate: A.event.date,
          toCity: B.event.city ?? "?",
          toDate: B.event.date,
          suggestedDate: midDate(A.event.date, B.event.date),
          lat: agg.coords[0],
          lng: agg.coords[1],
        };
        legSuggestions.push(sug);
        routingSuggestions.push(sug);
      }
      // Stagger fill dates across the gap so accepting 2-3 fills from one leg
      // (manual ⊕ path) doesn't create same-day shows in different cities.
      legSuggestions.forEach((s, i) => {
        s.suggestedDate = dateAtFraction(
          A.event.date,
          B.event.date,
          (i + 1) / (legSuggestions.length + 1),
        );
      });
    }

    legs.push({
      fromCity: A.event.city ?? "?",
      fromDate: A.event.date,
      toCity: B.event.city ?? "?",
      toDate: B.event.date,
      segmentMiles: Math.round(directMiles),
      gapDays: gap,
      fromLat: A.coords![0],
      fromLng: A.coords![1],
      toLat: B.coords![0],
      toLng: B.coords![1],
      suggestions: legSuggestions,
    });
  }

  const totalRouteMiles = legs.reduce((s, l) => s + l.segmentMiles, 0);
  const longestGapDays = legs.reduce((m, l) => Math.max(m, l.gapDays), 0);

  // ---- Untapped markets: dense customer cities NOT within radius of a stop --
  const stopCoords = eventsGeo
    .map((e) => e.coords)
    .filter((c): c is LatLng => !!c);
  const untappedMarkets = cityAggs
    .filter(
      (agg) =>
        !stopCoords.some((sc) => haversineMiles(sc, agg.coords) <= radiusMiles),
    )
    .sort((a, b) => b.count - a.count)
    // 50 (was 10) so the tour agent + TOUR HERE have a deep enough candidate
    // pool to build long, geographically-varied runs without looping a few
    // cities. The UI shelf slices this down for display.
    .slice(0, 50)
    .map((agg) => ({
      city: agg.city,
      stateCode: agg.stateCode,
      customers: agg.count,
      lat: agg.coords[0],
      lng: agg.coords[1],
    }));

  return {
    totalCustomers: normalized.length,
    uniqueStates: stateBuckets.size,
    droppedCount: normalized.length - withState.length,
    radiusMiles,
    geocoded,
    reachedCustomers,
    reachPct,
    perEvent,
    topStates,
    routingSuggestions,
    legs,
    totalRouteMiles,
    longestGapDays,
    untappedMarkets,
    mapData: {
      customerPoints: cityAggs.map((a) => ({
        lat: a.coords[0],
        lng: a.coords[1],
        weight: a.count,
      })),
      // Date-ordered (datedStops is already sorted) so the map's route line
      // + numbered pins read as a chronological journey, matching the spine.
      stops: datedStops.map((e) => ({
        lat: e.coords![0],
        lng: e.coords![1],
        city: e.event.city ?? "?",
        date: e.event.date,
        venue: e.event.venue ?? "Venue TBD",
      })),
      suggestions: routingSuggestions.map((s) => ({
        lat: s.lat,
        lng: s.lng,
        city: s.city,
        customers: s.customers,
      })),
    },
  };
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Pull a plausible email from a customer's raw CSV row. Prefers a column whose
 * header mentions email ("email", "Email", "email_address", "e-mail"); falls
 * back to the first value that itself looks like an address — some exports
 * label the column oddly or omit a header. Returns lowercased, or undefined
 * when the row carries no email (so callers can simply skip it).
 */
export function customerEmail(c: Customer): string | undefined {
  const raw = c.raw;
  if (!raw) return undefined;
  for (const k of Object.keys(raw)) {
    if (/e-?mail/i.test(k)) {
      const v = (raw[k] ?? "").trim();
      if (EMAIL_RE.test(v)) return v.toLowerCase();
    }
  }
  for (const k of Object.keys(raw)) {
    const v = (raw[k] ?? "").trim();
    if (EMAIL_RE.test(v)) return v.toLowerCase();
  }
  return undefined;
}

/** Parse a raw CSV row list into normalized Customer objects. */
export function parseCustomers(rows: Record<string, string>[]): Customer[] {
  return rows.map(extractCustomer).filter((c) => c.state || c.city);
}

/** A date `frac` of the way from `from` to `to` (both YYYY-MM-DD). */
function dateAtFraction(from: string, to: string, frac: number): string {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return from;
  return new Date(a + (b - a) * frac).toISOString().slice(0, 10);
}

/**
 * Build a "revised tour": given a BASELINE crossover (anchored dates only),
 * auto-fill every bookable gap with the best customer-maximizing on-route
 * cities, spacing their suggested dates across the idle window. Returns
 * provisional stops to insert; caller re-runs crossover on [anchors, ...these].
 *
 * Pass the baseline (anchors-only) result — NOT a result that already has
 * provisional stops, or the legs will have rerouted through them.
 *
 * Stops per gap scale with its length (≈1 per 10 idle days, capped at 3) and
 * are the engine's already-ranked, on-route, deduped suggestions — so the
 * revised tour honors the current mileage/radius setting automatically.
 */
export function buildRevisedTour(baseline: CustomerCrossover): ArtistEvent[] {
  const out: ArtistEvent[] = [];
  const usedKeys = new Set<string>();
  for (const leg of baseline.legs) {
    if (leg.suggestions.length === 0) continue;
    const maxStops = Math.min(3, Math.max(1, Math.floor(leg.gapDays / 10)));
    const picked: RoutingSuggestion[] = [];
    for (const s of leg.suggestions) {
      if (picked.length >= maxStops) break;
      const k = `${s.city.toLowerCase()}|${s.stateCode}`;
      if (usedKeys.has(k)) continue;
      usedKeys.add(k);
      picked.push(s);
    }
    picked.forEach((s, i) => {
      const frac = (i + 1) / (picked.length + 1);
      out.push({
        date: dateAtFraction(leg.fromDate, leg.toDate, frac),
        city: s.city,
        state: s.stateCode,
        venue: "PROVISIONAL",
      } as ArtistEvent);
    });
  }
  return out;
}

// ───────────────────────────── TOUR HERE engine ──────────────────────────────
// Future-tour proposal: route the artist through their densest UNTAPPED markets
// from scratch, independent of any booked dates. Three strategies, same shape
// out so the panel's spine/map pipeline consumes them identically.

export type RoutingStyle = "geographic" | "density" | "corridor";

export type ProposeFutureTourOptions = {
  count: number;
  startDate: string; // YYYY-MM-DD
  spacingDays: number;
  style?: RoutingStyle;
  /** Pre-seed an existing untapped pool, e.g. from a current crossover. */
  untapped: Array<{
    city: string;
    stateCode: string;
    customers: number;
    lat: number;
    lng: number;
  }>;
  /** Optional axis for "corridor" — start from this lat/lng region. */
  corridorAnchor?: LatLng;
};

/** Add N days to a YYYY-MM-DD date, returning YYYY-MM-DD. */
function addDays(date: string, days: number): string {
  const t = new Date(`${date}T12:00:00`).getTime();
  if (Number.isNaN(t)) return date;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Propose a from-scratch tour through the fanbase.
 *
 * "geographic" (default): greedy nearest-neighbor through the top untapped
 * markets — drivable, the way a booking agent would route. Starts at the
 * densest market (or corridorAnchor's nearest), chains to closest next.
 *
 * "density": pure top-N by customer count, no routing — for fly-only artists
 * anchoring marquee cities. Dates only.
 *
 * "corridor": greedy from a starting region, but only adding cities whose
 * distance from the anchor stays under a soft cap (default 800mi) — keeps
 * the run on one geographic axis (e.g. Southeast, West Coast).
 */
export function proposeFutureTour(
  opts: ProposeFutureTourOptions,
): ArtistEvent[] {
  const style: RoutingStyle = opts.style ?? "geographic";
  const requested = Math.max(1, Math.floor(opts.count));
  const candidates = [...opts.untapped];
  if (candidates.length === 0) return [];

  let ordered: typeof candidates;

  if (style === "density") {
    ordered = candidates
      .sort((a, b) => b.customers - a.customers)
      .slice(0, requested);
  } else {
    // Greedy nearest-neighbor for both "geographic" and "corridor".
    // Start = densest city (or, for corridor, the candidate nearest the anchor).
    const used = new Set<number>();
    const out: typeof candidates = [];
    let startIdx = 0;
    if (style === "corridor" && opts.corridorAnchor) {
      let bestD = Infinity;
      candidates.forEach((c, i) => {
        const d = haversineMiles(opts.corridorAnchor as LatLng, [c.lat, c.lng]);
        if (d < bestD) {
          bestD = d;
          startIdx = i;
        }
      });
    } else {
      // "geographic": start at densest
      let bestPop = -1;
      candidates.forEach((c, i) => {
        if (c.customers > bestPop) {
          bestPop = c.customers;
          startIdx = i;
        }
      });
    }
    used.add(startIdx);
    out.push(candidates[startIdx]);
    const cap = 800; // corridor soft cap, miles from anchor
    const anchor: LatLng | undefined =
      style === "corridor"
        ? (opts.corridorAnchor ?? [
            candidates[startIdx].lat,
            candidates[startIdx].lng,
          ])
        : undefined;
    while (out.length < requested) {
      const cur = out[out.length - 1];
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        if (used.has(i)) continue;
        if (anchor) {
          const da = haversineMiles(anchor, [
            candidates[i].lat,
            candidates[i].lng,
          ]);
          if (da > cap) continue;
        }
        const d = haversineMiles(
          [cur.lat, cur.lng],
          [candidates[i].lat, candidates[i].lng],
        );
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0) break;
      used.add(best);
      out.push(candidates[best]);
    }
    ordered = out;
  }

  return ordered.map((c, i) => ({
    date: addDays(opts.startDate, i * opts.spacingDays),
    city: c.city,
    state: c.stateCode,
    venue: "PROVISIONAL",
  })) as ArtistEvent[];
}
