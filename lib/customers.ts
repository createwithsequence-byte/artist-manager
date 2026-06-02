import { ensureSchema, getDb } from "./db";
import type { CityAggregate, Customer } from "./customerCrossover";
import type { ArtistOrder } from "./orders";

/**
 * SF customer master persistence — stores pre-aggregated city roll-ups so the
 * 3D globe + 2D map render paths are zero-cost on load. Multiple datasets
 * allowed (id is user-chosen slug), canonical one is "master".
 *
 * Why aggregate-only (not raw rows): a single dataset of 100k Songfinch
 * customers as raw JSON is ~25-50MB. Aggregated to cities it's ~50-100KB.
 * For globe rendering we only need {lat, lng, count} per city; the raw rows
 * still flow through the session for TOUR HERE / mailing-list export.
 */

export type CustomerDataset = {
  id: string;
  name: string;
  customerCount: number;
  cityCount: number;
  aggregate: CityAggregate[];
  uploadedAt: string;
  updatedAt: string;
};

export type CustomerDatasetMeta = Omit<CustomerDataset, "aggregate">;

/** Upsert: first write sets uploaded_at, later writes refresh aggregate +
 *  updated_at but preserve the original uploaded_at (so the dataset shows
 *  "first uploaded X days ago"). */
export async function upsertCustomerDataset(
  id: string,
  name: string,
  aggregate: CityAggregate[],
  customerCount: number,
): Promise<{ id: string; cityCount: number }> {
  await ensureSchema();
  const db = getDb();
  if (!db) throw new Error("Turso not configured");

  const now = new Date().toISOString();
  const cityCount = aggregate.length;
  await db.execute({
    sql: `INSERT INTO customer_dataset
            (id, name, customer_count, city_count, aggregate, uploaded_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            customer_count = excluded.customer_count,
            city_count = excluded.city_count,
            aggregate = excluded.aggregate,
            updated_at = excluded.updated_at`,
    args: [
      id,
      name,
      customerCount,
      cityCount,
      JSON.stringify(aggregate),
      now,
      now,
    ],
  });
  return { id, cityCount };
}

/** Load a dataset by id, hydrating the aggregate JSON. */
export async function loadCustomerDataset(
  id: string,
): Promise<CustomerDataset | null> {
  await ensureSchema();
  const db = getDb();
  if (!db) return null;
  const result = await db.execute({
    sql: `SELECT id, name, customer_count, city_count, aggregate,
                 uploaded_at, updated_at
          FROM customer_dataset WHERE id = ?`,
    args: [id],
  });
  const row = result.rows[0];
  if (!row) return null;
  try {
    return {
      id: String(row.id),
      name: String(row.name),
      customerCount: Number(row.customer_count) || 0,
      cityCount: Number(row.city_count) || 0,
      aggregate: JSON.parse(row.aggregate as string) as CityAggregate[],
      uploadedAt: String(row.uploaded_at),
      updatedAt: String(row.updated_at),
    };
  } catch {
    return null;
  }
}

/** Lightweight listing for the picker / nav chip — no aggregate JSON. */
export async function listCustomerDatasets(): Promise<CustomerDatasetMeta[]> {
  await ensureSchema();
  const db = getDb();
  if (!db) return [];
  const result = await db.execute(
    `SELECT id, name, customer_count, city_count, uploaded_at, updated_at
     FROM customer_dataset ORDER BY updated_at DESC`,
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    customerCount: Number(row.customer_count) || 0,
    cityCount: Number(row.city_count) || 0,
    uploadedAt: String(row.uploaded_at),
    updatedAt: String(row.updated_at),
  }));
}

export async function deleteCustomerDataset(id: string): Promise<void> {
  await ensureSchema();
  const db = getDb();
  if (!db) return;
  await db.batch(
    [
      { sql: "DELETE FROM customer_dataset WHERE id = ?", args: [id] },
      { sql: "DELETE FROM customer_dataset_raw WHERE id = ?", args: [id] },
    ],
    "write",
  );
}

