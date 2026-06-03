import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import Groq from "groq-sdk";
import { loadModelCooldowns, recordModelCooldown } from "./db";

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

// In-memory cooldown cache. Each Vercel lambda lazily hydrates this from the
// shared `model_cooldown` table in Turso the first time generateWithRetry is
// called within its warm lifetime. Subsequent calls hit the cache directly
// (zero Turso latency on the hot path). When THIS lambda discovers a model
// exhaustion, it writes back to Turso so the next cold-starting lambda
// inherits the state instead of re-discovering it the hard way.
const _modelExhaustedAt = new Map<string, number>();
const MODEL_COOLDOWN_MS = 60 * 60 * 1000; // 1h — conservative; daily quota typically resets at midnight Pacific
let _cooldownsHydrated = false;
let _cooldownHydrationPromise: Promise<void> | null = null;

async function ensureCooldownsHydrated(): Promise<void> {
  if (_cooldownsHydrated) return;
  // Concurrent first-callers share a single hydration round-trip instead of
  // each issuing their own Turso SELECT. Pattern is "single-flight": the
  // first caller starts the promise, everyone else awaits the same one.
  if (!_cooldownHydrationPromise) {
    _cooldownHydrationPromise = (async () => {
      try {
        const rows = await loadModelCooldowns();
        for (const r of rows) {
          _modelExhaustedAt.set(r.model, r.exhausted_at_ms);
        }
        if (rows.length > 0) {
          console.warn(
            `[GEMINI] hydrated ${rows.length} cooldowns from Turso: ${rows.map((r) => r.model).join(", ")}`,
          );
        }
      } catch (err) {
        console.warn(
          "[GEMINI] cooldown hydration failed (continuing in-memory only):",
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        _cooldownsHydrated = true;
      }
    })();
  }
  await _cooldownHydrationPromise;
}

function isModelExhausted(model: string): boolean {
  const t = _modelExhaustedAt.get(model);
  return t !== undefined && Date.now() - t < MODEL_COOLDOWN_MS;
}

function markModelExhausted(model: string): void {
  const now = Date.now();
  _modelExhaustedAt.set(model, now);
  // Fire-and-forget Turso write so peer lambdas (warm and not-yet-spawned)
  // see this cooldown without having to re-discover it themselves. We do
  // NOT await — DB latency shouldn't slow the synth path, and the worst
  // case if this write fails is that other lambdas re-probe Gemini once
  // before discovering the wall, same as today.
  recordModelCooldown(model, now).catch((err) =>
    console.warn(
      `[GEMINI] recordCooldown(${model}) failed:`,
      err instanceof Error ? err.message : String(err),
    ),
  );
}

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

// Cerebras chain — third-tier fallback when both Gemini AND Groq are exhausted.
// Cerebras is a completely separate provider (independent billing entity →
// fresh quota pool) running open-weight models on custom silicon. ~2,700 tok/s
// — typically 10x faster than Groq, 50x faster than Gemini when quota-bouncing.
// Free tier: 14,400 RPD on gpt-oss-120b.
//
// IMPORTANT: gpt-oss-120b is a REASONING model — every response emits a
// `reasoning` chain-of-thought field followed by `content`. We only consume
// `content` for our JSON-shaped synth outputs and ignore `reasoning`.
const CEREBRAS_CHAIN = ["gpt-oss-120b", "zai-glm-4.7"];
const CEREBRAS_BASE = "https://api.cerebras.ai/v1";

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
 * Fallback to Cerebras when both Gemini AND Groq are exhausted.
 *
 * Cerebras uses an OpenAI-compatible REST API — we hit it via plain fetch
 * to avoid pulling in another SDK. The response shape is OpenAI-style
 * (`choices[0].message.content`) so we re-shape it to look like Gemini's
 * `GenerateContentResponse` for transparent caller substitution, same
 * pattern as `callGroq`.
 *
 * The gpt-oss-120b model is a reasoning model: its response includes a
 * `reasoning` field with chain-of-thought followed by `content` with the
 * actual answer. We only consume `content`.
 */
async function callCerebras(
  args: GeminiArgs,
): Promise<GenerateContentResponse> {
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) throw new Error("CEREBRAS_API_KEY not set");

  const prompt = promptFromGeminiArgs(args);
  const schema = args.config?.responseSchema;
  const wantsJson =
    args.config?.responseMimeType === "application/json" || !!schema;
  const schemaHint = schema
    ? `\n\nReturn ONLY a JSON object matching exactly this schema (no markdown fences, no prose):\n${JSON.stringify(schema, null, 2)}`
    : wantsJson
      ? "\n\nReturn ONLY a JSON object (no markdown fences, no prose)."
      : "";
  const temperature =
    typeof args.config?.temperature === "number"
      ? args.config.temperature
      : 0.3;

  let lastErr: unknown = null;
  for (const model of CEREBRAS_CHAIN) {
    try {
      const res = await fetch(`${CEREBRAS_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt + schemaHint }],
          response_format: wantsJson ? { type: "json_object" } : undefined,
          temperature,
          max_tokens: 4096,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const errText = await res.text();
        lastErr = new Error(
          `Cerebras ${model} HTTP ${res.status}: ${errText.slice(0, 200)}`,
        );
        // 429 = rate limit on this model; 404 = model not in our tier; both → try next
        if (res.status === 429 || res.status === 404 || res.status === 400) {
          console.warn(
            `[CEREBRAS] ${model} HTTP ${res.status}, trying next model`,
          );
          continue;
        }
        // 401/403 = auth — no point trying other models
        throw lastErr;
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = json.choices?.[0]?.message?.content ?? "";
      if (!text) {
        lastErr = new Error(`Cerebras ${model} returned empty content`);
        continue;
      }
      console.warn(`[CEREBRAS] answered via ${model}`);
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
      lastErr = err;
      console.warn(
        `[CEREBRAS] ${model} failed (${err instanceof Error ? err.message.slice(0, 120) : String(err)}), trying next model`,
      );
    }
  }
  throw lastErr ?? new Error("All Cerebras models in chain failed");
}

/**
 * Wrap a Gemini generateContent call with a three-tier provider fallback:
 *  1. Per-model retry on transient errors (503/timeouts), exponential backoff
 *  2. Daily-quota fallback chain across Gemini models (each has own quota)
 *  3. Cross-provider fallback to Groq chain (4 models × independent TPD pools)
 *     when all Gemini models are daily-exhausted
 *  4. Cross-provider fallback to Cerebras (gpt-oss-120b, 14,400 RPD free,
 *     independent billing entity → fresh quota pool) when both Gemini AND
 *     Groq are exhausted
 *
 * Effective daily ceiling on free tiers: ~1,450 (Gemini) + ~400k tokens
 * across Groq's 4 models + 14,400 calls on Cerebras ≈ ~17,000 useful synth
 * calls per day before any provider falls over.
 */
export async function generateWithRetry(
  args: GeminiArgs,
  opts: { retries?: number; baseDelayMs?: number } = {},
): Promise<GenerateContentResponse> {
  const retries = opts.retries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  const requestedModel = args.model;
  // Hydrate cooldown state from Turso once per lambda lifetime. Subsequent
  // calls within the same lambda hit the in-memory map directly. Without
  // this, every fresh lambda would burn ~3-5s on the model loop discovering
  // exhaustion the same upstream-talking way.
  await ensureCooldownsHydrated();
  const fullChain = [
    requestedModel,
    ...GEMINI_CHAIN.filter((m) => m !== requestedModel),
  ];
  // Skip models we've already learned are exhausted — either from this
  // lambda's prior calls OR from peer lambdas via the shared Turso cooldown
  // table. Big speedup on batches (resynth, scout) processing many artists.
  // With NO Gemini key configured, skip the chain entirely: calling the client
  // would throw a non-transient auth error that rethrows before the Groq/
  // Cerebras fallbacks below ever run. Empty chain → falls straight through.
  const modelsToTry = process.env.GEMINI_API_KEY
    ? fullChain.filter((m) => !isModelExhausted(m))
    : [];
  let lastErr: unknown = null;

  if (modelsToTry.length === 0) {
    console.warn(
      `[GEMINI] all models in cooldown (cached exhaustion), going direct to Groq`,
    );
  }

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
          markModelExhausted(model);
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
  let groqErr: unknown = null;
  if (groqClient()) {
    try {
      console.warn(
        `[GEMINI] all Gemini models exhausted, falling back to Groq Llama 3.3`,
      );
      return await callGroq(args);
    } catch (err) {
      groqErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[GROQ] fallback also failed: ${msg.slice(0, 200)}`);
      // Fall through to Cerebras tier.
    }
  }

  // Both Gemini AND Groq exhausted — try Cerebras (gpt-oss-120b on free tier,
  // 14,400 RPD, independent quota pool, ~10x faster than Groq).
  if (process.env.CEREBRAS_API_KEY) {
    try {
      console.warn(
        `[GEMINI] Groq also exhausted, falling back to Cerebras gpt-oss-120b`,
      );
      return await callCerebras(args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[CEREBRAS] fallback also failed: ${msg.slice(0, 200)}`);
      // Surface an aggregate error so debugging shows which providers failed.
      throw new Error(
        `All LLM providers failed. Gemini: ${lastErr instanceof Error ? lastErr.message.slice(0, 100) : "n/a"} | Groq: ${groqErr instanceof Error ? groqErr.message.slice(0, 100) : "n/a"} | Cerebras: ${msg.slice(0, 100)}`,
      );
    }
  }

  // No Cerebras configured: if Groq was tried and failed, surface BOTH causes
  // (the bare Gemini error alone hides that Groq was the actual final failure).
  if (groqErr) {
    throw new Error(
      `LLM fallback failed. Gemini: ${lastErr instanceof Error ? lastErr.message.slice(0, 120) : "n/a"} | Groq: ${groqErr instanceof Error ? groqErr.message.slice(0, 120) : String(groqErr).slice(0, 120)}`,
    );
  }
  throw lastErr;
}
