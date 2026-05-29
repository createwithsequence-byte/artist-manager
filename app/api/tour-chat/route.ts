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
        "Concrete stops to ADD between anchored dates. Omit or empty if the user only asked a question or no stop makes sense.",
      items: {
        type: Type.OBJECT,
        properties: {
          date: {
            type: Type.STRING,
            description:
              "YYYY-MM-DD, must fit the gap and obey blackout constraints",
          },
          city: { type: Type.STRING },
          state: { type: Type.STRING, description: "2-letter US state code" },
          reason: {
            type: Type.STRING,
            description: "one short line: why this stop",
          },
        },
        required: ["date", "city", "state", "reason"],
      },
    },
  },
  required: ["reply"],
};

const SYSTEM = `You are an expert live-tour routing strategist for Songfinch. You help decide where an artist should ADD shows BETWEEN their already-booked dates to maximize reaching existing customers, while obeying the real-world constraints the user gives you (driving vs flying, blackout dates, regional focus, venue type preferences, rest days, etc.).

You are given a snapshot of the current tour: anchored (booked) dates, the gaps between them, fan-dense on-route fill candidates, and untapped markets. Reason like a tour manager.

RULES:
- NEVER move, remove, or re-date an anchored date. Only ADD stops in the gaps.
- Prefer the provided on-route fill candidates (they already account for fan density + detour), but you may propose an untapped market if the user's constraints point there.
- Respect constraints strictly:
  - "driving only / no flights" → don't propose a stop that would force a flight (avoid huge mileage jumps in short windows; keep added legs drivable, ~<450 mi/day).
  - blackout dates ("avoid August", "festival hold July 12") → never put a proposed date in that window.
  - regional focus ("stay Northeast") → only propose stops in that region.
- Every proposed date must be a real YYYY-MM-DD that falls strictly BETWEEN the two anchored dates whose gap it fills.
- If the user is just asking a question or chatting, answer in "reply" and omit proposedStops.
- Keep "reply" tight and concrete — name cities, dates, fan counts, and the tradeoff. No filler.`;

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
    // Defensive: ensure shape.
    const result: TourChatResult = {
      reply: typeof parsed.reply === "string" ? parsed.reply : "(no reply)",
      proposedStops: Array.isArray(parsed.proposedStops)
        ? parsed.proposedStops
            .filter(
              (s) =>
                s && typeof s.date === "string" && typeof s.city === "string",
            )
            .map((s) => ({
              date: s.date,
              city: s.city,
              state: (s.state || "").toUpperCase().slice(0, 2),
              reason: s.reason ?? "",
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
