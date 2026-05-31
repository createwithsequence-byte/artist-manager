import type { NextRequest } from "next/server";
import { Type } from "@google/genai";
import { generateWithRetry } from "@/lib/gemini";
import type { ChatMessage, TourChatResult } from "@/lib/tourChat";

export const runtime = "nodejs";
export const maxDuration = 60;

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    reply: {
      type: Type.STRING,
      description:
        "Conversational answer to the user, in a tour-manager's voice. Explain your reasoning. 1–4 short sentences unless they asked for more.",
    },
    proposedStops: {
      type: Type.ARRAY,
      description:
        "Concrete stops to ADD — either filling a gap between booked dates, OR forming a brand-new run in an open timeframe the user asked about (e.g. an October tour). Omit or empty only if the user just asked a question.",
      items: {
        type: Type.OBJECT,
        properties: {
          date: {
            type: Type.STRING,
            description:
              "YYYY-MM-DD. Gap-fill → falls between the two booked dates. New run → falls within the requested timeframe. Always obey blackout constraints.",
          },
          city: { type: Type.STRING },
          state: { type: Type.STRING, description: "2-letter state code" },
          reason: {
            type: Type.STRING,
            description: "one short line: why this stop",
          },
          venues: {
            type: Type.ARRAY,
            description:
              "2-3 SPECIFIC, real candidate venues in this city matching the user's requested venue type (e.g. named churches / Christian venues). Real venue names you know, not generic descriptions. Empty only if the user named no venue type.",
            items: { type: Type.STRING },
          },
        },
        required: ["date", "city", "state", "reason"],
      },
    },
  },
  required: ["reply"],
};

const SYSTEM = `You are an expert live-tour routing strategist for Songfinch. You help an artist decide WHERE to play to reach their existing customers (fans), reasoning over a snapshot of their tour + fan data. You do BOTH of these jobs:

  1. GAP-FILL — add shows in the open gaps BETWEEN already-booked dates.
  2. NEW RUN (from scratch) — when the user asks for a tour or leg in a timeframe that has few or no booked dates (e.g. "an October run", "a West Coast week in spring"), build a fresh sequence of fan-dense cities dated within that timeframe. This is a first-class part of your job — do NOT refuse it because the timeframe is outside the current booked dates.

You are given: anchored (booked) dates with venues, the gaps between them, fan-dense on-route fill candidates, and the top untapped fan markets. Reason like a tour manager.

CORE RULES:
- NEVER move, remove, or re-date an anchored (booked) date. You MAY add new dates before, after, or between them.
- Draw proposed cities from the fan data given — prefer on-route fill candidates for gaps, and the top untapped markets for new runs. Pick the densest fan cities that fit the user's constraints.
- For a NEW RUN, route it sensibly: order cities so consecutive drives are reasonable (geographically chained, not zig-zagging coast to coast), and space the dates across the requested window with rest days.
- USE DISTINCT CITIES. Never repeat a city unless the user explicitly asks for multiple nights / a residency. For a long run (e.g. 15-20 dates) draw WIDELY from the full untapped-markets list and expand the geography across multiple states/regions — do NOT loop the same handful of cities to pad the count. You are given a deep candidate list; use the breadth of it. If there genuinely aren't enough distinct fan cities for the requested date count, propose fewer and say so rather than repeating.
- Respect every constraint strictly:
  - "driving only / no flights" → keep consecutive legs drivable (~<450 mi/day); don't chain cross-country jumps in short windows.
  - blackout dates ("avoid August", "skip the first week") → never date a stop in that window.
  - regional focus ("Southeast only", "stay near Texas") → only propose stops in that region.
- VENUE TYPE ("church / Christian venues", "theaters", "festivals", "small rooms", "colleges"): for EACH proposed stop, fill the "venues" field with 2-3 SPECIFIC, real, NAMED venues you know in that city that match the requested type AND could plausibly host an artist of this scale — favor actual churches, Christian colleges/coffeehouses, fellowship halls, and listening rooms over stadium-sized megachurches that don't book indie acts. These are LEADS for the user to verify (capacity, availability, booking contact) — say so once in the "reply" (e.g. "venue leads to confirm"). NEVER refuse a venue-type ask or punt it back as "your booking call" — always give named starting points. Look at the venue names in the snapshot to match the artist's existing circuit.
- DATES: every proposed date is a real YYYY-MM-DD. Gap-fill → between the two booked dates. New run → within the timeframe the user asked about.
- If the user only asked a question, answer in "reply" and omit proposedStops.
- Keep "reply" tight and concrete — name cities, dates, fan counts, the route logic, and any honest caveat (like venue type). Never refuse something you can actually do.`;

