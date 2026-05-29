import type { NextRequest } from "next/server";
import { isTursoConfigured } from "@/lib/db";
import {
  deleteCustomerDataset,
  listCustomerDatasets,
  loadCustomerDataset,
  loadCustomerDatasetRaw,
  upsertCustomerDataset,
  upsertCustomerDatasetRaw,
} from "@/lib/customers";
import type { CityAggregate, Customer } from "@/lib/customerCrossover";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/customers                 → { configured, datasets: meta[] }
 * GET /api/customers?id=master       → { configured, dataset: full }
 *
 * Mirrors the /api/library shape so the home page chip + /customers route
 * consume one consistent envelope.
 */
export async function GET(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json({ configured: false, datasets: [] });
  }
  const id = req.nextUrl.searchParams.get("id");
  const includeRaw = req.nextUrl.searchParams.get("raw") === "1";
  try {
    if (id) {
      const dataset = await loadCustomerDataset(id);
      // Raw rows lazy-loaded only when ?raw=1 is set — they can be
      // multi-megabyte for a real Songfinch dataset, and the globe / chip
      // surfaces never need them.
      const raw = includeRaw ? await loadCustomerDatasetRaw(id) : null;
      return Response.json({ configured: true, dataset, raw });
    }
    const datasets = await listCustomerDatasets();
    return Response.json({ configured: true, datasets });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/**
 * POST { id, name, aggregate, customerCount } → upsert.
 * id defaults to "master" so the canonical dataset is single-click upload.
 */
export async function POST(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json({ error: "Turso not configured" }, { status: 503 });
  }
  let body: {
    id?: string;
    name?: string;
    aggregate?: CityAggregate[];
    customerCount?: number;
    raw?: Customer[];
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.aggregate)) {
    return Response.json({ error: "aggregate[] required" }, { status: 400 });
  }
  const id = body.id?.trim() || "master";
  const name = body.name?.trim() || "Songfinch Customer Master";
  const customerCount = Number(body.customerCount) || 0;
  try {
    const result = await upsertCustomerDataset(
      id,
      name,
      body.aggregate,
      customerCount,
    );
    // Raw rows persisted iff the caller sent them. /customers page and
    // routing-sheet panel both send raw so the dataset is one source of
    // truth (aggregate + raw together, never out of sync).
    let rowCount = 0;
    if (Array.isArray(body.raw)) {
      const rawResult = await upsertCustomerDatasetRaw(id, body.raw);
      rowCount = rawResult.rowCount;
    }
    return Response.json({ ok: true, ...result, rowCount });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json({ error: "Turso not configured" }, { status: 503 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  try {
    await deleteCustomerDataset(id);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
