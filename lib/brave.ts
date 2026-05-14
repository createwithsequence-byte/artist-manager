const BASE = "https://api.search.brave.com/res/v1/web/search";

export type BraveResult = {
  title: string;
  url: string;
  description?: string;
};

type BraveResponse = {
  web?: {
    results?: {
      title: string;
      url: string;
      description?: string;
    }[];
  };
};

export async function braveSearch(
  query: string,
  count = 5,
): Promise<BraveResult[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return [];

  const url = `${BASE}?q=${encodeURIComponent(query)}&count=${count}`;
  try {
    const res = await fetch(url, {
      headers: {
        "X-Subscription-Token": key,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[BRAVE] ${res.status}`);
      return [];
    }
    const data = (await res.json()) as BraveResponse;
    return (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
    }));
  } catch (err) {
    console.warn(
      "[BRAVE] search failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}
