import type { NextRequest } from "next/server";
import { isTursoConfigured } from "@/lib/db";
import { loadReports, upsertReports } from "@/lib/reportStore";
import { synthesizeArtist } from "@/lib/synthesize";
import { normalizeReport } from "@/lib/normalize";
import type { ArtistReport, ScoutEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const CONCURRENCY = 2;

function ndjsonLine(event: ScoutEvent): string {
  return JSON.stringify(event) + "\n";
}

/**
 * Re-classify endpoint — re-runs ONLY the synth step on previously-scouted
 * artists, using data already saved in their Turso reports. Skips every
 * external API call (MusicBrainz, Spotify sidecar, setlist.fm, Ticketmaster,
 * social, etc.) so it's API-quota-friendly.
 *
 * Use case: after a scout run hit Gemini+Groq quota exhaustion and 90%+ of
 * artists ended up with the "AI synthesis unavailable" stub. Once quota
 * resets, hit this endpoint with the affected csv_name and it back-fills
 * proper signals + summary from the already-collected raw data.
 *
 * By default re-classifies ONLY stub-summary reports. Pass `?force=1` to
 * re-classify every report (use sparingly — burns LLM quota proportionally).
 *
 * Streams progress as NDJSON, same shape as /api/scout, so the UI can show
 * per-artist progress + counts in the existing ProgressPanel.
 */
export async function POST(req: NextRequest) {
  if (!isTursoConfigured()) {
    return Response.json({ error: "Turso not configured" }, { status: 503 });
  }
  if (!process.env.GEMINI_API_KEY) {
    return Response.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });
  }

  let body: { csv_name?: string; force?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const csvName = body.csv_name?.trim();
  if (!csvName) {
    return Response.json({ error: "csv_name required" }, { status: 400 });
  }

  const all = await loadReports(csvName);
  if (all.length === 0) {
    return Response.json(
      { error: `No reports found for csv_name="${csvName}"` },
      { status: 404 },
    );
  }

  const stubMarker = "AI synthesis unavailable";
  const isStub = (r: ArtistReport) =>
    typeof r.summary === "string" && r.summary.includes(stubMarker);
  const targets = body.force ? all : all.filter(isStub);

  if (targets.length === 0) {
    return Response.json({
      ok: true,
      message: "Nothing to re-classify (no stub-summary reports found)",
      total: all.length,
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (e: ScoutEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(ndjsonLine(e)));
        } catch {
          closed = true;
        }
      };

      const updated: ArtistReport[] = [];
      let cursor = 0;
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
          const i = cursor++;
          if (i >= targets.length) return;
          const r = targets[i];
          send({
            type: "start",
            artist: r.name,
            index: i,
            total: targets.length,
          });
          send({ type: "step", artist: r.name, step: "synthesizing" });
          try {
            const synth = await synthesizeArtist({
              name: r.name,
              releases: r.releases ?? [],
              followers: r.followers,
              bandsintownMarkdown: "", // no longer collected
              recentGigs: r.recentGigs ?? [],
              socialActivity: r.socialActivity,
              spotify: r.spotify,
              ticketmasterEvents: r.events ?? [],
            });
            const next = normalizeReport({
              ...r,
              summary: synth.summary,
              signals: synth.signals,
              notes: synth.notes,
            });
            updated.push(next);
            send({ type: "report", artist: r.name, report: next });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[RESYNTH] ${r.name} failed: ${msg}`);
            send({
              type: "error",
              artist: r.name,
              message:
                "Re-synth failed — LLM still exhausted or transient error.",
            });
          }
        }
      });

      try {
        await Promise.all(workers);
        // Persist all updates in a single batch upsert
        if (updated.length > 0) {
          await upsertReports(csvName, updated);
        }
        send({ type: "done" });
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {}
          closed = true;
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
