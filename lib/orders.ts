/**
 * Song-order ("dossier") data — one row per song an artist made, joined to the
 * contact dataset by `user_id`. This is what turns a fan from a dot on a map
 * into "the person whose anniversary song was about the Junior Farmers Dance."
 *
 * Pure module (no DB import) so the upload panel can parse client-side, exactly
 * like parseCustomers in customerCrossover.ts. Persistence lives in
 * lib/customers.ts (server-only).
 */

export type ArtistOrder = {
  userId: string;
  customerName: string;
  occasion: string;
  recipientName: string;
  relationship: string;
  /** The relationship story the customer submitted — can be long (avg ~1.2k
   *  chars, max ~11k). Stored whole; truncated at display. */
  story: string;
  songTitle: string;
  genre: string;
  /** 1–5, or null when unrated (only ~29% are rated). */
  rating: number | null;
  orderDate: string;
  /** Public Songfinch song page ("…/songs/<uuid>") — the reliable "hear it"
   *  link surfaced in the dossier. Present in exports that include links. */
  songUrl?: string;
  /** Cloudinary storage path from audio_data_raw.id. NOT a playable URL on its
   *  own (legacy paths 404 on the public CDN); kept for a future inline-audio
   *  scheme. Prefer songUrl for "listen". */
  audioId?: string;
};

/** Tolerant header lookup — case-insensitive, tries common variants. */
function makeGet(row: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const k of Object.keys(row)) lower[k.toLowerCase().trim()] = row[k];
  return (...keys: string[]): string => {
    for (const k of keys) {
      const v = lower[k.toLowerCase()];
      // Skip empty/blank so the lookup falls through to the next candidate —
      // e.g. an empty `order_date` should defer to a populated `delivery_date`
      // rather than winning the chain with "".
      if (v !== undefined && v !== null && String(v).trim() !== "")
        return String(v).trim();
    }
    return "";
  };
}

/**
 * Parse raw CSV rows (header-keyed) into ArtistOrder[]. Drops rows with no
 * user_id (the join key is mandatory). Pulls the audio storage path out of the
 * audio_data_raw JSON blob when present.
 */
export function parseOrders(rows: Record<string, string>[]): ArtistOrder[] {
  const out: ArtistOrder[] = [];
  for (const row of rows) {
    const get = makeGet(row);
    const userId = get("user_id", "userid", "id");
    if (!userId) continue;

    let audioId: string | undefined;
    const rawAudio = get("audio_data_raw", "audio_data", "audio");
    if (rawAudio.startsWith("{")) {
      try {
        const j = JSON.parse(rawAudio);
        if (j && typeof j.id === "string") audioId = j.id;
      } catch {
        // Malformed blob — just skip audio for this row, keep the rest.
      }
    }

    const ratingRaw = parseInt(get("rating"), 10);
    const rating =
      Number.isFinite(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 5
        ? ratingRaw
        : null;

    const songUrlRaw = get("song_page_url", "song_url", "song_link");
    const songUrl = /^https?:\/\//i.test(songUrlRaw) ? songUrlRaw : undefined;

    out.push({
      userId,
      customerName: get("customer_name", "name", "full_name"),
      occasion: get("occasion"),
      recipientName: get("recipient_name", "recipient"),
      relationship: get("relationship"),
      story: get("story_brief", "story", "prompt", "brief"),
      songTitle: get("song_title", "title"),
      genre: get("genre", "style"),
      rating,
      orderDate: get("order_date", "delivery_date", "date"),
      songUrl,
      audioId,
    });
  }
  return out;
}

/** Group parsed orders by user for fast join against the fan list. A user with
 *  6 songs becomes one entry with 6 orders. */
export function ordersByUser(
  orders: ArtistOrder[],
): Map<string, ArtistOrder[]> {
  const m = new Map<string, ArtistOrder[]>();
  for (const o of orders) {
    const list = m.get(o.userId);
    if (list) list.push(o);
    else m.set(o.userId, [o]);
  }
  return m;
}

/** First name only, for warm display ("Gabriel" from "Gabriel Fierro"). */
export function firstName(full: string): string {
  return (full || "").trim().split(/\s+/)[0] || full || "";
}

/* ── Identity Mirror: the artist's body-of-work portrait ───────────────────── */

export type OrderSummary = {
  total: number; // total songs
  uniqueFans: number; // distinct people
  byOccasion: { occasion: string; count: number }[]; // desc
  byGenre: { genre: string; count: number }[]; // desc, capped
  patronCount: number; // fans with 2+ songs
  topPatrons: { name: string; count: number }[]; // desc, capped
  ratedAvg: number | null; // mean rating where rated
  /** Songs per calendar month, ascending by "YYYY-MM". Sparse — only months
   *  that have orders. Drives the momentum sparkline. */
  monthly: { ym: string; count: number }[];
  /** Most recent order date as "YYYY-MM-DD", or null when none parse. Drives
   *  the "last song N days ago" pulse. */
  lastOrderAt: string | null;
  /** Trailing-quarter momentum, anchored on the artist's OWN latest order month
   *  (honest even when the export is months stale). recent = last 3 months,
   *  prior = the 3 before that. pct null when there's no prior quarter. null
   *  entirely when fewer than 2 distinct months of data. */
  momentum: { recent: number; prior: number; pct: number | null } | null;
  /** Songs by calendar month, index 0 = January … 11 = December (summed across
   *  all years). Drives the "busy season" read. */
  byCalendarMonth: number[];
};

/**
 * Tolerant order-date parse → { y, m (1-based), d }. Handles ISO
 * ("YYYY-MM-DD…"), US ("M/D/YYYY"), and anything else `Date` understands
 * (read in UTC to avoid month-boundary drift). Returns null when unparseable.
 */
export function parseOrderDate(
  s: string,
): { y: number; m: number; d: number } | null {
  const t = (s || "").trim();
  if (!t) return null;
  let mm = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (mm) return { y: +mm[1], m: +mm[2], d: +mm[3] };
  mm = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mm) return { y: +mm[3], m: +mm[1], d: +mm[2] };
  const dt = new Date(t);
  if (!Number.isNaN(dt.getTime()))
    return {
      y: dt.getUTCFullYear(),
      m: dt.getUTCMonth() + 1,
      d: dt.getUTCDate(),
    };
  return null;
}

