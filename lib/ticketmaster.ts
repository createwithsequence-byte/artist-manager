import type { Event as ArtistEvent } from "./types";
import { createRateLimiter } from "./rate-limit";

const BASE = "https://app.ticketmaster.com/discovery/v2";

// Free tier: 5 req/sec, 5,000/day. Pace at 2/sec for headroom.
const waitForSlot = createRateLimiter(2, 1000);

type TMAttractionSearch = {
  _embedded?: {
    attractions?: Array<{
      id: string;
      name: string;
      type: string;
    }>;
  };
};

type TMEventsResponse = {
  _embedded?: {
    events?: Array<{
      name?: string;
      url?: string;
      dates?: {
        start?: { localDate?: string; localTime?: string };
      };
      _embedded?: {
        venues?: Array<{
          name?: string;
          city?: { name?: string };
          state?: { stateCode?: string; name?: string };
          country?: { countryCode?: string };
          location?: { latitude?: string; longitude?: string };
        }>;
        attractions?: Array<{ name?: string; id?: string }>;
      };
    }>;
  };
};

async function tm<T>(path: string): Promise<T | null> {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) return null;
  await waitForSlot();
  const sep = path.includes("?") ? "&" : "?";
  try {
    const res = await fetch(`${BASE}${path}${sep}apikey=${key}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 429) {
      // Rate limited — back off briefly and retry once
      await new Promise((r) => setTimeout(r, 1500));
      await waitForSlot();
      const retry = await fetch(`${BASE}${path}${sep}apikey=${key}`, {
        signal: AbortSignal.timeout(12000),
      });
      if (!retry.ok) {
        console.warn(`[TICKETMASTER] retry after 429 → HTTP ${retry.status}`);
        return null;
      }
      try {
        return (await retry.json()) as T;
      } catch (parseErr) {
        console.warn(
          "[TICKETMASTER] retry response parse failed:",
          parseErr instanceof Error ? parseErr.message : String(parseErr),
        );
        return null;
      }
    }
    if (!res.ok) {
      if (res.status !== 404)
        console.warn(`[TICKETMASTER] HTTP ${res.status} on ${path}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn("[TICKETMASTER]", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Look up a Ticketmaster "attraction" (their term for artist) by name.
 * Returns the top music-classified result, or null if nothing matches.
 */
export async function findTicketmasterAttraction(
  name: string,
): Promise<{ id: string; name: string } | null> {
  const data = await tm<TMAttractionSearch>(
    `/attractions.json?keyword=${encodeURIComponent(name)}&classificationName=music&size=3`,
  );
  const lookupLc = name.toLowerCase().trim();
  // Require EXACT case-insensitive match. The previous substring fallback
  // caused identity poisoning: searching "Tori" matched "Tori Kelly", pulling
  // Tori Kelly's stadium tour into a Songfinch indie's report. False matches
  // on common first names ("Charlie", "Sarah", "Tate") were rampant.
  // If the artist has a different stage name on TM, they won't show up here —
  // that's correct behavior. Spotify-federated concerts catch indies.
  const attractions = data?._embedded?.attractions ?? [];
  const exact = attractions.find(
    (a) => a.name?.toLowerCase().trim() === lookupLc,
  );
  if (!exact) {
    if (attractions.length > 0) {
      console.warn(
        `[TM] rejected fuzzy matches for "${name}": ${attractions
          .slice(0, 3)
          .map((a) => a.name)
          .join(", ")}`,
      );
    }
    return null;
  }
  return { id: exact.id, name: exact.name };
}

/**
 * Fetch upcoming events for a Ticketmaster attraction ID.
 * Returns events normalized to our internal ArtistEvent shape.
 */
export async function getTicketmasterEvents(
  attractionId: string,
  limit = 20,
): Promise<ArtistEvent[]> {
  const data = await tm<TMEventsResponse>(
    `/events.json?attractionId=${encodeURIComponent(attractionId)}&size=${limit}&sort=date,asc&classificationName=music`,
  );
  const events = data?._embedded?.events ?? [];
  return events
    .map((e) => {
      const date = e.dates?.start?.localDate;
      const venue = e._embedded?.venues?.[0];
      if (!date || !venue) return null;
      const city = venue.city?.name ?? "";
      const state = venue.state?.stateCode ?? "";
      // city stays "Nashville, TN" (back-compat with anything that read the
      // composite form). We ALSO emit state as its own field so the Customer
      // Crossover can use it without re-parsing the city string.
      const cityFull = state ? `${city}, ${state}` : city;
      return {
        date,
        venue: venue.name ?? "TBD",
        city: cityFull,
        state: state || undefined,
        ticketUrl: e.url,
      } as ArtistEvent;
    })
    .filter((e): e is ArtistEvent => e !== null);
}

/**
 * One-call helper: name → attraction lookup → events.
 * Returns [] on any failure or no match.
 */
export async function getEventsForArtist(
  name: string,
): Promise<{ events: ArtistEvent[]; attractionName: string | null }> {
  const attraction = await findTicketmasterAttraction(name);
  if (!attraction) return { events: [], attractionName: null };
  const events = await getTicketmasterEvents(attraction.id);
  return { events, attractionName: attraction.name };
}
