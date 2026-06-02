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
  /** Cloudinary storage path from audio_data_raw.id. NOT yet a playable URL
   *  (legacy paths 404 on the public CDN) — kept so audio can light up once a
   *  delivery/signing scheme is known, without re-uploading. */
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
