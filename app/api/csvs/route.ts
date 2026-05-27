import { isTursoConfigured } from "@/lib/db";
import { listCsvs } from "@/lib/reportStore";

export const runtime = "nodejs";

/**
 * GET /api/csvs — list every CSV that has saved reports in Turso, with
 * artist count + last-updated timestamp. Powers the "Recent runs" picker
 * on the app's empty state so coworkers can re-open a prior scout without
 * having the source CSV file on hand.
 */
export async function GET() {
  if (!isTursoConfigured()) {
    return Response.json({ configured: false, csvs: [] });
  }
  try {
    const csvs = await listCsvs();
    return Response.json({ configured: true, csvs });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
