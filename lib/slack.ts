import type { Briefing, Callout } from "./briefing";
import type { DiveBriefing } from "./diveBriefing";
import type { ArtistReport } from "./types";

// Highlight cities where the Songfinch team can show up to local shows.
const HIGHLIGHT_CITIES = ["Chicago", "Nashville"];

type LocalHighlight = {
  artist: string;
  date: string;
  venue: string;
  city: string;
  ticketUrl?: string;
  spotifyId?: string;
};

function computeLocalHighlights(reports: ArtistReport[]): LocalHighlight[] {
  const out: LocalHighlight[] = [];
  for (const r of reports) {
    for (const e of r.events ?? []) {
      const cityMatch = HIGHLIGHT_CITIES.some((c) =>
        e.city.toLowerCase().includes(c.toLowerCase()),
      );
      if (cityMatch) {
        out.push({
          artist: r.name,
          date: e.date,
          venue: e.venue,
          city: e.city,
          ticketUrl: e.ticketUrl,
          spotifyId: r.spotify?.id,
        });
      }
    }
  }
  // Sort by date asc
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function artistLink(name: string, spotifyId?: string): string {
  if (spotifyId) {
    return `<https://open.spotify.com/artist/${spotifyId}|*${name}*>`;
  }
  return `*${name}*`;
}

/**
 * Build Slack Block Kit payload from a briefing.
 * Optional `reports` lets us add Spotify hyperlinks + compute local-city highlights.
 */
export function briefingToSlackBlocks(
  briefing: Briefing,
  meta: { totalArtists: number; date: string },
  reports?: ArtistReport[],
): {
  text: string;
  blocks: unknown[];
} {
  const s = briefing.stats;
  const fallback = `${briefing.headline} — ${s.total}/${meta.totalArtists} scouted`;

  const reportsByName = new Map<string, ArtistReport>();
  for (const r of reports ?? []) {
    reportsByName.set(r.name.toLowerCase(), r);
  }

  const highlights = reports ? computeLocalHighlights(reports) : [];

  const breakdownParts: string[] = [];
  if (s.activeTouring > 0)
    breakdownParts.push(`🎤 *${s.activeTouring}* touring`);
  if (s.recentRelease > 0)
    breakdownParts.push(`🎵 *${s.recentRelease}* recent releases`);
  if (s.industryWriter > 0)
    breakdownParts.push(`✍️ *${s.industryWriter}* writers`);
  if (s.newArtist > 0) breakdownParts.push(`✨ *${s.newArtist}* new`);
  if (s.betweenCycles > 0)
    breakdownParts.push(`⏸ *${s.betweenCycles}* between cycles`);
  if (s.quiet > 0) breakdownParts.push(`💤 *${s.quiet}* quiet`);

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🎯 ${briefing.headline}`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*Songfinch roster briefing* · ${meta.date} · ${s.total.toLocaleString()} of ${meta.totalArtists.toLocaleString()} scouted`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `_${briefing.summary}_`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: breakdownParts.join("  ·  "),
        },
      ],
    },
    { type: "divider" },
  ];

  // 🚨 Local team-city highlights at the very top after summary
  if (highlights.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🚨  *LOCAL DATES (${HIGHLIGHT_CITIES.join(" / ")})* — ${highlights.length}`,
      },
    });
    highlights.forEach((h) => {
      const tickets = h.ticketUrl ? ` <${h.ticketUrl}|🎟 tickets>` : "";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${artistLink(h.artist, h.spotifyId)} · *${h.date}* · ${h.venue} — ${h.city}${tickets}`,
        },
      });
    });
    blocks.push({ type: "divider" });
  }

  if (briefing.touringCallouts.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🎤  *ACTIVE TOURING* — ${briefing.touringCallouts.length}`,
      },
    });
    briefing.touringCallouts.forEach((c) => {
      blocks.push(calloutBlock(c, reportsByName.get(c.name.toLowerCase())));
    });
    blocks.push({ type: "divider" });
  }

  if (briefing.releaseCallouts.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🎵  *RECENT RELEASES* — ${briefing.releaseCallouts.length}`,
      },
    });
    briefing.releaseCallouts.forEach((c) => {
      blocks.push(calloutBlock(c, reportsByName.get(c.name.toLowerCase())));
    });
  }

  if (briefing.closer) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_${briefing.closer}_`,
        },
      ],
    });
  }

  return { text: fallback, blocks };
}

function calloutBlock(c: Callout, report?: ArtistReport): unknown {
  const heading = artistLink(c.name, report?.spotify?.id);
  // Build a tiny links row from whatever we have
  const linkParts: string[] = [];
  if (report?.bandsintownUrl) {
    linkParts.push(`<${report.bandsintownUrl}|bandsintown>`);
  }
  if (report?.spotify?.id) {
    linkParts.push(
      `<https://open.spotify.com/artist/${report.spotify.id}|spotify>`,
    );
  }
  const footer = linkParts.length > 0 ? `\n_${linkParts.join(" · ")}_` : "";
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `${heading}\n${c.body}${footer}`,
    },
  };
}

/**
 * Build Slack Block Kit payload from a dive briefing (interview prep).
 */
export function diveBriefingToSlackBlocks(
  briefing: DiveBriefing,
  meta: { date: string },
): {
  text: string;
  blocks: unknown[];
} {
  const fallback = `${briefing.headline} — ${briefing.artists.length} artists`;

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `★ ${briefing.headline}`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*Interview prep · deep cuts* · ${meta.date} · ${briefing.artists.length} artist${briefing.artists.length === 1 ? "" : "s"}`,
        },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `_${briefing.summary}_` },
    },
    { type: "divider" },
  ];

  briefing.artists.forEach((a, i) => {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${a.name}*\n_${a.oneLiner}_`,
      },
    });
    a.questions.forEach((q, j) => {
      const sourceHost = safeHost(q.source);
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Q${j + 1}.* ${q.question}\n_context:_ ${q.context} <${q.source}|↗ ${sourceHost}>`,
        },
      });
    });
    if (i < briefing.artists.length - 1) {
      blocks.push({ type: "divider" });
    }
  });

  return { text: fallback, blocks };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").replace(/^en\./, "");
  } catch {
    return "source";
  }
}

export async function postDiveBriefingToSlack(args: {
  briefing: DiveBriefing;
  webhookUrl?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const url = args.webhookUrl ?? process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    return { ok: false, error: "SLACK_WEBHOOK_URL not set." };
  }
  const payload = diveBriefingToSlackBlocks(args.briefing, {
    date: new Date().toISOString().slice(0, 10),
  });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Slack ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function postBriefingToSlack(args: {
  briefing: Briefing;
  totalArtists: number;
  reports?: ArtistReport[];
  webhookUrl?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const url = args.webhookUrl ?? process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    return {
      ok: false,
      error:
        "SLACK_WEBHOOK_URL not set in .env.local. Add an incoming webhook URL from your Slack workspace.",
    };
  }
  const payload = briefingToSlackBlocks(
    args.briefing,
    {
      totalArtists: args.totalArtists,
      date: new Date().toISOString().slice(0, 10),
    },
    args.reports,
  );
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Slack ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function sendBriefingFromReports(
  reports: ArtistReport[],
  totalArtists: number,
) {
  const { generateBriefing } = await import("./briefing");
  const briefing = await generateBriefing(reports);
  return {
    briefing,
    result: await postBriefingToSlack({
      briefing,
      totalArtists,
    }),
  };
}
