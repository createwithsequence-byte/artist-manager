import type { NextRequest } from "next/server";
import { isTursoConfigured } from "@/lib/db";
import { loadOutreach, logOutreach } from "@/lib/customers";
import type { OutreachChannel } from "@/lib/outreach";

export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * GET  /api/outreach?artist=<key>                              → { configured, entries }
 * POST /api/outreach  { artist, channel, target, recipientCount, note } → { ok }
 *
 * The fan-contact ledger. Every per-stop email and broadcast logs one row so
 * the tool remembers who's been reached.
 */
export async function GET(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json({ configured: false, entries: [] });
  }
  const artist = req.nextUrl.searchParams.get("artist");
  if (!artist) {
    return Response.json({ error: "artist key required" }, { status: 400 });
  }
  try {
    const entries = await loadOutreach(artist);
    return Response.json({ configured: true, entries });
  } catch (err) {
    console.warn(
      "[OUTREACH] GET",
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
    channel?: string;
    target?: string;
    recipientCount?: number;
    note?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const artist = body.artist?.trim();
  const target = body.target?.trim();
  if (!artist || !target) {
    return Response.json(
      { error: "artist and target required" },
      { status: 400 },
    );
  }
  const channel: OutreachChannel =
    body.channel === "broadcast" ? "broadcast" : "email-stop";
  try {
    await logOutreach({
      artistKey: artist,
      channel,
      target: target.slice(0, 200),
      recipientCount: Math.max(0, Math.floor(Number(body.recipientCount) || 0)),
      note: body.note ? String(body.note).slice(0, 200) : undefined,
    });
    return Response.json({ configured: true, ok: true });
  } catch (err) {
    console.warn(
      "[OUTREACH] POST",
      err instanceof Error ? err.message : String(err),
    );
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
