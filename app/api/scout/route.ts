import type { NextRequest } from "next/server";
import { findArtist, getRecentReleases } from "@/lib/musicbrainz";
import { findBandsintownArtist, getBandsintownPage } from "@/lib/steel";
import { getRecentGigs } from "@/lib/setlistfm";
import { checkSocials } from "@/lib/social";
import { getSpotifyInfo } from "@/lib/spotify";
import { synthesizeArtist } from "@/lib/synthesize";
import type { ArtistInput, ArtistReport, ScoutEvent } from "@/lib/types";

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
    const mbMatch = await soft(
      "musicbrainz",
      name,
      () => findArtist(name),
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

    send({ type: "step", artist: name, step: "bandsintown-search" });
    const bit = await soft(
      "bandsintown-search",
      name,
      () => findBandsintownArtist(name),
      null,
    );

    let bandsintownMarkdown = "";
    if (bit) {
      send({ type: "step", artist: name, step: "bandsintown-page" });
      bandsintownMarkdown = await soft(
        "bandsintown-page",
        name,
        () => getBandsintownPage(bit.url),
        "",
      );
    }

    let socialActivity;
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

    const haveAnyData =
      releases.length > 0 ||
      spotify !== null ||
      bit !== null ||
      recentGigs.length > 0;

    if (!haveAnyData) {
      send({
        type: "error",
        artist: name,
        message:
          "No data from any source (MusicBrainz, Spotify, Bandsintown all unavailable or empty)",
      });
      return;
    }

    send({ type: "step", artist: name, step: "synthesizing" });
    const synth = await synthesizeArtist({
      name,
      releases,
      followers: bit?.followers,
      bandsintownMarkdown,
      recentGigs,
      socialActivity,
      spotify: spotify ?? undefined,
    });

    const report: ArtistReport = {
      name,
      summary: synth.summary,
      signals: synth.signals,
      followers: bit?.followers,
      bandsintownUrl: bit?.url,
      releases,
      events: synth.events,
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

  const body = (await req.json()) as {
    artists: ArtistInput[];
    withSocials?: boolean;
  };
  const artists = (body.artists || []).filter((a) => a?.name?.trim());
  const withSocials = !!body.withSocials;

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
