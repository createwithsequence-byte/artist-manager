import type { NextRequest } from "next/server";
import { findArtist, getRecentReleases } from "@/lib/musicbrainz";
import { findBandsintownArtist, getBandsintownPage } from "@/lib/steel";
import { getRecentGigs } from "@/lib/setlistfm";
import { checkSocials } from "@/lib/social";
import { getSpotifyInfo } from "@/lib/spotify";
import { getEventsForArtist } from "@/lib/ticketmaster";
import { synthesizeArtist } from "@/lib/synthesize";
import type {
  ArtistInput,
  ArtistReport,
  ScoutEvent,
  SocialActivity,
} from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const CONCURRENCY = 2;

function ndjsonLine(event: ScoutEvent): string {
  return JSON.stringify(event) + "\n";
}

/**
 * Translate cryptic upstream errors into a one-line message for the UI.
 * Detect daily-quota exhaustion specifically so users know it's not a bug.
 */
function humanizeError(msg: string): string {
  if (
    msg.includes("RESOURCE_EXHAUSTED") &&
    (msg.includes("per_day") ||
      msg.includes("PerDay") ||
      msg.includes("Quota exceeded"))
  ) {
    return "Daily LLM quota exhausted across all configured models. Resets at UTC midnight. (Gemini + Groq fallback both depleted.)";
  }
  if (msg.includes("RESOURCE_EXHAUSTED")) {
    return "LLM rate-limited momentarily. Will recover; retry in a minute.";
  }
  if (msg.includes("Controller is already closed")) {
    return "Stream was cancelled by client (PAUSE or refresh).";
  }
  // Trim absurdly long stack traces — keep first line + 200 chars
  const firstLine = msg.split("\n")[0];
  return firstLine.length > 200 ? firstLine.slice(0, 200) + "…" : firstLine;
}

