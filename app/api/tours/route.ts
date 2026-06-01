import type { NextRequest } from "next/server";
import { isTursoConfigured } from "@/lib/db";
import {
  deleteTour,
  listTours,
  saveTour,
  type SavedTourKind,
} from "@/lib/savedTours";
import type { Event as ArtistEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET    /api/tours?artist=<key>                  → { configured, tours: SavedTour[] }
 * POST   /api/tours  { artist, name, kind, stops } → { configured, id, tours }
 * DELETE /api/tours?id=<id>&artist=<key>           → { configured, tours }
 *
 * Per-artist library of saved itinerary snapshots. Every mutating call returns
 * the refreshed list so the panel can update from one round-trip.
 */
export async function GET(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json({ configured: false, tours: [] });
  }
  const artist = req.nextUrl.searchParams.get("artist");
  if (!artist) {
    return Response.json({ error: "artist key required" }, { status: 400 });
  }
  try {
    const tours = await listTours(artist);
    return Response.json({ configured: true, tours });
  } catch (err) {
    console.warn(
      "[TOURS] GET",
      err instanceof Error ? err.message : String(err),
    );
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json(
      { error: "Persistence not configured" },
      { status: 503 },
    );
  }
  let body: {
    artist?: string;
    name?: string;
    kind?: string;
    stops?: ArtistEvent[];
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const artist = body.artist?.trim();
  if (!artist) {
    return Response.json({ error: "artist key required" }, { status: 400 });
  }
  if (!Array.isArray(body.stops) || body.stops.length === 0) {
    return Response.json(
      { error: "a tour needs at least one stop" },
      { status: 400 },
    );
  }
  const kind: SavedTourKind = body.kind === "new" ? "new" : "booked";

  try {
    // Defensive: persist only the fields a stop legitimately carries, so a
    // bloated/garbage client payload can't balloon the blob or smuggle keys.
    const stops: ArtistEvent[] = body.stops.map((s) => ({
      date: String(s?.date ?? ""),
      venue: String(s?.venue ?? ""),
      city: String(s?.city ?? ""),
      ...(s?.state ? { state: String(s.state) } : {}),
    }));
    const saved = await saveTour({
      artistKey: artist,
      name: body.name ?? "",
      kind,
      stops,
    });
    const tours = await listTours(artist);
    return Response.json({ configured: true, id: saved.id, tours });
  } catch (err) {
    console.warn(
      "[TOURS] POST",
      err instanceof Error ? err.message : String(err),
    );
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json(
      { error: "Persistence not configured" },
      { status: 503 },
    );
  }
  const id = req.nextUrl.searchParams.get("id");
  const artist = req.nextUrl.searchParams.get("artist");
  if (!id || !artist) {
    return Response.json(
      { error: "id and artist key required" },
      { status: 400 },
    );
  }
  try {
    await deleteTour(id, artist);
    const tours = await listTours(artist);
    return Response.json({ configured: true, tours });
  } catch (err) {
    console.warn(
      "[TOURS] DELETE",
      err instanceof Error ? err.message : String(err),
    );
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
