import { randomUUID } from "node:crypto";
import { ensureSchema, getDb } from "./db";
import type { Event as ArtistEvent } from "./types";

/**
 * Saved-tour persistence — a per-artist library of frozen itinerary snapshots.
 *
 * The routing panel's tours (booked gap-fills + the new-tour workspace) are
 * otherwise ephemeral React state that vanish on reload. A "save" snapshots the
 * complete stop list under a name so it survives, and can be reopened into the
 * new-tour workspace later. Mirrors lib/customers.ts (Turso, JSON blob column).
 *
 * Stops are small — a dozen Event objects (~1KB) — so list() returns them
 * inline rather than forcing a second detail fetch.
 */

export type SavedTourKind = "booked" | "new";

export type SavedTour = {
  id: string;
  artistKey: string;
  name: string;
  kind: SavedTourKind;
  stops: ArtistEvent[];
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: unknown;
  artist_key: unknown;
  name: unknown;
  kind: unknown;
  stops: unknown;
  created_at: unknown;
  updated_at: unknown;
};

function rowToTour(r: Row): SavedTour {
  let stops: ArtistEvent[] = [];
  try {
    const parsed = JSON.parse(String(r.stops));
    if (Array.isArray(parsed)) stops = parsed as ArtistEvent[];
  } catch {
    // A corrupt blob shouldn't sink the whole list — surface an empty tour
    // rather than throwing, so the other saved tours still load.
    stops = [];
  }
  return {
    id: String(r.id),
    artistKey: String(r.artist_key),
    name: String(r.name),
    kind: r.kind === "new" ? "new" : "booked",
    stops,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** Insert a new saved tour (always a fresh snapshot — saves are append-only,
 *  so re-saving an edited tour keeps the prior version too). Returns the row. */
export async function saveTour(input: {
  artistKey: string;
  name: string;
  kind: SavedTourKind;
  stops: ArtistEvent[];
}): Promise<SavedTour> {
  await ensureSchema();
  const db = getDb();
  if (!db) throw new Error("Turso not configured");

  const now = new Date().toISOString();
  const tour: SavedTour = {
    id: randomUUID(),
    artistKey: input.artistKey,
    name: input.name.trim() || "Untitled tour",
    kind: input.kind,
    stops: input.stops,
    createdAt: now,
    updatedAt: now,
  };
  await db.execute({
    sql: `INSERT INTO saved_tour
            (id, artist_key, name, kind, stops, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      tour.id,
      tour.artistKey,
      tour.name,
      tour.kind,
      JSON.stringify(tour.stops),
      now,
      now,
    ],
  });
  return tour;
}

/** All saved tours for an artist, newest first. */
export async function listTours(artistKey: string): Promise<SavedTour[]> {
  await ensureSchema();
  const db = getDb();
  if (!db) return [];
  const result = await db.execute({
    sql: `SELECT id, artist_key, name, kind, stops, created_at, updated_at
            FROM saved_tour
           WHERE artist_key = ?
           ORDER BY created_at DESC`,
    args: [artistKey],
  });
  return result.rows.map((r) => rowToTour(r as unknown as Row));
}

/** Delete one saved tour. Scoped by artistKey so a stale/forged id can't reach
 *  another artist's library. */
export async function deleteTour(id: string, artistKey: string): Promise<void> {
  await ensureSchema();
  const db = getDb();
  if (!db) return;
  await db.execute({
    sql: `DELETE FROM saved_tour WHERE id = ? AND artist_key = ?`,
    args: [id, artistKey],
  });
}
