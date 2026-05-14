import type { SocialActivity } from "./types";
import { steelScrape } from "./steel";

async function scrape(url: string, delay = 5000): Promise<string> {
  try {
    const resp = await steelScrape(url, ["html"], delay);
    return resp.content.html || "";
  } catch {
    return "";
  }
}

function normalizeHandle(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(www\.)?(instagram|tiktok)\.com\//i, "")
    .replace(/^@/, "")
    .replace(/\/$/, "")
    .split("?")[0]
    .split("/")[0];
}

function relativeStatus(lastPostIso: string | undefined): string {
  if (!lastPostIso) return "UNKNOWN";
  const days = (Date.now() - new Date(lastPostIso).getTime()) / 86400000;
  if (days < 7) return "ACTIVE";
  if (days < 30) return "WARM";
  if (days < 90) return "COOLING";
  return "QUIET";
}

export async function checkSocials(args: {
  instagram?: string;
  tiktok?: string;
}): Promise<SocialActivity> {
  const result: SocialActivity = {};

  if (args.instagram) {
    const handle = normalizeHandle(args.instagram);
    const html = await scrape(`https://www.instagram.com/${handle}/`);
    const lastPost = extractInstagramLastPost(html);
    result.instagram = {
      handle,
      lastPost,
      status: relativeStatus(lastPost),
    };
  }

  if (args.tiktok) {
    const handle = normalizeHandle(args.tiktok);
    const url = handle.startsWith("@")
      ? `https://www.tiktok.com/${handle}`
      : `https://www.tiktok.com/@${handle}`;
    const html = await scrape(url, 7000);
    const lastPost = extractTikTokLastPost(html);
    result.tiktok = {
      handle: handle.replace(/^@/, ""),
      lastPost,
      status: relativeStatus(lastPost),
    };
  }

  return result;
}

function extractInstagramLastPost(html: string): string | undefined {
  if (!html) return undefined;
  const m = html.match(/"taken_at":\s*(\d{9,})/);
  if (m) return new Date(parseInt(m[1], 10) * 1000).toISOString().slice(0, 10);
  const datePub = html.match(/"datePublished":"(\d{4}-\d{2}-\d{2})/);
  if (datePub) return datePub[1];
  return undefined;
}

function extractTikTokLastPost(html: string): string | undefined {
  if (!html) return undefined;
  const m = html.match(/"createTime":\s*(\d{9,})/);
  if (m) return new Date(parseInt(m[1], 10) * 1000).toISOString().slice(0, 10);
  return undefined;
}
