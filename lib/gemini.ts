import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import Groq from "groq-sdk";

let _gemini: GoogleGenAI | null = null;
let _groq: Groq | null = null;

export function geminiClient(): GoogleGenAI {
  if (!_gemini) {
    _gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return _gemini;
}

function groqClient(): Groq | null {
  if (!process.env.GROQ_API_KEY) return null;
  if (!_groq) {
    _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _groq;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Each Gemini model has its OWN daily quota — exhausting one doesn't block the
// next. Chain them in order before falling through to Groq.
const GEMINI_CHAIN = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
];

// Groq fallback chain — each model has its OWN token-per-day quota, so chaining
// them multiplies our daily capacity. Order: smartest first, then ramp down.
// 3.3-70b: best quality, 100k TPD
// 3.1-8b-instant: fast/light, separate ~500k TPD pool
// mixtral-8x7b: 175k TPD
// gemma2-9b-it: 500k TPD
const GROQ_CHAIN = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "mixtral-8x7b-32768",
  "gemma2-9b-it",
];

function isDailyQuotaError(msg: string): boolean {
  return (
    msg.includes("RESOURCE_EXHAUSTED") &&
    (msg.includes("per_day") ||
      msg.includes("RequestsPerDay") ||
      msg.includes("Quota exceeded") ||
      msg.includes("PerDay"))
  );
}

function isTransientError(msg: string): boolean {
  return (
    msg.includes("503") ||
    msg.includes("429") ||
    msg.includes("UNAVAILABLE") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("high demand") ||
    msg.includes("overloaded") ||
    msg.includes("timeout") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET")
  );
}

/**
 * Errors that are specific to the CURRENT model but might succeed on a
 * different model. Distinct from "give up entirely" errors (auth, request
 * format violations) where retrying a different model won't help.
 *
 * Treating these as model-specific lets us continue the fallback chain
 * instead of bailing on the first model that complains.
 */
function isModelSpecificError(msg: string): boolean {
  return (
    msg.includes("400") || // Bad request — often "context too large" on smaller models
    msg.includes("INVALID_ARGUMENT") ||
    msg.includes("FAILED_PRECONDITION") ||
    msg.includes("context") || // "context too large", "context length"
    msg.includes("safety") || // safety classifier blocks vary by model
    msg.includes("blocked") ||
    msg.includes("UNSUPPORTED")
  );
}

type GeminiArgs = Parameters<GoogleGenAI["models"]["generateContent"]>[0];

/**
 * Extract a plain-text prompt from Gemini's `contents` field for forwarding
 * to a different provider (Groq). Handles string or Content[] formats.
 */
function promptFromGeminiArgs(args: GeminiArgs): string {
  const c = args.contents as unknown;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return (part as { text: string }).text;
        }
        if (part && typeof part === "object" && "parts" in part) {
          const parts = (part as { parts: { text?: string }[] }).parts;
          return parts.map((p) => p.text ?? "").join("\n");
        }
        return "";
      })
      .join("\n");
  }
  return String(c ?? "");
}

/**
 * Fallback to Groq when all Gemini models are quota-exhausted.
 * Re-shapes the response to look like a Gemini `GenerateContentResponse` so
 * callers don't need to know which provider answered.
 */
