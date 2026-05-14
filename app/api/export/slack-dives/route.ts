import type { NextRequest } from "next/server";
import { generateDiveBriefing } from "@/lib/diveBriefing";
import { postDiveBriefingToSlack } from "@/lib/slack";
import type { ArtistReport } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!process.env.GEMINI_API_KEY) {
    return Response.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });
  }
  if (!process.env.SLACK_WEBHOOK_URL) {
    return Response.json(
      { error: "SLACK_WEBHOOK_URL not set" },
      { status: 500 },
    );
  }

  const body = (await req.json()) as {
    reports: ArtistReport[];
    previewOnly?: boolean;
  };

  if (!body.reports || body.reports.length === 0) {
    return Response.json({ error: "No reports provided" }, { status: 400 });
  }

  const withDives = body.reports.filter(
    (r) => r.deepDive && r.deepDive.facts.length > 0,
  );
  if (withDives.length === 0) {
    return Response.json(
      { error: "None of the provided reports have a deep dive yet" },
      { status: 400 },
    );
  }

  try {
    const briefing = await generateDiveBriefing(withDives);

    if (body.previewOnly) {
      return Response.json({ ok: true, briefing, posted: false });
    }

    const result = await postDiveBriefingToSlack({ briefing });
    return Response.json({
      ok: result.ok,
      briefing,
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