/**
 * Roll an artist's orders into a portrait of their work: what occasions they
 * write for, in what genres, who keeps coming back. Runs server-side so only
 * the counts (a few KB) cross the wire, never the multi-MB story blob.
 */
export function summarizeOrders(orders: ArtistOrder[]): OrderSummary {
  const occ = new Map<string, number>();
  const gen = new Map<string, number>();
  const byUser = new Map<string, { name: string; count: number }>();
  let ratingSum = 0;
  let ratingN = 0;
  // Time series: orders keyed by month-index (y*12 + m-1) for cheap arithmetic,
  // plus calendar-month tallies and a running max date for the pulse.
  const byMonthIdx = new Map<number, number>();
  const calMonth = new Array(12).fill(0) as number[];
  let maxKey = -1; // y*10000 + m*100 + d — for the latest order
  let lastOrderAt: string | null = null;
  for (const o of orders) {
    const oc = (o.occasion || "").trim() || "Unspecified";
    occ.set(oc, (occ.get(oc) ?? 0) + 1);
    const g = (o.genre || "").trim();
    if (g) gen.set(g, (gen.get(g) ?? 0) + 1);
    const u = byUser.get(o.userId);
    if (u) u.count += 1;
    else byUser.set(o.userId, { name: o.customerName || "Fan", count: 1 });
    if (typeof o.rating === "number") {
      ratingSum += o.rating;
      ratingN += 1;
    }
    const d = parseOrderDate(o.orderDate);
    if (d) {
      const idx = d.y * 12 + (d.m - 1);
      byMonthIdx.set(idx, (byMonthIdx.get(idx) ?? 0) + 1);
      calMonth[d.m - 1] += 1;
      const key = d.y * 10000 + d.m * 100 + d.d;
      if (key > maxKey) {
        maxKey = key;
        lastOrderAt = `${d.y}-${String(d.m).padStart(2, "0")}-${String(
          d.d,
        ).padStart(2, "0")}`;
      }
    }
  }
  const desc = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]);
  const patrons = [...byUser.values()]
    .filter((u) => u.count >= 2)
    .sort((a, b) => b.count - a.count);

  // Monthly series (sparse, ascending) for the sparkline.
  const monthly = [...byMonthIdx.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, count]) => ({
      ym: `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`,
      count,
    }));

  // Momentum: anchor on the latest month that has data, sum the trailing 3
  // months vs the 3 before. Stale exports stay honest — we measure the slope at
  // the END of their data, not against a wall-clock "now" they never reach.
  let momentum: OrderSummary["momentum"] = null;
  if (byMonthIdx.size >= 2) {
    const maxIdx = Math.max(...byMonthIdx.keys());
    const sumRange = (lo: number, hi: number) => {
      let s = 0;
      for (let i = lo; i <= hi; i++) s += byMonthIdx.get(i) ?? 0;
      return s;
    };
    const recent = sumRange(maxIdx - 2, maxIdx);
    const prior = sumRange(maxIdx - 5, maxIdx - 3);
    momentum = {
      recent,
      prior,
      pct: prior > 0 ? (recent - prior) / prior : null,
    };
  }

  return {
    total: orders.length,
    uniqueFans: byUser.size,
    byOccasion: desc(occ).map(([occasion, count]) => ({ occasion, count })),
    byGenre: desc(gen)
      .slice(0, 6)
      .map(([genre, count]) => ({ genre, count })),
    patronCount: patrons.length,
    topPatrons: patrons
      .slice(0, 6)
      .map((p) => ({ name: p.name, count: p.count })),
    ratedAvg: ratingN ? ratingSum / ratingN : null,
    monthly,
    lastOrderAt,
    momentum,
    byCalendarMonth: calMonth,
  };
}
