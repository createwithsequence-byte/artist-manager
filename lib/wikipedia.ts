export type WikipediaPage = {
  title: string;
  url: string;
  summary: string;
  sections: { title: string; text: string }[];
};

const SIDECAR_BASE = process.env.SPOTIFY_SIDECAR_URL || "http://localhost:5001";

export async function fetchWikipedia(
  name: string,
): Promise<WikipediaPage | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(
      `${SIDECAR_BASE}/wikipedia?name=${encodeURIComponent(name)}`,
      { signal: controller.signal },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[WIKIPEDIA] ${name} → HTTP ${res.status}`);
      return null;
    }
    try {
      return (await res.json()) as WikipediaPage;
    } catch (parseErr) {
      console.warn(
        `[WIKIPEDIA] ${name} parse failed:`,
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      );
      return null;
    }
  } catch (err) {
    console.warn(
      `[WIKIPEDIA] ${name}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
