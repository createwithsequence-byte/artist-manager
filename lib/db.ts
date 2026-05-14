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
  _schemaReady = true;
}
