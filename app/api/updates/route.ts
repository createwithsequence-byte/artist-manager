import type { NextRequest } from "next/server";
import { isTursoConfigured } from "@/lib/db";
import { loadUpdates, saveUpdates } from "@/lib/customers";
import { normalizeType, type Announcement } from "@/lib/updates";

export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * GET  /api/updates?artist=<key>        → { configured, updates }
 * POST /api/updates  { artist, updates } → { configured, ok }
 *
 * The full announcement list per artist, replace-on-save (the list is tiny).
 */
export async function GET(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json({ configured: false, updates: [] });
  }
  const artist = req.nextUrl.searchParams.get("artist");
  if (!artist) {
    return Response.json({ error: "artist key required" }, { status: 400 });
  }
  try {
    const updates = await loadUpdates(artist);
    return Response.json({ configured: true, updates });
  } catch (err) {
    console.warn(
      "[UPDATES] GET",
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
  let body: { artist?: string; updates?: Announcement[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const artist = body.artist?.trim();
  if (!artist) {
    return Response.json({ error: "artist key required" }, { status: 400 });
  }
  if (!Array.isArray(body.updates)) {
    return Response.json({ error: "updates array required" }, { status: 400 });
  }
  try {
    // Whitelist + cap each field so a bad payload can't bloat the row. Drop
    // items with no headline (nothing to announce). Keep at most 100.
    const updates: Announcement[] = body.updates
      .filter((u) => u && typeof u.headline === "string" && u.headline.trim())
      .slice(0, 100)
      .map((u) => ({
        id: String(u.id || "").slice(0, 64) || crypto.randomUUID(),
        type: normalizeType(u.type),
        headline: String(u.headline).slice(0, 200),
        ...(u.date ? { date: String(u.date).slice(0, 80) } : {}),
        ...(u.url ? { url: String(u.url).slice(0, 500) } : {}),
        ...(u.blurb ? { blurb: String(u.blurb).slice(0, 2000) } : {}),
        createdAt: String(u.createdAt || new Date().toISOString()),
      }));
    await saveUpdates(artist, updates);
    return Response.json({ configured: true, ok: true, count: updates.length });
  } catch (err) {
    console.warn(
      "[UPDATES] POST",
      err instanceof Error ? err.message : String(err),
    );
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