// Tolerant wrapper: log + continue with default on per-layer failures.
async function soft<T>(
  step: string,
  name: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[SCOUT] ${name} · ${step} soft-failed: ${msg}`);
    return fallback;
  }
}

async function processArtist(
  input: ArtistInput,
  index: number,
  total: number,
  send: (e: ScoutEvent) => void,
  opts: { withSocials: boolean },
): Promise<void> {
  const name = input.name.trim();
  send({ type: "start", artist: name, index, total });

  try {
    send({ type: "step", artist: name, step: "musicbrainz" });
    // Pass CSV's Spotify URL so MB requires url-relationship match — kills
    // "Tori" → "Tori Kelly" identity poisoning.
    const mbMatch = await soft(
      "musicbrainz",
      name,
      () => findArtist(name, input.spotifyUrl),
      null,
    );
    const mbid = mbMatch?.mbid ?? null;
    const location = mbMatch?.location;
    const releases = mbid
      ? await soft("releases", name, () => getRecentReleases(mbid, 24), [])
      : [];

    send({ type: "step", artist: name, step: "spotify" });
    const spotify = await soft(
      "spotify",
      name,
      () => getSpotifyInfo({ name, spotifyUrl: input.spotifyUrl }),
      null,
    );

    send({ type: "step", artist: name, step: "setlistfm" });
    const recentGigs = mbid
      ? await soft("setlistfm", name, () => getRecentGigs(mbid, 90), [])
      : [];

    // Bandsintown direct (via Steel) is Cloudflare-blocked since May 2026.
    // Every call burns 30s+ waiting for a Steel timeout before the soft-fail
    // wrapper continues. Across 1,800+ artists that's ~7 hours of dead time
    // per scout run. We get the same tour data via Spotify's federated
    // `goods.concerts` field (Spotify pulls from Bandsintown server-side),
    // so disabling the direct path costs us nothing but the follower count.
    //
    // Set ENABLE_BANDSINTOWN_DIRECT=1 in env to re-enable if Cloudflare
    // ever lets Steel through again.
    const useBandsintown = process.env.ENABLE_BANDSINTOWN_DIRECT === "1";
    let bit: { url: string; followers?: number } | null = null;
    let bandsintownMarkdown = "";
    if (useBandsintown) {
      send({ type: "step", artist: name, step: "bandsintown-search" });
      bit = await soft(
        "bandsintown-search",
        name,
        () => findBandsintownArtist(name),
        null,
      );
      if (bit) {
        send({ type: "step", artist: name, step: "bandsintown-page" });
        bandsintownMarkdown = await soft(
          "bandsintown-page",
          name,
          () => getBandsintownPage(bit!.url),
          "",
        );
      }
    }

    // Ticketmaster Discovery — primary upcoming-events source now that
    // Bandsintown is Cloudflare-blocked. Only finds artists who sell through
    // Ticketmaster/Live Nation (so indie artists may return [], which is fine).
    send({ type: "step", artist: name, step: "ticketmaster" });
    const tm = await soft(
      "ticketmaster",
      name,
      () => getEventsForArtist(name),
      { events: [], attractionName: null },
    );
    const ticketmasterEvents = tm.events;

    let socialActivity: SocialActivity | undefined;
    if (opts.withSocials && (input.instagram || input.tiktok)) {
      send({ type: "step", artist: name, step: "socials" });
      socialActivity = await soft(
        "socials",
        name,
        () =>
          checkSocials({
            instagram: input.instagram,
            tiktok: input.tiktok,
          }),
        undefined,
      );
    }

    // Note: Bandsintown is currently behind aggressive Cloudflare protection
    // — Steel free-tier can no longer bypass it (May 2026). So `bit` is often
    // null in production. We no longer hard-fail when all data sources are
    // empty; Gemini synthesizes a "limited data" stub report so the artist
    // still appears in the UI with their CSV identity intact. The strict
    // grounding rule keeps the summary honest.

    send({ type: "step", artist: name, step: "synthesizing" });
    // Soft-fail synthesis too: if Gemini + Groq are both exhausted (or any
    // other transient model error), build a deterministic stub report from
    // the data we already have. The artist still appears in the UI with
    // releases/events/Spotify stats; the summary just notes that AI synth
    // wasn't available. This prevents single LLM hiccups from creating
    // hours-long "25 FAILED IN A ROW" cascades.
    const synth = await soft(
      "synthesize",
      name,
      () =>
        synthesizeArtist({
          name,
          releases,
          followers: bit?.followers,
          bandsintownMarkdown,
          recentGigs,
          socialActivity,
          spotify: spotify ?? undefined,
          ticketmasterEvents,
        }),
      {
        summary:
          spotify || releases.length || ticketmasterEvents.length
            ? "(AI synthesis unavailable — showing raw signals only)"
            : "(no data sources returned — re-run when LLM quota resets)",
        signals: [],
        events: [],
        notes: undefined,
      },
    );

    // Merge events from three sources, deduped by (date + venue + city):
    //   1. Ticketmaster — clean, structured, only Ticketmaster/Live Nation acts
    //   2. Spotify concerts — Spotify federates this from Bandsintown server-side
    //      (covers indie artists Ticketmaster misses; our route around Cloudflare)
    //   3. Gemini-extracted from Bandsintown markdown (legacy; mostly empty now)
    const spotifyConcerts = (spotify?.concerts ?? []).map((c) => ({
      date: c.date,
      venue: c.venue,
      city: c.city,
      ticketUrl: c.concertUrl,
    }));
    // Dedup key normalization: TM emits "Nashville, TN", Spotify emits just
    // "Nashville". Same show would appear twice. Strip trailing state code,
    // lowercase, collapse whitespace. Keying on (date + venue) alone is
    // tempting but venue spellings differ across sources too — including
    // normalized city as a tiebreaker still catches the common case.
    const normCity = (c: string) =>
      c
        .toLowerCase()
        .replace(/,\s*[a-z]{2}(?:\s+\d{5})?$/i, "")
        .replace(/\s+/g, " ")
        .trim();
    const normVenue = (v: string) =>
      v.toLowerCase().replace(/\s+/g, " ").trim();
    const seen = new Set<string>();
    const mergedEvents = [
      ...ticketmasterEvents,
      ...spotifyConcerts,
      ...(synth.events ?? []),
    ].filter((e) => {
      const key = `${e.date}|${normVenue(e.venue ?? "")}|${normCity(e.city ?? "")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Deterministic signal post-processor — belt-and-suspenders over the LLM.
    // The synth rules say "active-touring if any upcoming events exist" and
    // "recent-release if any release in last 30 days" — these are facts about
    // the data, not LLM judgments. When the LLM is conservative (Cerebras
    // gpt-oss-120b under quota pressure has shown this) or hallucinates an
    // empty signals array, we still force in the signals the raw data demands.
    // This closes the LLM-reliability gap permanently for the objective rules
    // while leaving the subjective ones (between-cycles, quiet, industry-writer)
    // to the LLM's judgment where context actually matters.
    const llmSignals = new Set(synth.signals ?? []);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysHence = new Date(
      today.getTime() + 90 * 24 * 60 * 60 * 1000,
    );
    const hasUpcomingEvent = mergedEvents.some((e) => {
      if (!e.date) return false;
      const d = new Date(e.date);
      return !isNaN(d.getTime()) && d >= today;
    });
    const hasRecentRelease = releases.some((r) => {
      if (!r.date) return false;
      const d = new Date(r.date);
      return !isNaN(d.getTime()) && d >= thirtyDaysAgo && d <= ninetyDaysHence;
    });
    if (hasUpcomingEvent) {
      llmSignals.add("active-touring");
      // If the LLM defaulted to "quiet" or "between-cycles" out of caution
      // but events DO exist, those negative-label signals contradict reality.
      llmSignals.delete("quiet");
      llmSignals.delete("between-cycles");
    }
    if (hasRecentRelease) {
      llmSignals.add("recent-release");
      llmSignals.delete("quiet"); // can't be quiet with a fresh release
    }
    const finalSignals = Array.from(llmSignals);

    const report: ArtistReport = {
      name,
      summary: synth.summary,
      signals: finalSignals,
      followers: bit?.followers,
      bandsintownUrl: bit?.url,
      releases,
      events: mergedEvents,
      notes: synth.notes,
      recentGigs,
      socialActivity,
      spotify: spotify ?? undefined,
      location: location ?? undefined,
      csvSpotifyUrl: input.spotifyUrl,
    };
    send({ type: "report", artist: name, report });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = humanizeError(raw);
    console.warn(`[SCOUT] ${name} hard-failed: ${raw}`);
    send({ type: "error", artist: name, message });
  }
}

