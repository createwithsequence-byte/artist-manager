import { Type } from "@google/genai";
import { generateWithRetry } from "./gemini";
import type {
  ArtistReport,
  Release,
  Signal,
  RecentGig,
  SocialActivity,
  SpotifyInfo,
  Event as ArtistEvent,
} from "./types";

// JSON Schema describing the artist report shape we want back.
// Gemini's responseSchema enforces this on the model output.
const REPORT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description:
        "One tight sentence (≤220 chars) weaving the most important signals together. Lead with the strongest. Use only facts present in the input data.",
    },
    signals: {
      type: Type.ARRAY,
      items: {
        type: Type.STRING,
        enum: [
          "active-touring",
          "between-cycles",
          "recent-release",
          "industry-writer",
          "quiet",
          "new-artist",
        ],
      },
    },
    events: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          date: {
            type: Type.STRING,
            description: "ISO date YYYY-MM-DD or YYYY-MM",
          },
          venue: { type: Type.STRING },
          city: { type: Type.STRING },
          ticketUrl: { type: Type.STRING },
          withArtist: {
            type: Type.STRING,
            description: "If opening for / billed with another artist",
          },
        },
        required: ["date", "venue", "city"],
      },
    },
    notes: {
      type: Type.STRING,
      description:
        "Optional 1-2 sentence context. Only facts visible in the input. Empty string if nothing.",
    },
  },
  required: ["summary", "signals", "events"],
};

// Null/undefined-safe number formatter — fixes prior crashes on missing stats.
function fmt(n: number | null | undefined): string | null {
  return typeof n === "number" && !Number.isNaN(n) ? n.toLocaleString() : null;
}

