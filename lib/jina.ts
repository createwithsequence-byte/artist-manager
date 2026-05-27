const BASE = "https://r.jina.ai/";

/**
 * Jina Reader API — fetches any URL and returns it as clean LLM-friendly markdown.
 * Free with key for higher rate limits; no key works at lower rates.
 */
export async function fetchReadable(
  url: string,
  opts: { timeoutMs?: number; maxChars?: number } = {},
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);

  const headers: Record<string, string> = { Accept: "text/plain" };
  if (process.env.JINA_API_KEY) {
    headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  }

  try {
    const res = await fetch(`${BASE}${url}`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[JINA] ${url} → HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();
    return text.slice(0, opts.maxChars ?? 8000);
  } catch (err) {
    console.warn(
      `[JINA] ${url}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchMany(
  urls: string[],
  opts: { maxChars?: number; concurrency?: number } = {},
): Promise<{ url: string; content: string }[]> {
  const results: { url: string; content: string }[] = [];
  const concurrency = opts.concurrency ?? 3;

  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < urls.length) {
        const i = cursor++;
        const url = urls[i];
        const content = await fetchReadable(url, { maxChars: opts.maxChars });
        if (content) results.push({ url, content });
      }
    }),
  );
  return results;
}
