import type { NextRequest } from "next/server";
import { isTursoConfigured } from "@/lib/db";
import {
  backfillLibraryFromReports,
  countLibrary,
  loadLibrary,
  upsertLibrary,
} from "@/lib/library";
import type { ArtistReport } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/library        → { configured, count }   (light — for the home chip)
 * GET /api/library?full=1 → { configured, count, entries }  (full browse load)
 */
export async function GET(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json({ configured: false, count: 0 });
  }
  try {
    // First-touch migration: if the library is empty, import the existing
    // per-CSV buckets so the already-scouted roster appears immediately.
    let count = await countLibrary();
    if (count === 0) count = await backfillLibraryFromReports();

    const full = req.nextUrl.searchParams.get("full") === "1";
    if (!full) {
      return Response.json({ configured: true, count });
    }
    const entries = await loadLibrary();
    return Response.json({ configured: true, count: entries.length, entries });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST { reports, csvOrigin? } → upsert into the master library. */
export async function POST(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json({ error: "Turso not configured" }, { status: 503 });
  }
  let body: { reports?: ArtistReport[]; csvOrigin?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.reports)) {
    return Response.json({ error: "reports[] required" }, { status: 400 });
  }
  try {
    const result = await upsertLibrary(body.reports, body.csvOrigin ?? null);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
