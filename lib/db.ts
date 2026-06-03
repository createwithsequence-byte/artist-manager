import { createClient, type Client } from "@libsql/client";

let _client: Client | null = null;

export function getDb(): Client | null {
  if (!process.env.TURSO_URL || !process.env.TURSO_TOKEN) return null;
  if (!_client) {
    _client = createClient({
      url: process.env.TURSO_URL,
      authToken: process.env.TURSO_TOKEN,
    });
  }
  return _client;
}

export function isTursoConfigured(): boolean {
  return !!(process.env.TURSO_URL && process.env.TURSO_TOKEN);
}

// Run-once schema bootstrap. Safe to call repeatedly.
let _schemaReady = false;
export async function ensureSchema(): Promise<void> {
  if (_schemaReady) return;
  const db = getDb();
  if (!db) return;
  await db.execute(`CREATE TABLE IF NOT EXISTS artist_reports (
    csv_name TEXT NOT NULL,
    name TEXT NOT NULL,
    report TEXT NOT NULL,
    scouted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (csv_name, name)
  )`);
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_csv_name ON artist_reports(csv_name)`,
  );
  // Shared LLM cooldown registry so every Vercel lambda sees the same quota
  // state instead of each cold-start re-probing Gemini → Groq → Cerebras
  // from scratch. Key is the model name (e.g. "gemini-2.5-flash"). Value is
  // the ms timestamp when that model returned a daily-quota error. Readers
  // compute remaining cooldown against MODEL_COOLDOWN_MS in lib/gemini.ts.
  await db.execute(`CREATE TABLE IF NOT EXISTS model_cooldown (
    model TEXT PRIMARY KEY,
    exhausted_at_ms INTEGER NOT NULL
  )`);
  // Master Artist Library — identity-keyed (Spotify-URL → spotify.id →
  // normalized name), so every scout (solo or group) lands in ONE durable
  // store regardless of which CSV it came from. csv_origin is mere metadata
  // (where we first saw them). scouted_at is preserved on first insert.
  await db.execute(`CREATE TABLE IF NOT EXISTS artist_library (
    identity TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    report TEXT NOT NULL,
    csv_origin TEXT,
    scouted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  // SF customer master — upload-once-browse-forever audience map. We store a
  // pre-aggregated city roll-up (NOT raw rows) to keep the blob KB-sized and
  // the globe render path zero-cost: no client-side bucketing on load.
  // Multiple datasets allowed (id is user-chosen), but the canonical one is
  // "master".
  await db.execute(`CREATE TABLE IF NOT EXISTS customer_dataset (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    customer_count INTEGER NOT NULL,
    city_count INTEGER NOT NULL,
    aggregate TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  // Raw customer rows — separate table because the JSON can be 5–25MB for a
  // real Songfinch dataset and we don't want every aggregate-only call (home
  // chip, globe load) paying that bandwidth. Loaded on demand by the routing
  // crossover panel only. id mirrors customer_dataset.id so they share an
  // identity space without FK enforcement (libSQL skips most FK checks anyway).
  await db.execute(`CREATE TABLE IF NOT EXISTS customer_dataset_raw (
    id TEXT PRIMARY KEY,
    rows TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  // Saved tours — a per-artist library of frozen itinerary snapshots. Each row
  // is a complete stop list (anchors + provisional) the user chose to keep, so
  // it survives reload and can be reopened into the new-tour workspace. Keyed
  // by artist_key (the customerKey identity the routing panel already uses).
  // stops is small (a dozen Event objects, ~1KB) so list queries return it
  // inline — no separate detail fetch needed. kind records where it came from
  // ("booked" gap-fill vs "new" from-scratch run) for display only.
  await db.execute(`CREATE TABLE IF NOT EXISTS saved_tour (
    id TEXT PRIMARY KEY,
    artist_key TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    stops TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_saved_tour_artist ON saved_tour(artist_key)`,
  );
  // Song-order "dossier" data — one blob of parsed ArtistOrder[] per artist,
  // joined to the contact dataset by user_id at read time. Separate from
  // customer_dataset because it's an optional enrichment (not every artist
  // uploads orders) and the blob is multi-MB (stories are long) — only the
  // routing panel's dossier view loads it, never the home chip or globe.
  await db.execute(`CREATE TABLE IF NOT EXISTS artist_orders (
    artist_key TEXT PRIMARY KEY,
    orders TEXT NOT NULL,
    order_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  // Internal notes — one free-text scratchpad per artist, keyed by the same
  // stable name-first identity the customer/orders data uses. Team-authored
  // (not AI), so it lives apart from the report blob and survives re-scouts.
  await db.execute(`CREATE TABLE IF NOT EXISTS artist_notes (
    artist_key TEXT PRIMARY KEY,
    note TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  // Announcements — a per-artist list of upcoming releases / tours / merch /
  // news the team writes in, to broadcast to the fanbase. Stored as one small
  // JSON list per artist (a handful of items), replace-on-save.
  await db.execute(`CREATE TABLE IF NOT EXISTS artist_updates (
    artist_key TEXT PRIMARY KEY,
    updates TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  // Outreach ledger — one row per fan-contact action (a per-stop email or a
  // fanbase/segment broadcast). Gives the tool memory of who's been reached,
  // so the team stops double-sending and so the dashboard / recurring-occasion
  // radar / RSVP can all read a single "last contacted" source. target is the
  // stop identity (date|city) or the announcement, so the panel can match it
  // back to a row in O(1).
  await db.execute(`CREATE TABLE IF NOT EXISTS outreach_log (
    id TEXT PRIMARY KEY,
    artist_key TEXT NOT NULL,
    channel TEXT NOT NULL,
    target TEXT NOT NULL,
    recipient_count INTEGER NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
  )`);
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_outreach_artist ON outreach_log(artist_key)`,
  );
  _schemaReady = true;
}

/**
 * Load the full model_cooldown table. Called once per Vercel lambda warm
 * lifetime to hydrate the in-memory cache in lib/gemini.ts — so the
 * fast hot-path check stays synchronous and per-call Turso latency is paid
 * exactly once.
 */
export async function loadModelCooldowns(): Promise<
  { model: string; exhausted_at_ms: number }[]
> {
  await ensureSchema();
  const db = getDb();
  if (!db) return [];
  const result = await db.execute(
    "SELECT model, exhausted_at_ms FROM model_cooldown",
  );
  return result.rows.map((r) => ({
    model: String(r.model),
    exhausted_at_ms: Number(r.exhausted_at_ms),
  }));
}

/**
 * Record a model as exhausted. UPSERT pattern so when the same model's quota
 * rolls over (e.g. midnight Pacific for Gemini's daily-RPD reset) and later
 * exhausts again, the row gets a fresh timestamp instead of staying stuck on
 * the original one. Fire-and-forget — DB failures shouldn't block the LLM
 * path because the in-memory cache absorbs the cooldown locally regardless.
 */
export async function recordModelCooldown(
  model: string,
  exhaustedAtMs: number,
): Promise<void> {
  await ensureSchema();
  const db = getDb();
  if (!db) return;
  await db.execute({
    sql: `INSERT INTO model_cooldown (model, exhausted_at_ms)
          VALUES (?, ?)
          ON CONFLICT(model) DO UPDATE SET exhausted_at_ms = excluded.exhausted_at_ms`,
    args: [model, exhaustedAtMs],
  });
}