export async function synthesizeArtist(args: {
  name: string;
  releases: Release[];
  followers?: number | null;
  bandsintownMarkdown: string;
  recentGigs?: RecentGig[];
  socialActivity?: SocialActivity;
  spotify?: SpotifyInfo;
  ticketmasterEvents?: ArtistEvent[];
}): Promise<Pick<ArtistReport, "summary" | "signals" | "events" | "notes">> {
  const today = new Date().toISOString().slice(0, 10);

  const gigsBlock =
    args.recentGigs && args.recentGigs.length > 0
      ? args.recentGigs
          .slice(0, 15)
          .map(
            (g) =>
              `  ${g.date} | ${g.venue} | ${g.city}${g.country ? `, ${g.country}` : ""}`,
          )
          .join("\n")
      : "(no setlist data in last 90 days)";

  const socialBlock = args.socialActivity
    ? [
        args.socialActivity.instagram
          ? `  Instagram: last post ${args.socialActivity.instagram.lastPost ?? "?"} (${args.socialActivity.instagram.status})`
          : "",
        args.socialActivity.tiktok
          ? `  TikTok: last post ${args.socialActivity.tiktok.lastPost ?? "?"} (${args.socialActivity.tiktok.status})`
          : "",
      ]
        .filter(Boolean)
        .join("\n") || "(no social signals)"
    : "(not checked)";

  const s = args.spotify;
  const spotifyBlock = s
    ? [
        fmt(s.monthlyListeners)
          ? `  Monthly listeners: ${fmt(s.monthlyListeners)}`
          : "",
        fmt(s.followers) ? `  Spotify followers: ${fmt(s.followers)}` : "",
        s.topCity ? `  Top listening city: ${s.topCity}` : "",
        s.topCities && s.topCities.length > 1
          ? `  Top cities: ${s.topCities.map((c) => c.city).join(", ")}`
          : "",
        s.verified ? `  Verified: yes` : "",
        s.topTracks && s.topTracks.length
          ? `  Top tracks:\n${s.topTracks
              .slice(0, 5)
              .map(
                (t) =>
                  `    - ${t.name}${fmt(t.playcount) ? ` (${fmt(t.playcount)} plays)` : ""}`,
              )
              .join("\n")}`
          : "",
        s.latestRelease?.name
          ? `  Latest release on Spotify: ${s.latestRelease.name} (${s.latestRelease.type ?? "release"}, ${s.latestRelease.date ?? "?"})`
          : "",
        s.concerts && s.concerts.length
          ? `  Upcoming Spotify-federated concerts (from Bandsintown via Spotify):\n${s.concerts
              .slice(0, 10)
              .map((c) => `    - ${c.date} | ${c.venue} | ${c.city}`)
              .join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n") || "(no Spotify data)"
    : "(Spotify sidecar unreachable or not run)";

  const prompt = `Today is ${today}.

ARTIST: ${args.name}
${fmt(args.followers) ? `BANDSINTOWN FOLLOWERS: ${fmt(args.followers)}` : ""}

SPOTIFY (via SpotAPI):
${spotifyBlock}

RECENT RELEASES (last 24mo, from MusicBrainz):
${args.releases.length === 0 ? "(none in last 24 months)" : args.releases.map((r) => `  ${r.date} | ${r.type} | ${r.title}`).join("\n")}

PAST GIGS (last 90 days, from setlist.fm — strong signal of "actively touring right now"):
${gigsBlock}

UPCOMING TICKETMASTER EVENTS (structured, authoritative — use these as primary truth):
${
  args.ticketmasterEvents && args.ticketmasterEvents.length > 0
    ? args.ticketmasterEvents
        .slice(0, 20)
        .map(
          (e) =>
            `  ${e.date} | ${e.venue} | ${e.city}${e.ticketUrl ? ` · ${e.ticketUrl}` : ""}`,
        )
        .join("\n")
    : "(no Ticketmaster events found — artist may not sell through Ticketmaster/Live Nation)"
}

UPCOMING BANDSINTOWN PAGE (raw markdown — extract upcoming events only, but TICKETMASTER above is more reliable):
${args.bandsintownMarkdown.slice(0, 5000) || "(no Bandsintown page — Cloudflare currently blocks Steel)"}

SOCIAL ACTIVITY:
${socialBlock}

CRITICAL GROUNDING RULE: Only state facts that appear in the data blocks above. Do NOT use your training knowledge about this artist. If the data blocks are sparse, your summary should also be sparse — say "limited recent data" rather than inventing specifics. Never name a venue, city, date, or tour that doesn't appear verbatim above.

INSTRUCTIONS:
1. Extract structured UPCOMING events from the Bandsintown markdown if present (date + venue + city). Skip past dates. The orchestrator will merge these with Ticketmaster + Spotify-federated events post-synthesis, so don't worry about duplicating them.
2. Choose signals based ONLY on what's in the data. Consider events from ALL THREE upcoming sources (Ticketmaster, Spotify-federated concerts, Bandsintown markdown) when judging tour activity:
   - "active-touring": 3+ past gigs in last 90 days from setlist.fm, OR 1+ upcoming dates listed in ANY of the upcoming-events sources above (Ticketmaster, Spotify-federated, or Bandsintown markdown)
   - "recent-release": release date in the LAST 30 DAYS OR an UPCOMING release date in the NEXT 90 DAYS appears in the releases list. (Tight window — not "any release in last 90 days".)
   - "between-cycles": releases exist outside the 30d-past/90d-future window AND no past gigs in 90d AND no upcoming tours in any source
   - "industry-writer": only singles in release list / no live activity / low Spotify monthly listeners (<5k)
   - "quiet": no releases in 12+ months AND no past gigs in 90d AND no upcoming dates anywhere
   - "new-artist": very sparse data overall (< 2 releases, < 1k Spotify monthly listeners)
   An artist can have MULTIPLE signals — e.g. an artist with a recent release AND upcoming tour dates gets BOTH "recent-release" AND "active-touring".
3. Summary: one tight sentence using only facts above. If data is sparse, say "limited recent data" — do not pad.
4. Notes: optional but ONLY facts visible above. No training-data recall.

Return JSON matching the schema.`;

  const response = await generateWithRetry({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: REPORT_SCHEMA,
      temperature: 0.2,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned empty response");

  let parsed: {
    summary: string;
    signals: Signal[];
    events: ArtistReport["events"];
    notes?: string;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned non-JSON: ${text.slice(0, 200)}`);
  }

  return {
    summary: parsed.summary,
    signals: parsed.signals ?? [],
    events: parsed.events ?? [],
    notes: parsed.notes && parsed.notes.trim() ? parsed.notes : undefined,
  };
}
