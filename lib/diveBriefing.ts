import { Type } from "@google/genai";
import { generateWithRetry } from "./gemini";
import type { ArtistReport } from "./types";

export type DiveQuestion = {
  question: string;
  context: string;
  source: string;
};

export type ArtistDiveSummary = {
  name: string;
  oneLiner: string;
  questions: DiveQuestion[];
  topFact?: string;
};

export type DiveBriefing = {
  headline: string;
  summary: string;
  artists: ArtistDiveSummary[];
};

const DIVE_BRIEFING_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    headline: {
      type: Type.STRING,
      description:
        "Short headline framing this batch of interview prep (≤70 chars).",
    },
    summary: {
      type: Type.STRING,
      description:
        "1 sentence summarizing the cohort — e.g. 'Six indie-pop artists with strong tour activity; deep-cuts heavy on production stories and family history.'",
    },
    artists: {
      type: Type.ARRAY,
      description:
        "Per-artist briefings. Same order as input. Pick 3 strongest interview questions per artist drawn from their deep-dive facts.",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          oneLiner: {
            type: Type.STRING,
            description:
              "Single sentence framing this artist's most interesting hook for the interviewer.",
          },
          questions: {
            type: Type.ARRAY,
            description:
              "3 Nardwuar-style questions. Each derived from a real deep-cut fact. Phrased as questions ('Why did you...?' / 'Tell me about...').",
            items: {
              type: Type.OBJECT,
              properties: {
                question: {
                  type: Type.STRING,
                  description:
                    "The interview question — phrased as a question with a hook.",
                },
                context: {
                  type: Type.STRING,
                  description:
                    "1 line of context for the interviewer — the underlying fact and why it's interesting.",
                },
                source: {
                  type: Type.STRING,
                  description:
                    "URL where the fact came from (must match a source URL provided).",
                },
              },
              required: ["question", "context", "source"],
            },
          },
        },
        required: ["name", "oneLiner", "questions"],
      },
    },
  },
  required: ["headline", "summary", "artists"],
};

export async function generateDiveBriefing(
  reports: ArtistReport[],
): Promise<DiveBriefing> {
  // Only include artists who actually have a deep-dive
  const withDives = reports.filter(
    (r) => r.deepDive && r.deepDive.facts.length > 0,
  );

  if (withDives.length === 0) {
    return {
      headline: "No deep dives yet",
      summary: "Run a deep dive on at least one artist first.",
      artists: [],
    };
  }

  // Build compact input for Gemini — just the dive facts per artist
  const blocks = withDives
    .map((r) => {
      const d = r.deepDive!;
      const facts = d.facts
        .map(
          (f, i) =>
            `  ${i + 1}. [${f.category}] ${f.fact} (source: ${f.source})`,
        )
        .join("\n");
      return `ARTIST: ${r.name}
CONTEXT: ${d.context}
SOURCES: ${d.sourcesChecked.join(", ")}
FACTS:
${facts}`;
    })
    .join("\n\n=====\n\n");

  const prompt = `You're preparing an interview-prep digest for the Songfinch creative team. Below are deep-dive research notes on ${withDives.length} artists. For each, pick the 3 MOST surprising / interesting facts and turn them into Nardwuar-style interview questions — questions that make the artist say "how did you know that?"

GROUNDING RULE: Each question must be derived from a fact in the input. Set 'source' to that fact's source URL. Never invent.

VOICE: Direct, curious, specific. No "Tell us about your music" — go for the specific story. Examples of good questions:
- "Why did Etienne keep ordering soy bacon cheeseburgers at your work, Mandy?"
- "Walk us through recording 'Coffins' in your bedroom closet for those natural boomy sounds."
- "What happened in the vegan spring roll cook-off against X Ambassadors?"

INPUT:

${blocks}

Return JSON matching the schema. Same artist order as input. 3 questions per artist (or fewer if the dive facts are sparse).`;

  const response = await generateWithRetry({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: DIVE_BRIEFING_SCHEMA,
      temperature: 0.4,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned empty dive briefing");

  let parsed: DiveBriefing;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Gemini returned non-JSON dive briefing: ${text.slice(0, 200)}`,
    );
  }

  return {
    headline: parsed.headline,
    summary: parsed.summary,
    artists: parsed.artists ?? [],
  };
}
