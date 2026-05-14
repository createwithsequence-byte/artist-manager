import { Type } from "@google/genai";
import { generateWithRetry } from "./gemini";
import type { ArtistReport, Signal } from "./types";

export type Callout = { name: string; body: string };

export type BriefingStats = {
  total: number;
  activeTouring: number;
  recentRelease: number;
  industryWriter: number;
  betweenCycles: number;
  quiet: number;
  newArtist: number;
};

export type Briefing = {
  headline: string;
  summary: string;
  stats: BriefingStats;
  touringCallouts: Callout[];
  releaseCallouts: Callout[];
  closer?: string;
};

const BRIEFING_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    headline: {
      type: Type.STRING,
      description:
        "Short headline (≤70 chars). Frame the week. E.g. 'Tori arena tour kicks off + 4 new releases this week.'",
    },
    summary: {
      type: Type.STRING,
      description:
        "1-2 sentence framing of the roster state. Plain language. No bullet lists.",
    },
    touringCallouts: {
      type: Type.ARRAY,
      description:
        "Artists actively touring. Prioritize: confirmed upcoming dates, recent past gigs, festival appearances. Order most-newsworthy first.",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          body: {
            type: Type.STRING,
            description:
              "1-2 sentences. Specific. Real venue names, dates, cities, listener counts.",
          },
        },
        required: ["name", "body"],
      },
    },
    releaseCallouts: {
      type: Type.ARRAY,
      description:
        "Artists with releases in the last 30 days OR upcoming in next 90 days. Prioritize: highest listener counts, biggest play counts, fresh drops.",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          body: {
            type: Type.STRING,
            description:
              "1-2 sentences. Real release names + dates + listener/play counts.",
          },
        },
        required: ["name", "body"],
      },
    },
    closer: {
      type: Type.STRING,
      description:
        "Optional one-sentence pattern observation across the roster. Empty if nothing.",
    },
  },
  required: ["headline", "summary", "touringCallouts", "releaseCallouts"],
};

function computeStats(reports: ArtistReport[]): BriefingStats {
  const count = (sig: Signal) =>
    reports.filter((r) => r.signals.includes(sig)).length;
  return {
    total: reports.length,
    activeTouring: count("active-touring"),
    recentRelease: count("recent-release"),
    industryWriter: count("industry-writer"),
    betweenCycles: count("between-cycles"),
    quiet: count("quiet"),
    newArtist: count("new-artist"),
  };
}

function fmt(n: number | null | undefined): string | null {
  return typeof n === "number" && !Number.isNaN(n) ? n.toLocaleString() : null;
}

function compactReport(r: ArtistReport): string {
  const sp = r.spotify;
  const parts: string[] = [
    `${r.name} [${r.signals.join(", ")}]`,
    `summary: ${r.summary}`,
  ];
  if (fmt(sp?.monthlyListeners)) {
    parts.push(`monthly listeners: ${fmt(sp?.monthlyListeners)}`);
  }
  if (sp?.topCity) parts.push(`top city: ${sp.topCity}`);
  if (sp?.topTracks && sp.topTracks.length > 0) {
    const top = sp.topTracks[0];
    parts.push(
      `top track: ${top.name}${fmt(top.playcount) ? ` (${fmt(top.playcount)} plays)` : ""}`,
    );
  }
  if (fmt(r.followers)) parts.push(`bandsintown: ${fmt(r.followers)}`);
  if (r.events.length > 0) {
    parts.push(
      `upcoming: ${r.events
        .slice(0, 5)
        .map((e) => `${e.date} ${e.venue} (${e.city})`)
        .join("; ")}`,
    );
  }
  if (r.recentGigs && r.recentGigs.length > 0) {
    parts.push(
      `past 90d gigs: ${r.recentGigs.length} — ${r.recentGigs
        .slice(0, 3)
        .map((g) => `${g.date} ${g.city}`)
        .join("; ")}`,
    );
  }
  if (r.releases.length > 0) {
    const recent = r.releases.slice(0, 3);
    parts.push(
      `releases: ${recent.map((rl) => `${rl.date} ${rl.title}`).join("; ")}`,
    );
  }
  if (r.notes) parts.push(`notes: ${r.notes}`);
  return parts.join(" | ");
}

export async function generateBriefing(
  reports: ArtistReport[],
): Promise<Briefing> {
  const stats = computeStats(reports);

  if (reports.length === 0) {
    return {
      headline: "No reports yet",
      summary: "Scout some artists first.",
      stats,
      touringCallouts: [],
      releaseCallouts: [],
    };
  }

  const newsworthy = reports.filter(
    (r) =>
      r.signals.includes("active-touring") ||
      r.signals.includes("recent-release"),
  );

  if (newsworthy.length === 0) {
    return {
      headline: "Quiet week — no touring or recent releases",
      summary: `${reports.length} artists scouted. None have confirmed touring activity or releases in the last 30 days / next 90 days.`,
      stats,
      touringCallouts: [],
      releaseCallouts: [],
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const lines = newsworthy.map((r) => `- ${compactReport(r)}`).join("\n");

  const prompt = `Today: ${today}

NEWSWORTHY ARTISTS (${newsworthy.length} of ${reports.length} scouted have ACTIVE_TOURING or RECENT_RELEASE signals):
${lines}

Write a producer's briefing for the Songfinch creative team. Voice: direct, editorial, useful — like a music industry weekly newsletter, not a corporate update.

Rules:
1. Only use facts present above. Never invent venues, dates, listener counts, or track names.
2. Split callouts into TWO groups: touringCallouts (active tour activity) and releaseCallouts (releases in last 30 days OR upcoming in next 90 days). An artist with BOTH signals can appear in EITHER group based on which signal is more newsworthy — don't duplicate.
3. Prioritize ruthlessly. If a tour has 30 dates + arenas, lead with it. If a release has 2M+ plays, lead with it. Don't include every artist — pick the 8-12 worth a producer's time.
4. Each body is 1-2 sentences. Specific. Real venue names, real dates, real numbers.
5. Skip pleasantries. No "Great news!" — just say what's true.
6. Headline should reflect what's actually noteworthy this week.

Return JSON matching the schema.`;

  const response = await generateWithRetry({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: BRIEFING_SCHEMA,
      temperature: 0.3,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned empty briefing");

  let parsed: {
    headline: string;
    summary: string;
    touringCallouts: Callout[];
    releaseCallouts: Callout[];
    closer?: string;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned non-JSON briefing: ${text.slice(0, 200)}`);
  }

  return {
    headline: parsed.headline,
    summary: parsed.summary,
    stats,
    touringCallouts: parsed.touringCallouts ?? [],
    releaseCallouts: parsed.releaseCallouts ?? [],
    closer: parsed.closer && parsed.closer.trim() ? parsed.closer : undefined,
  };
}
