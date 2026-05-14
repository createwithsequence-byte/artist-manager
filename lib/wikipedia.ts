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
    if (!res.ok) return null;
    return (await res.json()) as WikipediaPage;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