function isGroqRateLimitError(msg: string): boolean {
  return (
    msg.includes("429") ||
    msg.includes("Rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("tokens per day") ||
    msg.includes("TPD") ||
    msg.includes("RPD")
  );
}

async function callGroq(args: GeminiArgs): Promise<GenerateContentResponse> {
  const groq = groqClient();
  if (!groq) throw new Error("No Groq client (GROQ_API_KEY not set)");

  const prompt = promptFromGeminiArgs(args);
  const schema = args.config?.responseSchema;
  const wantsJson =
    args.config?.responseMimeType === "application/json" || !!schema;

  // Inline the schema into the prompt so Groq knows the exact shape.
  const schemaHint = schema
    ? `\n\nReturn ONLY a JSON object matching exactly this schema (no markdown fences, no prose):\n${JSON.stringify(schema, null, 2)}`
    : wantsJson
      ? "\n\nReturn ONLY a JSON object (no markdown fences, no prose)."
      : "";

  // Try each Groq model in order — each has its own separate TPD quota, so a
  // chain dramatically multiplies our daily capacity vs. a single model.
  let lastGroqErr: unknown = null;
  for (const model of GROQ_CHAIN) {
    try {
      // gemma2 and mixtral don't support response_format json_object — only
      // llama variants do. Send the schema hint in prompt instead.
      const supportsJsonMode = model.startsWith("llama");
      const completion = await groq.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt + schemaHint }],
        response_format:
          wantsJson && supportsJsonMode ? { type: "json_object" } : undefined,
        temperature:
          typeof args.config?.temperature === "number"
            ? args.config.temperature
            : 0.3,
        max_completion_tokens: 4096,
      });

      const text = completion.choices[0]?.message?.content ?? "";
      if (!text) {
        lastGroqErr = new Error(`Groq ${model} returned empty content`);
        continue;
      }

      console.warn(`[GROQ] answered via ${model}`);
      return {
        text,
        candidates: [
          {
            content: { parts: [{ text }], role: "model" },
            finishReason: "STOP",
            index: 0,
          },
        ],
      } as unknown as GenerateContentResponse;
    } catch (err) {
      lastGroqErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (isGroqRateLimitError(msg)) {
        console.warn(`[GROQ] ${model} rate-limited, trying next model`);
        continue;
      }
      // Non-rate-limit error (auth, model deprecated, etc.) — try next anyway
      // since the chain's whole point is resilience.
      console.warn(
        `[GROQ] ${model} failed (${msg.slice(0, 120)}), trying next model`,
      );
    }
  }

  throw lastGroqErr ?? new Error("All Groq models in chain failed");
}

/**
 * Wrap a Gemini generateContent call with:
 *  1. Per-model retry on transient errors (503/timeouts), exponential backoff
 *  2. Daily-quota fallback chain across Gemini models (each has own quota)
 *  3. Cross-provider fallback to Groq Llama 3.3 (14,400 RPD) when all Gemini
 *     models are daily-exhausted
 */
export async function generateWithRetry(
  args: GeminiArgs,
  opts: { retries?: number; baseDelayMs?: number } = {},
): Promise<GenerateContentResponse> {
  const retries = opts.retries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  const requestedModel = args.model;
  const modelsToTry = [
    requestedModel,
    ...GEMINI_CHAIN.filter((m) => m !== requestedModel),
  ];
  let lastErr: unknown = null;

  for (const model of modelsToTry) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await geminiClient().models.generateContent({
          ...args,
          model,
        });
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);

        if (isDailyQuotaError(msg)) {
          console.warn(
            `[GEMINI] daily quota exhausted on ${model}, falling through`,
          );
          break;
        }

        if (isTransientError(msg) && attempt < retries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          console.warn(
            `[GEMINI] transient error on ${model} (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms`,
          );
          await sleep(delay);
          continue;
        }

        // Model-specific errors (400, context-too-large, safety blocks) →
        // try next model. They might succeed elsewhere in the chain.
        if (isModelSpecificError(msg)) {
          console.warn(
            `[GEMINI] model-specific error on ${model} (${msg.slice(0, 100)}), trying next model`,
          );
          break;
        }

        // Auth / config / unknown — give up the whole chain. Retrying a
        // different model won't fix an invalid API key.
        if (!isTransientError(msg)) throw err;
        break;
      }
    }
  }

  // All Gemini models exhausted — try Groq if available
  if (groqClient()) {
    try {
      console.warn(
        `[GEMINI] all Gemini models exhausted, falling back to Groq Llama 3.3`,
      );
      return await callGroq(args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[GROQ] fallback also failed: ${msg.slice(0, 200)}`);
      // Fall through and throw the original Gemini error so caller sees the
      // primary failure mode, not the secondary one.
    }
  }

  throw lastErr;
}
