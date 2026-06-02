import type { NextRequest } from "next/server";
import { isTursoConfigured } from "@/lib/db";
import {
  deleteArtistOrders,
  loadArtistOrders,
  upsertArtistOrders,
} from "@/lib/customers";
import { summarizeOrders, type ArtistOrder } from "@/lib/orders";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET  /api/orders?artist=<key>          → { configured, orders, count }
 * POST /api/orders  { artist, orders[] } → { configured, orderCount }
 *
 * Per-artist song-order dossier data. The client parses the CSV to lean
 * ArtistOrder[] (dropping the fat audio blobs + unused columns) before POSTing,
 * so the payload stays small even for thousands of orders.
 */
export async function GET(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json({ configured: false, orders: [], count: 0 });
  }
  const artist = req.nextUrl.searchParams.get("artist");
  if (!artist) {
    return Response.json({ error: "artist key required" }, { status: 400 });
  }
  // ?summary=1 → aggregate server-side, return only the portrait (a few KB)
  // instead of the multi-MB story blob.
  const summaryOnly = req.nextUrl.searchParams.get("summary") === "1";
  try {
    const orders = await loadArtistOrders(artist);
    if (summaryOnly) {
      return Response.json({
        configured: true,
        summary: summarizeOrders(orders),
        count: orders.length,
      });
    }
    return Response.json({ configured: true, orders, count: orders.length });
  } catch (err) {
    console.warn(
      "[ORDERS] GET",
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
    orders?: ArtistOrder[];
    mode?: "replace" | "append";
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
  if (!Array.isArray(body.orders) || body.orders.length === 0) {
    return Response.json({ error: "orders array required" }, { status: 400 });
  }
  // Chunked upload: the client splits a large catalog into ~2MB batches to stay
  // under Vercel's 4.5MB request-body limit. First batch replaces the artist's
  // orders; later batches append onto it.
  const mode = body.mode === "append" ? "append" : "replace";
  try {
    // Whitelist fields so a bloated client payload can't smuggle extra keys
    // into the stored blob. Drop rows missing the join key.
    const orders: ArtistOrder[] = body.orders
      .filter((o) => o && typeof o.userId === "string" && o.userId.trim())
      .map((o) => ({
        userId: String(o.userId).trim(),
        customerName: String(o.customerName ?? ""),
        occasion: String(o.occasion ?? ""),
        recipientName: String(o.recipientName ?? ""),
        relationship: String(o.relationship ?? ""),
        story: String(o.story ?? ""),
        songTitle: String(o.songTitle ?? ""),
        genre: String(o.genre ?? ""),
        rating:
          typeof o.rating === "number" && o.rating >= 1 && o.rating <= 5
            ? o.rating
            : null,
        orderDate: String(o.orderDate ?? ""),
        ...(o.audioId ? { audioId: String(o.audioId) } : {}),
      }));
    const toStore =
      mode === "append"
        ? (await loadArtistOrders(artist)).concat(orders)
        : orders;
    const { orderCount } = await upsertArtistOrders(artist, toStore);
    return Response.json({ configured: true, orderCount });
  } catch (err) {
    console.warn(
      "[ORDERS] POST",
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
  const artist = req.nextUrl.searchParams.get("artist");
  if (!artist) {
    return Response.json({ error: "artist key required" }, { status: 400 });
  }
  try {
    await deleteArtistOrders(artist);
    return Response.json({ configured: true, deleted: true });
  } catch (err) {
    console.warn(
      "[ORDERS] DELETE",
      err instanceof Error ? err.message : String(err),
    );
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
