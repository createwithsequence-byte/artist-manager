import type { NextRequest } from "next/server";
import { generateBriefing } from "@/lib/briefing";
import { critiqueBriefing } from "@/lib/critic";
import { postBriefingToSlack } from "@/lib/slack";
import type { ArtistReport } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!process.env.GEMINI_API_KEY) {
    return Response.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });
  }
  if (!process.env.SLACK_WEBHOOK_URL) {
    return Response.json(
      {
        error:
          "SLACK_WEBHOOK_URL not set. Create an incoming webhook at api.slack.com/apps, then add it to .env.local.",
      },
      { status: 500 },
    );
  }

  let body: {
    reports?: ArtistReport[];
    totalArtists?: number;
    previewOnly?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.reports || body.reports.length === 0) {
    return Response.json({ error: "No reports provided" }, { status: 400 });
  }

  try {
    const briefing = await generateBriefing(body.reports);

    // Groq second-pass critic — runs in parallel to keep total latency tight.
    const critiquePromise = critiqueBriefing(briefing, body.reports);

    if (body.previewOnly) {
      const critique = await critiquePromise;
      return Response.json({
        ok: true,
        briefing,
        critique,
        posted: false,
      });
    }

    const [critique, result] = await Promise.all([
      critiquePromise,
      postBriefingToSlack({
        briefing,
        totalArtists: body.totalArtists,
        reports: body.reports,
      }),
    ]);

    if (critique.issues.length > 0) {
      console.warn(
        `[CRITIC] ${critique.issues.length} issue(s) flagged on briefing:`,
        critique.issues,
      );
    }

    return Response.json({
      ok: result.ok,
      briefing,
      critique,
      posted: result.ok,
      error: result.error,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
