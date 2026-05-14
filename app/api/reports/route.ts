import type { NextRequest } from "next/server";
import { isTursoConfigured } from "@/lib/db";
import {
  countReports,
  deleteReports,
  loadReports,
  upsertReports,
} from "@/lib/reportStore";
import type { ArtistReport } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json({ configured: false, reports: [] });
  }
  const csvName = req.nextUrl.searchParams.get("csv_name");
  if (!csvName) {
    return Response.json(
      { error: "csv_name query param required" },
      { status: 400 },
    );
  }
  try {
    const reports = await loadReports(csvName);
    const total = await countReports(csvName);
    return Response.json({ configured: true, reports, total });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json({ error: "Turso not configured" }, { status: 503 });
  }
  const body = (await req.json()) as {
    csv_name?: string;
    reports?: ArtistReport[];
  };
  if (!body.csv_name) {
    return Response.json({ error: "csv_name required" }, { status: 400 });
  }
  if (!Array.isArray(body.reports)) {
    return Response.json({ error: "reports[] required" }, { status: 400 });
  }
  try {
    const result = await upsertReports(body.csv_name, body.reports);
    return Response.json({ ok: true, ...result });
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
  const csvName = req.nextUrl.searchParams.get("csv_name");
  if (!csvName) {
    return Response.json(
      { error: "csv_name query param required" },
      { status: 400 },
    );
  }
  try {
    const deleted = await deleteReports(csvName);
    return Response.json({ ok: true, deleted });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