async function runPool<T>(
  items: T[],
  worker: (item: T, i: number) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(workers);
}

export async function POST(req: NextRequest) {
  if (!process.env.GEMINI_API_KEY) {
    return new Response(
      JSON.stringify({
        error:
          "GEMINI_API_KEY not set in .env.local. Add it and restart dev server.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!process.env.STEEL_API_KEY) {
    return new Response(
      JSON.stringify({ error: "STEEL_API_KEY not set in .env.local." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let body: { artists?: ArtistInput[]; withSocials?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const artists = (Array.isArray(body.artists) ? body.artists : []).filter(
    (a) => a?.name?.trim(),
  );
  const withSocials = !!body.withSocials;

  // Sidecar pre-warm: Render free tier spins down after 15min idle. First
  // /artist call cold-starts ~30s, exceeding our TS-side 20s fetch timeout,
  // which silently nulls the first 1-2 artists' Spotify data → their synth
  // rules can't fire → empty signals. Fire-and-forget /health hit (with a
  // generous 45s timeout) wakes the dyno before the worker pool starts.
  const sidecarUrl = process.env.SPOTIFY_SIDECAR_URL;
  if (sidecarUrl) {
    fetch(`${sidecarUrl}/health`, {
      signal: AbortSignal.timeout(45000),
    }).catch((err) => {
      console.warn(
        "[SIDECAR_PREWARM]",
        err instanceof Error ? err.message : err,
      );
    });
  }

  if (artists.length === 0) {
    return new Response(JSON.stringify({ error: "No artists provided" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (e: ScoutEvent) => {
        // Client may abort mid-stream; in-flight workers can race past close.
        // Silently drop sends after close instead of throwing "Controller is
        // already closed."
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(ndjsonLine(e)));
        } catch {
          closed = true;
        }
      };

      try {
        await runPool(
          artists,
          (a, i) => processArtist(a, i, artists.length, send, { withSocials }),
          CONCURRENCY,
        );
        send({ type: "done" });
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {}
          closed = true;
        }
      }
    },
    cancel() {
      // Client disconnected (pause/refresh) — workers still running will see
      // their next send() drop silently. Nothing else to clean up.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
