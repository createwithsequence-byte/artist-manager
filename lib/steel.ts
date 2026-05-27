import { createRateLimiter } from "./rate-limit";

const STEEL_BASE = "https://api.steel.dev/v1";

type SteelResponse = {
  content: { markdown?: string; html?: string };
  metadata: { statusCode?: number; title?: string; urlSource?: string };
  links?: { url: string; text: string }[];
};

// Steel hobby plan: 20/min. Use 4.5s min-interval (~13/min) to eliminate bursts.
const reserveSlot = createRateLimiter(15, 60_000, { minIntervalMs: 4500 });

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function parseRetryAfter(text: string): number {
  const m = text.match(/(\d+)\s*seconds?/i);
  if (m) return parseInt(m[1], 10) * 1000;
  return 5_000;
}

export async function steelScrape(
  url: string,
  format: ("markdown" | "html")[] = ["markdown"],
  delay = 0,
  retries = 1,
): Promise<SteelResponse> {
  const key = process.env.STEEL_API_KEY;
  if (!key) throw new Error("STEEL_API_KEY not set");

  await reserveSlot();

  const res = await fetch(`${STEEL_BASE}/scrape`, {
    method: "POST",
    headers: {
      "Steel-Api-Key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, format, delay }),
    signal: AbortSignal.timeout(25000),
  });

  if (res.status === 429 && retries > 0) {
    const text = await res.text();
    const wait = parseRetryAfter(text);
    console.warn(`[STEEL] 429, waiting ${wait}ms then retrying`);
    await sleep(wait + 250);
    return steelScrape(url, format, delay, retries - 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Steel ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export type BandsintownArtist = {
  id: number;
  name: string;
  followers: number;
  url: string;
  verified: boolean;
};

export async function findBandsintownArtist(
  query: string,
): Promise<BandsintownArtist | null> {
  const url = `https://www.bandsintown.com/searchSuggestions?searchTerm=${encodeURIComponent(
    query,
  )}&type=Artist`;
  const resp = await steelScrape(url, ["html"]);
  const html = resp.content.html || "";
  const match = html.match(/\[\{[^[\]]*?\}/);
  if (!match) return null;

  const endIdx = html.indexOf("}", match.index!);
  const chunk = html
    .slice(match.index! + 1, endIdx + 1)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');

  try {
    const a = JSON.parse(chunk);
    const followersText: string = a.trackerText || "";
    const followersMatch = followersText.match(/([\d,]+)/);
    const followers = followersMatch
      ? parseInt(followersMatch[1].replace(/,/g, ""), 10)
      : 0;
    return {
      id: a.id,
      name: a.name,
      followers,
      url: (a.href || "").split("?")[0],
      verified: !!a.verified,
    };
  } catch (err) {
    console.warn(
      `[BANDSINTOWN] parse failed for "${query}":`,
      err instanceof Error ? err.message : String(err),
      "chunk:",
      chunk.slice(0, 200),
    );
    return null;
  }
}

export async function getBandsintownPage(url: string): Promise<string> {
  const resp = await steelScrape(url, ["markdown"], 8000);
  return resp.content.markdown || "";
}