/**
 * Upsert the raw customer rows for a dataset. Kept in a separate table so
 * lightweight aggregate-only reads don't pay the MB-scale bandwidth tax of
 * the full row blob. Called from /api/customers POST when the body includes
 * a `raw` array.
 */
export async function upsertCustomerDatasetRaw(
  id: string,
  rows: Customer[],
): Promise<{ id: string; rowCount: number }> {
  await ensureSchema();
  const db = getDb();
  if (!db) throw new Error("Turso not configured");

  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO customer_dataset_raw (id, rows, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            rows = excluded.rows,
            updated_at = excluded.updated_at`,
    args: [id, JSON.stringify(rows), now],
  });
  return { id, rowCount: rows.length };
}

/**
 * Load the raw customer rows for a dataset, or null if none persisted.
 * Routing-sheet crossover hydrates from this on mount when a master exists
 * so the user doesn't re-upload the same file across sessions.
 */
export async function loadCustomerDatasetRaw(
  id: string,
): Promise<Customer[] | null> {
  await ensureSchema();
  const db = getDb();
  if (!db) return null;
  const result = await db.execute({
    sql: "SELECT rows FROM customer_dataset_raw WHERE id = ?",
    args: [id],
  });
  const row = result.rows[0];
  if (!row) return null;
  try {
    return JSON.parse(row.rows as string) as Customer[];
  } catch {
    return null;
  }
}

/**
 * Copy one dataset (aggregate + raw rows) onto another id — used to "adopt"
 * the legacy global master as a specific artist's own dataset without making
 * the user re-upload. Runs entirely server-side so the multi-MB raw blob
 * never round-trips through the browser. Preserves the source; only writes
 * the target (named after the adopting artist).
 */
export async function copyCustomerDataset(
  fromId: string,
  toId: string,
  name: string,
): Promise<{ id: string; cityCount: number; rowCount: number }> {
  const src = await loadCustomerDataset(fromId);
  if (!src) throw new Error(`Source dataset "${fromId}" not found`);
  const { cityCount } = await upsertCustomerDataset(
    toId,
    name,
    src.aggregate,
    src.customerCount,
  );
  const raw = await loadCustomerDatasetRaw(fromId);
  let rowCount = 0;
  if (raw && raw.length > 0) {
    const r = await upsertCustomerDatasetRaw(toId, raw);
    rowCount = r.rowCount;
  }
  return { id: toId, cityCount, rowCount };
}

/* ── Song-order ("dossier") enrichment ─────────────────────────────────────
 * One blob of parsed ArtistOrder[] per artist, keyed by the same customerKey
 * the routing panel uses. Replace-on-upload (a fresh export supersedes the old
 * one), mirroring how a re-uploaded customer CSV replaces its dataset. */

export async function upsertArtistOrders(
  artistKey: string,
  orders: ArtistOrder[],
): Promise<{ orderCount: number }> {
  await ensureSchema();
  const db = getDb();
  if (!db) throw new Error("Turso not configured");
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO artist_orders (artist_key, orders, order_count, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(artist_key) DO UPDATE SET
            orders = excluded.orders,
            order_count = excluded.order_count,
            updated_at = excluded.updated_at`,
    args: [artistKey, JSON.stringify(orders), orders.length, now],
  });
  return { orderCount: orders.length };
}

export async function deleteArtistOrders(artistKey: string): Promise<void> {
  await ensureSchema();
  const db = getDb();
  if (!db) return;
  await db.execute({
    sql: `DELETE FROM artist_orders WHERE artist_key = ?`,
    args: [artistKey],
  });
}

export async function loadArtistOrders(
  artistKey: string,
): Promise<ArtistOrder[]> {
  await ensureSchema();
  const db = getDb();
  if (!db) return [];
  const result = await db.execute({
    sql: `SELECT orders FROM artist_orders WHERE artist_key = ?`,
    args: [artistKey],
  });
  const row = result.rows[0];
  if (!row) return [];
  try {
    const parsed = JSON.parse(String(row.orders));
    return Array.isArray(parsed) ? (parsed as ArtistOrder[]) : [];
  } catch {
    return [];
  }
}
