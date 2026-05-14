import { Type } from "@google/genai";
import { fetchWikipedia, type WikipediaPage } from "./wikipedia";
import { fetchGenius, type GeniusArtist } from "./genius";
import { braveSearch } from "./brave";
import { fetchMany, fetchReadable } from "./jina";
import { generateWithRetry } from "./gemini";
import { getSpotifyInfo } from "./spotify";
import type { ArtistLocation, SpotifyInfo } from "./types";

export type DeepDiveFact = {
  fact: string;
  category:
    | "biographical"
    | "career"
    | "creative"
    | "collaborations"
    | "personal"
    | "trivia";
  source: string;
};

export type DeepDive = {
  artist: string;
  context: string;
  facts: DeepDiveFact[];
  sourcesChecked: string[];
  sourcesRejected: { url: string; reason: string }[];
  generatedAt: string;
};

// Below this monthly-listener count, the artist almost certainly doesn't have
// a real Wikipedia article — any match we get will be the wrong artist.
// Skip those general sources for small artists and trust only Spotify-direct data.
const FAMOUS_THRESHOLD = 50_000;

const DEEP_DIVE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    context: {
      type: Type.STRING,
      description: "One short paragraph (≤300 chars) framing what we found.",
    },
    facts: {
      type: Type.ARRAY,
      description: "8-20 facts. Each must have a source URL from the input.",
      items: {
        type: Type.OBJECT,
        properties: {
          fact: { type: Type.STRING },
          category: {
            type: Type.STRING,
            enum: [
              "biographical",
              "career",
              "creative",
              "collaborations",
              "personal",
              "trivia",
            ],
          },
          source: { type: Type.STRING },
        },
        required: ["fact", "category", "source"],
      },
    },
  },
  required: ["context", "facts"],
};

function compactWikipedia(page: WikipediaPage): string {
  const sections = page.sections
    .slice(0, 6)
    .map((s) => `## ${s.title}\n${s.text.slice(0, 1200)}`)
    .join("\n\n");
  return `WIKIPEDIA: ${page.title}
URL: ${page.url}

SUMMARY:
${page.summary}

SECTIONS:
${sections}`;
}

function compactGenius(g: GeniusArtist): string {
  const lines: string[] = [`GENIUS: ${g.name} (${g.url})`];
  if (g.description) {
    lines.push(`DESCRIPTION:\n${g.description.slice(0, 3000)}`);
  }
  if (g.alternate_names && g.alternate_names.length > 0) {
    lines.push(`ALTERNATE NAMES: ${g.alternate_names.join(", ")}`);
  }
  if (g.songs && g.songs.length > 0) {
    lines.push(
      `TOP SONGS:\n${g.songs
        .slice(0, 8)
        .map((s) => `- ${s.title} — ${s.url}`)
        .join("\n")}`,
    );
  }
  return lines.join("\n\n");
}

function compactArticle(url: string, content: string): string {
  return `ARTICLE: ${url}\n\n${content.slice(0, 6000)}`;
}

