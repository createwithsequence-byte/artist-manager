import { ensureSchema, getDb } from "./db";
import type { ArtistReport } from "./types";

/**
 * Canonical identity for an artist, independent of which CSV they came from.
 * Spotify URL (from the CSV) is most authoritative, then the resolved
 * spotify.id, then a normalized name as last resort. Mirrors the anchoring we
 * already use to prevent "Tori → Tori Kelly" identity poisoning.
 */
export function artistIdentity(r: ArtistReport): string {
  const fromUrl = r.csvSpotifyUrl?.match(/artist[/:]([A-Za-z0-9]{22})/)?.[1];
  if (fromUrl) return `sp:${fromUrl}`;
  if (r.spotify?.id) return `sp:${r.spotify.id}`;
  return `nm:${(r.name || "").trim().toLowerCase()}`;
}

export type LibraryEntry = {
  identity: string;
  name: string;
  report: ArtistReport;
  csvOrigin: string | null;
  scoutedAt: string;
  updatedAt: string;
};

/**
 * Upsert reports into the master library, keyed by artist identity. First
 * insert sets scouted_at; later writes refresh report/updated_at/name but
 * preserve the original scouted_at (so we can show "scouted 42d ago").
 */
export async function upsertLibrary(
  reports: ArtistReport[],
  csvOrigin: string | null,
): Promise<{ upserted: number }> {
  if (reports.length === 0) return { upserted: 0 };
  await ensureSchema();
  const db = getDb();
  if (!db) return { upserted: 0 };

  const now = new Date().toISOString();
  const CHUNK = 50;
  let upserted = 0;
  for (let i = 0; i < reports.length; i += CHUNK) {
    const slice = reports.slice(i, i + CHUNK);
    const statements = slice.map((r) => ({
      sql: `INSERT INTO artist_library (identity, name, report, csv_origin, scouted_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(identity) DO UPDATE SET
              report = excluded.report,
              name = excluded.name,
              updated_at = excluded.updated_at`,
      args: [artistIdentity(r), r.name, JSON.stringify(r), csvOrigin, now, now],
    }));
    await db.batch(statements, "write");
    upserted += slice.length;
  }
  return { upserted };
}

/** Every artist in the library, freshest first. */
export async function loadLibrary(): Promise<LibraryEntry[]> {
  await ensureSchema();
  const db = getDb();
  if (!db) return [];
  const result = await db.execute(
    `SELECT identity, name, report, csv_origin, scouted_at, updated_at
     FROM artist_library ORDER BY updated_at DESC`,
  );
  const out: LibraryEntry[] = [];
  for (const row of result.rows) {
    try {
      out.push({
        identity: String(row.identity),
        name: String(row.name),
        report: JSON.parse(row.report as string),
        csvOrigin: row.csv_origin ? String(row.csv_origin) : null,
        scoutedAt: String(row.scouted_at),
        updatedAt: String(row.updated_at),
      });
    } catch {
      // skip corrupt row
    }
  }
  return out;
}

export async function countLibrary(): Promise<number> {
  await ensureSchema();
  const db = getDb();
  if (!db) return 0;
  const result = await db.execute("SELECT COUNT(*) as n FROM artist_library");
  const n = result.rows[0]?.n;
  return typeof n === "number" ? n : Number(n) || 0;
}

/**
 * One-time migration: import every artist from the legacy per-CSV buckets
 * into the identity-keyed library, deduped (most-recently-updated wins). Safe
 * to call repeatedly — upsert by identity makes it idempotent. Runs the first
 * time the library is opened while still empty, so the existing scouted
 * roster appears without a manual step.
 */
export async function backfillLibraryFromReports(): Promise<number> {
  await ensureSchema();
  const db = getDb();
  if (!db) return 0;
  const result = await db.execute(
    "SELECT report FROM artist_reports ORDER BY updated_at ASC",
  );
  const byIdentity = new Map<string, ArtistReport>();
  for (const row of result.rows) {
    try {
      const r = JSON.parse(row.report as string) as ArtistReport;
      byIdentity.set(artistIdentity(r), r); // ASC → last (most recent) wins
    } catch {
      // skip corrupt row
    }
  }
  const reports = [...byIdentity.values()];
  await upsertLibrary(reports, "imported");
  return reports.length;
}
