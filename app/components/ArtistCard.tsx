"use client";

import type { ArtistReport } from "@/lib/types";

const COLORS = [
  { bg: "bg-red", text: "text-cream", accent: "text-cream/80" },
  { bg: "bg-blue", text: "text-cream", accent: "text-cream/80" },
  { bg: "bg-lime", text: "text-ink", accent: "text-ink/70" },
  { bg: "bg-ink", text: "text-cream", accent: "text-cream/80" },
];

const SIGNAL_LABELS: Record<string, string> = {
  "active-touring": "ACTIVE TOURING",
  "between-cycles": "BETWEEN CYCLES",
  "recent-release": "RECENT RELEASE",
  "industry-writer": "INDUSTRY WRITER",
  quiet: "QUIET",
  "new-artist": "NEW ARTIST",
};

export function ArtistCard({
  report,
  index,
}: {
  report: ArtistReport;
  index: number;
}) {
  const color = COLORS[index % COLORS.length];
  const num = String(index + 1).padStart(2, "0");

  return (
    <div
      className={`${color.bg} ${color.text} p-8 md:p-10 relative overflow-hidden`}
    >
      <div
        className={`display absolute top-2 right-4 text-[8rem] md:text-[12rem] ${color.accent} opacity-30 select-none pointer-events-none`}
      >
        {num}
      </div>

      <div className="mono mb-4 flex gap-2 flex-wrap">
        {report.signals.map((s) => (
          <span
            key={s}
            className={`border border-current/60 px-2 py-0.5 ${color.accent}`}
          >
            {SIGNAL_LABELS[s] ?? s.toUpperCase()}
          </span>
        ))}
        {report.followers !== undefined && (
          <span className={color.accent}>
            {report.followers.toLocaleString()} FOLLOWERS
          </span>
        )}
      </div>

      <h2 className="display text-5xl md:text-7xl lg:text-8xl mb-6 break-words relative z-10">
        {report.name}
      </h2>

      <p
        className={`serif-italic text-lg md:text-2xl max-w-3xl mb-10 ${color.accent}`}
      >
        {report.summary}
      </p>

      <div className="grid md:grid-cols-2 gap-8 md:gap-12 relative z-10">
        <Section
          title="01 — TOURS"
          color={color}
          empty={
            report.events.length === 0 ? "No upcoming shows in window." : null
          }
        >
          {report.events.map((e, i) => (
            <div key={i} className="mb-3">
              <div className="mono">{e.date}</div>
              <div className="font-medium">
                {e.withArtist ? `${e.withArtist} w/ ${report.name}` : e.venue}
              </div>
              <div className={`text-sm ${color.accent}`}>
                {e.venue !== (e.withArtist ?? "") && e.withArtist
                  ? `${e.venue} — `
                  : ""}
                {e.city}
              </div>
              {e.ticketUrl && (
                <a
                  href={e.ticketUrl}
                  target="_blank"
                  rel="noopener"
                  className="mono underline mt-1 inline-block"
                >
                  TICKETS →
                </a>
              )}
            </div>
          ))}
        </Section>

        <Section
          title="02 — RELEASES"
          color={color}
          empty={
            report.releases.length === 0
              ? "No releases in last 24 months."
              : null
          }
        >
          {report.releases.slice(0, 6).map((r, i) => (
            <div key={i} className="mb-2 flex gap-3 items-baseline">
              <div className="mono w-24 shrink-0">{r.date}</div>
              <div>
                <span className={`mono ${color.accent} mr-2`}>{r.type}</span>
                <span className="font-medium">{r.title}</span>
              </div>
            </div>
          ))}
        </Section>
      </div>

      {report.notes && (
        <div
          className={`mt-8 serif-italic text-base ${color.accent} max-w-3xl`}
        >
          {report.notes}
        </div>
      )}

      {report.bandsintownUrl && (
        <a
          href={report.bandsintownUrl}
          target="_blank"
          rel="noopener"
          className="mono mt-8 inline-block underline"
        >
          BANDSINTOWN →
        </a>
      )}
    </div>
  );
}

function Section({
  title,
  color,
  empty,
  children,
}: {
  title: string;
  color: (typeof COLORS)[number];
  empty: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className={`mono mb-3 pb-2 border-b border-current/30`}>{title}</div>
      {empty ? (
        <div className={`serif-italic ${color.accent}`}>{empty}</div>
      ) : (
        children
      )}
    </div>
  );
}
