import type { RecentGig } from "./types";
import { createRateLimiter } from "./rate-limit";

const BASE = "https://api.setlist.fm/rest/1.0";

// setlist.fm limit: 2 req/sec, 1440/day. Pacing at 2 per 1100ms.
const waitForSlot = createRateLimiter(2, 1100);

export type { RecentGig };

type SetlistResponse = {
  setlist?: {
    eventDate: string;
    venue?: {
      name?: string;
      city?: { name?: string; country?: { code?: string } };
    };
  }[];
};

function parseEventDate(eventDate: string): string {
  const m = eventDate.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return eventDate;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

export async function getRecentGigs(
  mbid: string,
  daysBack = 90,
): Promise<RecentGig[]> {
  const key = process.env.SETLIST_FM_API_KEY;
  if (!key) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  try {
    await waitForSlot();
    const res = await fetch(`${BASE}/artist/${mbid}/setlists?p=1`, {
      headers: {
        "x-api-key": key,
        Accept: "application/json",
        "User-Agent": "ArtistManager/0.1",
      },
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`setlist.fm ${res.status}`);

    const data: SetlistResponse = await res.json();
    const setlists = data.setlist ?? [];
    return setlists
      .map((s) => ({
        date: parseEventDate(s.eventDate),
        venue: s.venue?.name ?? "?",
        city: s.venue?.city?.name ?? "?",
        country: s.venue?.city?.country?.code,
      }))
      .filter((g) => new Date(g.date) >= cutoff)
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch (err) {
    console.warn("[SETLISTFM]", err instanceof Error ? err.message : err);
    return [];
  }
}
