import type { NextRequest } from "next/server";
import { isTursoConfigured } from "@/lib/db";
import { loadArtistNote, saveArtistNote } from "@/lib/customers";

export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * GET  /api/notes?artist=<key>     → { configured, note }
 * POST /api/notes  { artist, note } → { configured, ok }
 *
 * One free-text internal note per artist, keyed by the stable name-first
 * identity. An empty note is valid (it clears the scratchpad).
 */
export async function GET(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json({ configured: false, note: "" });
  }
  const artist = req.nextUrl.searchParams.get("artist");
  if (!artist) {
    return Response.json({ error: "artist key required" }, { status: 400 });
  }
  try {
    const note = await loadArtistNote(artist);
    return Response.json({ configured: true, note });
  } catch (err) {
    console.warn(
      "[NOTES] GET",
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
  let body: { artist?: string; note?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const artist = body.artist?.trim();
  if (!artist) {
    return Response.json({ error: "artist key required" }, { status: 400 });
  }
  // Cap to keep a runaway client from storing megabytes in a scratchpad.
  const note = String(body.note ?? "").slice(0, 20_000);
  try {
    await saveArtistNote(artist, note);
    return Response.json({ configured: true, ok: true });
  } catch (err) {
    console.warn(
      "[NOTES] POST",
      err instanceof Error ? err.message : String(err),
    );
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
