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
      if (v !== undefined && v !== null) return String(v).trim();
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
};

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
  }
  const desc = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]);
  const patrons = [...byUser.values()]
    .filter((u) => u.count >= 2)
    .sort((a, b) => b.count - a.count);
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
  };
}
