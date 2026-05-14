import Groq from "groq-sdk";
import type { Briefing, Callout } from "./briefing";
import type { ArtistReport } from "./types";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export type CritiqueIssue = {
  artist: string;
  issue: string;
  severity: "minor" | "major";
};

export type Critique = {
  approved: boolean;
  issues: CritiqueIssue[];
  rawText?: string;
};

/**
 * Lightweight second-pass critic.
 * Groq Llama-3.3 reviews the Gemini-generated briefing against the source
 * reports and flags any callouts that contradict or invent facts.
 *
 * Returns { approved, issues[] }. Caller decides whether to block posting
 * or just log warnings. Current behavior: log + pass through.
 */
export async function critiqueBriefing(
  briefing: Briefing,
  sourceReports: ArtistReport[],
): Promise<Critique> {
  if (!process.env.GROQ_API_KEY) {
    return { approved: true, issues: [] };
  }

  const allCallouts: Callout[] = [
    ...briefing.touringCallouts,
    ...briefing.releaseCallouts,
  ];
  if (allCallouts.length === 0) {
    return { approved: true, issues: [] };
  }

  // Build a lookup of source facts per named artist
  const sourceByName = new Map<string, ArtistReport>();
  for (const r of sourceReports) {
    sourceByName.set(r.name.toLowerCase(), r);
  }

  // Compact each cited artist's source facts so Groq has the truth to check against
  const calloutPayload = allCallouts
    .map((c) => {
      const source = sourceByName.get(c.name.toLowerCase());
      if (!source) {
        return `ARTIST: ${c.name}\nBRIEFING SAID: ${c.body}\nSOURCE: <NOT FOUND IN REPORTS>`;
      }
      const facts: string[] = [
        `signals: ${source.signals.join(", ")}`,
        `summary: ${source.summary}`,
      ];
      if (
        source.spotify?.monthlyListeners !== undefined &&
        source.spotify?.monthlyListeners !== null
      ) {
        facts.push(`monthly listeners: ${source.spotify.monthlyListeners}`);
      }
      if (source.followers !== undefined && source.followers !== null) {
        facts.push(`bandsintown followers: ${source.followers}`);
      }
      if (source.events.length > 0) {
        facts.push(
          `upcoming: ${source.events
            .slice(0, 5)
            .map((e) => `${e.date} ${e.venue} (${e.city})`)
            .join("; ")}`,
        );
      }
      if (source.recentGigs && source.recentGigs.length > 0) {
        facts.push(
          `past gigs: ${source.recentGigs
            .slice(0, 5)
            .map((g) => `${g.date} ${g.city}`)
            .join("; ")}`,
        );
      }
      if (source.releases.length > 0) {
        facts.push(
          `releases: ${source.releases
            .slice(0, 5)
            .map((r) => `${r.date} ${r.title}`)
            .join("; ")}`,
        );
      }
      if (source.spotify?.topTracks && source.spotify.topTracks.length > 0) {
        const top = source.spotify.topTracks[0];
        facts.push(
          `top track: ${top.name}${top.playcount ? ` (${top.playcount} plays)` : ""}`,
        );
      }
      if (source.notes) facts.push(`notes: ${source.notes}`);
      return `ARTIST: ${c.name}\nBRIEFING SAID: ${c.body}\nSOURCE FACTS: ${facts.join(" | ")}`;
    })
    .join("\n\n---\n\n");

  const prompt = `You are a fact-checker reviewing an editorial briefing about a music roster. For each callout below, compare the BRIEFING SAID against the SOURCE FACTS and flag anything that is:
- INVENTED (mentions a venue/date/number that doesn't appear in the source)
- CONTRADICTED (claims something that conflicts with the source — e.g. "actively touring" when the source shows 0 gigs)
- WRONG NUMBER (listener count, play count, or follower count differs from source)

Do NOT flag stylistic choices. Do NOT flag missing details. Only flag concrete factual errors.

If everything is fine, return { "issues": [] } — an empty array. Do NOT add entries with severity "none" or "no issues" — just leave the array empty.

CALLOUTS:

${calloutPayload}

Return JSON: { "issues": [{ "artist": "...", "issue": "short description", "severity": "minor" | "major" }] }. Return empty array if everything checks out.`;

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
      max_completion_tokens: 1024,
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let parsed: { issues?: (CritiqueIssue & { severity?: string })[] } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { approved: true, issues: [], rawText: raw };
    }
    // Groq sometimes emits severity: "none" entries when no issues found.
    // Filter to real issues only (minor or major).
    const allIssues = parsed.issues ?? [];
    const realIssues = allIssues.filter(
      (i) => i.severity === "minor" || i.severity === "major",
    ) as CritiqueIssue[];
    const hasMajor = realIssues.some((i) => i.severity === "major");
    return {
      approved: !hasMajor,
      issues: realIssues,
      rawText: raw,
    };
  } catch (err) {
    console.warn(
      "[CRITIC] groq failed:",
      err instanceof Error ? err.message : err,
    );
    return { approved: true, issues: [] };
  }
}
