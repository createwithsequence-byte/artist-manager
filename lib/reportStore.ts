import { ensureSchema, getDb } from "./db";
import type { ArtistReport } from "./types";

export async function loadReports(csvName: string): Promise<ArtistReport[]> {
  await ensureSchema();
  const db = getDb();
  if (!db) return [];
  const result = await db.execute({
    sql: "SELECT report FROM artist_reports WHERE csv_name = ? ORDER BY updated_at DESC",
    args: [csvName],
  });
  const reports: ArtistReport[] = [];
  for (const row of result.rows) {
    try {
      reports.push(JSON.parse(row.report as string));
    } catch {
      // skip corrupt row
    }
  }
  return reports;
}

export async function upsertReports(
  csvName: string,
  reports: ArtistReport[],
): Promise<{ inserted: number }> {
  if (reports.length === 0) return { inserted: 0 };
  await ensureSchema();
  const db = getDb();
  if (!db) return { inserted: 0 };

  const now = new Date().toISOString();
  // Batch inserts in transactions of ~50 to stay well under any payload caps
  const CHUNK = 50;
  let inserted = 0;
  for (let i = 0; i < reports.length; i += CHUNK) {
    const slice = reports.slice(i, i + CHUNK);
    const statements = slice.map((r) => ({
      sql: `INSERT INTO artist_reports (csv_name, name, report, scouted_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(csv_name, name) DO UPDATE SET
              report = excluded.report,
              updated_at = excluded.updated_at`,
      args: [csvName, r.name, JSON.stringify(r), now, now],
    }));
    await db.batch(statements, "write");
    inserted += slice.length;
  }
  return { inserted };
}

export async function deleteReports(csvName: string): Promise<number> {
  await ensureSchema();
  const db = getDb();
  if (!db) return 0;
  const result = await db.execute({
    sql: "DELETE FROM artist_reports WHERE csv_name = ?",
    args: [csvName],
  });
  return result.rowsAffected ?? 0;
}

export type CsvSummary = {
  csv_name: string;
  artist_count: number;
  last_updated: string;
};

/**
 * List all CSV names with their report counts and last-updated timestamp.
 * Powers the "Recent runs" picker on the empty state so coworkers can browse
 * prior scouts without needing to re-upload the source CSV.
 */
export async function listCsvs(): Promise<CsvSummary[]> {
  await ensureSchema();
  const db = getDb();
  if (!db) return [];
  const result = await db.execute(
    `SELECT csv_name, COUNT(*) as artist_count, MAX(updated_at) as last_updated
     FROM artist_reports
     GROUP BY csv_name
     ORDER BY MAX(updated_at) DESC`,
  );
  return result.rows.map((row) => ({
    csv_name: String(row.csv_name),
    artist_count:
      typeof row.artist_count === "number"
        ? row.artist_count
        : Number(row.artist_count) || 0,
    last_updated: String(row.last_updated ?? ""),
  }));
}

export async function countReports(csvName: string): Promise<number> {
  await ensureSchema();
  const db = getDb();
  if (!db) return 0;
  const result = await db.execute({
    sql: "SELECT COUNT(*) as n FROM artist_reports WHERE csv_name = ?",
    args: [csvName],
  });
  const n = result.rows[0]?.n;
  return typeof n === "number" ? n : Number(n) || 0;
}