function transcript(messages: ChatMessage[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "USER" : "AGENT"}: ${m.content}`)
    .join("\n");
}

export async function POST(req: NextRequest) {
  if (
    !process.env.GEMINI_API_KEY &&
    !process.env.GROQ_API_KEY &&
    !process.env.CEREBRAS_API_KEY
  ) {
    return Response.json(
      { error: "No LLM provider configured" },
      { status: 500 },
    );
  }

  let body: {
    context?: string;
    messages?: ChatMessage[];
    userMessage?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const userMessage = body.userMessage?.trim();
  if (!userMessage) {
    return Response.json({ error: "userMessage required" }, { status: 400 });
  }
  const history = Array.isArray(body.messages) ? body.messages.slice(-12) : [];

  const prompt = `${SYSTEM}

=== CURRENT TOUR SNAPSHOT ===
${body.context ?? "(no tour context provided)"}

=== CONVERSATION SO FAR ===
${history.length ? transcript(history) : "(start of conversation)"}

USER: ${userMessage}

Respond as JSON matching the schema. Reason over the snapshot + the user's message + any constraints stated earlier in the conversation.`;

  try {
    const res = await generateWithRetry({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        temperature: 0.4,
      },
    });
    const text = res.text;
    if (!text) throw new Error("Empty LLM response");
    let parsed: TourChatResult;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Fallback chain (Groq/Cerebras) occasionally wraps JSON in prose.
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("Non-JSON LLM response");
      parsed = JSON.parse(m[0]);
    }
    // Defensive: ensure shape + validate dates. The LLM can emit a malformed
    // or non-calendar "date" ("June 2026", "TBD"); drop those rather than let
    // them flow into the tour as a stop the spine can't place chronologically.
    const isValidDate = (d: string) =>
      /^\d{4}-\d{2}-\d{2}$/.test(d) &&
      !Number.isNaN(new Date(`${d}T00:00:00`).getTime());
    const result: TourChatResult = {
      reply: typeof parsed.reply === "string" ? parsed.reply : "(no reply)",
      proposedStops: Array.isArray(parsed.proposedStops)
        ? parsed.proposedStops
            .filter(
              (s) =>
                s &&
                typeof s.date === "string" &&
                isValidDate(s.date) &&
                typeof s.city === "string" &&
                s.city.trim().length > 0,
            )
            .map((s) => ({
              date: s.date,
              city: s.city,
              state: (s.state || "").toUpperCase().slice(0, 2),
              reason: s.reason ?? "",
              venues: Array.isArray(s.venues)
                ? s.venues
                    .filter(
                      (v): v is string => typeof v === "string" && !!v.trim(),
                    )
                    .slice(0, 3)
                : undefined,
            }))
        : undefined,
    };
    return Response.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[TOUR_CHAT]", msg);
    const friendly = /quota|rate|RESOURCE_EXHAUSTED|429/i.test(msg)
      ? "All LLM providers are rate-limited right now — try again in a minute."
      : "The agent hit an error. Try rephrasing, or retry in a moment.";
    return Response.json({ error: friendly }, { status: 502 });
  }
}