function compactSpotifyDirect(s: SpotifyInfo): string {
  const lines: string[] = [
    `SPOTIFY (authoritative — this is the actual Songfinch roster artist):`,
    `Name: ${s.name}`,
  ];
  if (s.monthlyListeners !== undefined && s.monthlyListeners !== null) {
    lines.push(`Monthly listeners: ${s.monthlyListeners.toLocaleString()}`);
  }
  if (s.followers !== undefined && s.followers !== null) {
    lines.push(`Followers: ${s.followers.toLocaleString()}`);
  }
  if (s.topCity) lines.push(`Top listening city: ${s.topCity}`);
  if (s.topCities && s.topCities.length > 1) {
    lines.push(`Top cities: ${s.topCities.map((c) => c.city).join(", ")}`);
  }
  if (s.biography) {
    lines.push(
      `\nOFFICIAL BIOGRAPHY (Spotify):\n${s.biography.slice(0, 3000)}`,
    );
  }
  if (s.topTracks && s.topTracks.length > 0) {
    lines.push(
      `\nTop tracks:\n${s.topTracks
        .slice(0, 8)
        .map(
          (t) =>
            `- ${t.name}${t.playcount ? ` (${t.playcount.toLocaleString()} plays)` : ""}`,
        )
        .join("\n")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Build a set of "anchor" tokens — track names, the artist name, alternate
 * spellings — that we can search for inside Wikipedia/Genius/Brave content
 * to verify the source is actually about THIS artist (not a famous one
 * sharing the name).
 */
function buildAnchors(name: string, spotify?: SpotifyInfo): string[] {
  const anchors = new Set<string>();
  anchors.add(name.toLowerCase());
  if (spotify?.name) anchors.add(spotify.name.toLowerCase());
  for (const t of spotify?.topTracks ?? []) {
    // Only use track names that are reasonably distinctive (3+ chars,
    // not generic words). Skip super-short tracks like "Up" or "Yes".
    const cleaned = (t.name ?? "").trim();
    if (cleaned.length >= 4) anchors.add(cleaned.toLowerCase());
  }
  return Array.from(anchors);
}

function validateSource(
  content: string,
  anchors: string[],
  minMatches = 1,
): { ok: boolean; matched: string[] } {
  if (anchors.length === 0) return { ok: false, matched: [] };
  const haystack = content.toLowerCase();
  const matched = anchors.filter((a) => haystack.includes(a));
  // Require at least N anchor matches — usually the artist's own name PLUS
  // at least one track. Single name match is weak (could still be wrong artist).
  return { ok: matched.length >= minMatches, matched };
}

export async function generateDeepDive(args: {
  name: string;
  location?: ArtistLocation;
  spotifyId?: string;
  bandsintownUrl?: string;
  spotify?: SpotifyInfo;
}): Promise<DeepDive> {
  // 1. Always anchor on Spotify identity if we have one.
  // If caller didn't pass a SpotifyInfo, fetch it now using the ID or name.
  let spotify = args.spotify ?? null;
  if (!spotify && (args.spotifyId || args.name)) {
    spotify = await getSpotifyInfo({
      name: args.name,
      spotifyUrl: args.spotifyId,
    });
  }

  const sourcesChecked: string[] = [];
  const sourcesRejected: { url: string; reason: string }[] = [];
  const blocks: string[] = [];

  // Spotify direct data is always trusted — it's authoritative.
  if (spotify) {
    blocks.push(compactSpotifyDirect(spotify));
    // Tag this source with a synthetic URL that Gemini can cite.
    const spotifyUrl = spotify.id
      ? `https://open.spotify.com/artist/${spotify.id}`
      : "spotify://about";
    sourcesChecked.push(spotifyUrl);
  }

  // 2. Fetch Spotify's externalLinks via Jina (artist's own website).
  // These are curated by Spotify/artist and are very reliable.
  // Skip socials (instagram/twitter etc.) — they're JS-heavy and bot-walled.
  const externalLinks = (
    (
      spotify as unknown as {
        externalLinks?: { name?: string; url?: string }[];
      }
    )?.externalLinks ?? []
  ).filter((l) => {
    const u = (l.url ?? "").toLowerCase();
    return (
      u &&
      !u.includes("instagram.com") &&
      !u.includes("twitter.com") &&
      !u.includes("x.com") &&
      !u.includes("facebook.com") &&
      !u.includes("tiktok.com") &&
      !u.includes("snapchat.com")
    );
  });

  if (externalLinks.length > 0) {
    const urls = externalLinks
      .slice(0, 2)
      .map((l) => l.url!)
      .filter(Boolean);
    const fetched = await fetchMany(urls, { maxChars: 5000, concurrency: 2 });
    for (const f of fetched) {
      blocks.push(
        `ARTIST OWN SITE (linked from Spotify — authoritative): ${f.url}\n\n${f.content}`,
      );
      sourcesChecked.push(f.url);
    }
  }

  // 3. Decide whether to consult Wikipedia/Genius/Brave at all.
  // Below the famous-threshold, name collisions are practically certain
  // to surface the wrong artist. Skip entirely.
  const famous =
    spotify?.monthlyListeners !== undefined &&
    spotify?.monthlyListeners !== null &&
    spotify.monthlyListeners >= FAMOUS_THRESHOLD;

  const anchors = buildAnchors(args.name, spotify ?? undefined);

  if (famous) {
    // Location-aware search hint
    const locHint = args.location
      ? args.location.beginArea ||
        args.location.area ||
        args.location.country ||
        undefined
      : undefined;
    const braveQuery = locHint
      ? `"${args.name}" ${locHint} musician interview`
      : `"${args.name}" musician interview`;

    const [wiki, genius, searchResults] = await Promise.all([
      fetchWikipedia(args.name),
      fetchGenius(args.name),
      braveSearch(braveQuery, 5),
    ]);

    // Validate Wikipedia
    if (wiki) {
      const text =
        wiki.summary + " " + wiki.sections.map((s) => s.text).join(" ");
      const { ok, matched } = validateSource(text, anchors, 2);
      if (ok) {
        blocks.push(compactWikipedia(wiki));
        sourcesChecked.push(wiki.url);
      } else {
        sourcesRejected.push({
          url: wiki.url,
          reason: `Wikipedia content didn't reference enough anchor terms (matched ${matched.length} of ${anchors.length}). Likely a different artist with the same name.`,
        });
      }
    }

    // Validate Genius
    if (genius) {
      const text =
        (genius.description ?? "") +
        " " +
        (genius.songs ?? []).map((s) => s.title).join(" ");
      const { ok, matched } = validateSource(text, anchors, 2);
      if (ok) {
        blocks.push(compactGenius(genius));
        sourcesChecked.push(genius.url);
      } else {
        sourcesRejected.push({
          url: genius.url,
          reason: `Genius content didn't reference enough anchor terms (matched ${matched.length}). Likely a different artist with the same name.`,
        });
      }
    }

    // Brave articles: fetch + validate each
    const articleUrls = searchResults
      .map((r) => r.url)
      .filter((u) => !/wikipedia\.org|genius\.com|spotify\.com/i.test(u))
      .filter(
        (u) => !/(instagram|facebook|tiktok|twitter|x\.com)\.com/i.test(u),
      )
      .slice(0, 3);

    if (articleUrls.length > 0) {
      const articles = await fetchMany(articleUrls, {
        maxChars: 6000,
        concurrency: 3,
      });
      for (const a of articles) {
        const { ok, matched } = validateSource(a.content, anchors, 2);
        if (ok) {
          blocks.push(compactArticle(a.url, a.content));
          sourcesChecked.push(a.url);
        } else {
          sourcesRejected.push({
            url: a.url,
            reason: `Article didn't reference enough anchor terms (matched ${matched.length}).`,
          });
        }
      }
    }
  }

  if (blocks.length === 0) {
    return {
      artist: args.name,
      context: spotify
        ? `Limited public sources for ${args.name}. ${spotify.monthlyListeners?.toLocaleString() ?? "Few"} monthly Spotify listeners; no verified Wikipedia/Genius/press matches.`
        : `No reliable sources found for ${args.name}. Could not anchor to a Spotify identity.`,
      facts: [],
      sourcesChecked,
      sourcesRejected,
      generatedAt: new Date().toISOString(),
    };
  }

  const prompt = `You are a music journalist preparing interview prep notes for the Songfinch roster artist named "${args.name}". Below are the only sources you can use. Extract SPECIFIC, SURPRISING facts that would make great Nardwuar-style interview questions.

CRITICAL — IDENTITY ANCHOR:
The authoritative identity is the SPOTIFY block above (if present). That artist IS the Songfinch artist. Other sources have been pre-validated to match this identity, but if any individual fact below looks like it could be about a more famous artist with the same name, OMIT IT. Better to return fewer facts than one wrong fact.

GROUNDING RULES (strict):
1. Every fact must be traceable to one of the URLs in the SOURCES below. Set 'source' to that exact URL.
2. NEVER invent facts.
3. Each fact must be the kind that makes the interviewee say "how did you know that?"
4. Specific details only: real venues, dates, song names, people, places.
5. If a fact could plausibly be about a more-famous artist sharing this name (e.g. Grammy wins, viral hits, major-label deals that don't fit a smaller indie's data), DO NOT include it.

SOURCES:

${blocks.join("\n\n=====\n\n")}

Return JSON matching the schema. Order: biographical first, then career, creative, collaborations, personal/trivia.`;

  const response = await generateWithRetry({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: DEEP_DIVE_SCHEMA,
      temperature: 0.3,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned empty deep-dive");

  let parsed: { context: string; facts: DeepDiveFact[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Gemini returned non-JSON deep-dive: ${text.slice(0, 200)}`,
    );
  }

  return {
    artist: args.name,
    context: parsed.context,
    facts: parsed.facts ?? [],
    sourcesChecked,
    sourcesRejected,
    generatedAt: new Date().toISOString(),
  };
}

// Re-export for type-only consumers
export type { fetchReadable };
