"use client";

import { useState } from "react";
import type { ArtistReport, Signal } from "@/lib/types";
import { customerKeys } from "@/lib/identity";
import { CustomerCrossoverPanel } from "./CustomerCrossoverPanel";

const SIGNAL_CONFIG: Record<
  Signal,
  { label: string; dot: string; chip: string }
> = {
  "active-touring": {
    label: "ACTIVE TOURING",
    dot: "bg-red",
    chip: "border-red/60 text-red",
  },
  "recent-release": {
    label: "RECENT RELEASE",
    dot: "bg-blue",
    chip: "border-blue/60 text-blue",
  },
  "industry-writer": {
    label: "INDUSTRY WRITER",
    dot: "bg-lime",
    chip: "border-lime/70 text-ink bg-lime/10",
  },
  "between-cycles": {
    label: "BETWEEN CYCLES",
    dot: "bg-ink/30",
    chip: "border-ink/30 text-ink/70",
  },
  quiet: {
    label: "QUIET",
    dot: "bg-ink/20",
    chip: "border-ink/30 text-ink/60",
  },
  "new-artist": {
    label: "NEW ARTIST",
    dot: "bg-blue",
    chip: "border-blue/60 text-blue",
  },
};

function getPrimaryDot(signals: Signal[]): string {
  if (!signals.length) return "bg-ink/30";
  const priority: Signal[] = [
    "active-touring",
    "recent-release",
    "industry-writer",
    "new-artist",
    "between-cycles",
    "quiet",
  ];
  for (const s of priority) {
    if (signals.includes(s)) return SIGNAL_CONFIG[s].dot;
  }
  return "bg-ink/30";
}

export function ArtistRow({
  report,
  index,
  onPatch,
}: {
  report: ArtistReport;
  index: number;
  onPatch?: (patch: Partial<ArtistReport>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [diveError, setDiveError] = useState<string | null>(null);
  const dot = getPrimaryDot(report.signals ?? []);
  const num = String(index + 1).padStart(3, "0");

  const generateDeepDive = async () => {
    setGenerating(true);
    setDiveError(null);
    try {
      const res = await fetch("/api/deep-dive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: report.name,
          location: report.location,
          // Prefer CSV-provided URL (authoritative) over the resolved ID.
          spotifyId: report.csvSpotifyUrl ?? report.spotify?.id,
          csvSpotifyUrl: report.csvSpotifyUrl,
          bandsintownUrl: report.bandsintownUrl,
          // Only forward the cached Spotify blob if it matches the CSV URL;
          // otherwise we'd be re-anchoring on a wrong identity.
          spotify:
            report.csvSpotifyUrl &&
            report.spotify?.id &&
            report.csvSpotifyUrl.includes(report.spotify.id)
              ? report.spotify
              : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      onPatch?.({ deepDive: json.dive });
    } catch (err) {
      setDiveError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="border-b border-ink/10 group">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full grid grid-cols-[12px_3rem_1fr_auto_auto] gap-4 items-center px-5 py-4 text-left hover:bg-ink/5 transition-colors"
      >
        <span className={`inline-block w-2.5 h-2.5 rounded-full ${dot}`} />
        <span className="mono text-ink/40">{num}</span>

        <div className="min-w-0">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="display text-2xl md:text-3xl truncate max-w-full">
              {report.name}
            </span>
            <span className="mono text-ink/40">
              {(report.signals ?? [])
                .slice(0, 2)
                .map((s) => SIGNAL_CONFIG[s]?.label ?? s.toUpperCase())
                .join(" · ")}
            </span>
          </div>
          <div className="serif-italic text-ink/75 mt-1 line-clamp-2">
            {report.summary}
          </div>
        </div>

        <div
          className="mono text-right hidden sm:block"
          title="Monthly listeners: unique Spotify users in the last 28 days who played any of the artist's tracks. Shown on the artist's public Spotify profile."
        >
          {typeof report.spotify?.monthlyListeners === "number" ? (
            <>
              <div>{report.spotify.monthlyListeners.toLocaleString()}</div>
              <div className="text-ink/40">MONTHLY LISTENERS</div>
              <div className="text-ink/30 text-[0.6rem]">
                UNIQUE · 28D · {tierOf(report.spotify.monthlyListeners)}
              </div>
            </>
          ) : typeof report.followers === "number" ? (
            <>
              <div>{report.followers.toLocaleString()}</div>
              <div className="text-ink/40">BANDSINTOWN FOLLOWERS</div>
            </>
          ) : (
            <div className="text-ink/30">—</div>
          )}
        </div>

        <span
          className={`mono text-ink/40 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          ▾
        </span>
      </button>

      {open && (
        <div className="px-5 pb-6 pt-1 grid md:grid-cols-2 gap-x-12 gap-y-6 bg-ink/[0.02]">
          {report.spotify && (
            <div className="md:col-span-2 grid grid-cols-2 md:grid-cols-4 gap-6 pb-4 border-b border-ink/15">
              <SpotifyStat
                label="MONTHLY LISTENERS"
                hint="Unique Spotify · 28d"
                value={report.spotify.monthlyListeners}
                accent
              />
              <SpotifyStat
                label="SPOTIFY FOLLOWERS"
                hint='Clicked "Follow"'
                value={report.spotify.followers}
              />
              <div>
                <div className="mono text-ink/50 mb-1">BASED IN</div>
                <div className="display text-2xl md:text-3xl">
                  {formatLocation(report.location) ?? "—"}
                </div>
                {report.location?.source &&
                  report.location?.source !== "unknown" && (
                    <div className="serif-italic text-ink/45 text-xs mt-1">
                      via {report.location.source}
                    </div>
                  )}
              </div>
              <SpotifyStat
                label="BANDSINTOWN"
                hint="Tour alert followers"
                value={report.followers}
              />
              {report.spotify.topCities &&
                report.spotify.topCities.length > 0 && (
                  <div className="col-span-2 md:col-span-4">
                    <div className="mono text-ink/50 mb-2">
                      00 — TOP CITIES (LISTENERSHIP)
                    </div>
                    <div className="flex flex-wrap gap-x-5 gap-y-1">
                      {report.spotify.topCities.slice(0, 5).map((c, i) => (
                        <div key={i} className="flex items-baseline gap-2">
                          <span className="mono text-ink/40">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <span className="font-medium">{c.city}</span>
                          {c.region && (
                            <span className="text-ink/50 text-sm">
                              {c.region}
                            </span>
                          )}
                          {c.listeners && (
                            <span className="mono text-ink/40">
                              {formatPlaycount(c.listeners)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              {report.spotify.topTracks &&
                report.spotify.topTracks.length > 0 && (
                  <div className="col-span-2 md:col-span-4">
                    <div className="mono text-ink/50 mb-2">
                      00 — TOP TRACKS (SPOTIFY)
                    </div>
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1">
                      {report.spotify.topTracks.slice(0, 6).map((t, i) => (
                        <div key={i} className="flex items-baseline gap-3">
                          <span className="mono text-ink/40 w-5">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <span className="font-medium truncate">{t.name}</span>
                          {t.playcount && (
                            <span className="mono text-ink/40 ml-auto">
                              {formatPlaycount(t.playcount)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </div>
          )}

          <Section title="01 — UPCOMING">
            {(report.events ?? []).length === 0 ? (
              <div className="serif-italic text-ink/60">
                No upcoming shows in window.
              </div>
            ) : (
              (report.events ?? []).map((e, i) => (
                <div key={i} className="mb-3 flex gap-4">
                  <div className="mono w-20 shrink-0 text-ink/60">{e.date}</div>
                  <div className="min-w-0">
                    <div className="font-medium">
                      {e.withArtist
                        ? `${e.withArtist} w/ ${report.name}`
                        : e.venue}
                    </div>
                    <div className="text-sm text-ink/60">
                      {e.withArtist ? `${e.venue} · ` : ""}
                      {e.city}
                    </div>
                    {e.ticketUrl && (
                      <a
                        href={e.ticketUrl}
                        target="_blank"
                        rel="noopener"
                        className="mono text-blue hover:underline"
                      >
                        TICKETS →
                      </a>
                    )}
                  </div>
                </div>
              ))
            )}
          </Section>

          <Section title="02 — RELEASES (24mo)">
            {(report.releases ?? []).length === 0 ? (
              <div className="serif-italic text-ink/60">
                No releases in the last 24 months.
              </div>
            ) : (
              (report.releases ?? []).slice(0, 8).map((r, i) => (
                <div key={i} className="mb-1.5 flex gap-3 items-baseline">
                  <div className="mono w-24 shrink-0 text-ink/60">{r.date}</div>
                  <div className="min-w-0">
                    <span className="mono text-ink/40 mr-2">{r.type}</span>
                    <span>{r.title}</span>
                  </div>
                </div>
              ))
            )}
          </Section>

          {report.recentGigs && report.recentGigs.length > 0 && (
            <Section
              title={`03 — PAST GIGS (last 90d · ${report.recentGigs.length})`}
            >
              {report.recentGigs.slice(0, 8).map((g, i) => (
                <div key={i} className="mb-1.5 flex gap-3 items-baseline">
                  <div className="mono w-24 shrink-0 text-ink/60">{g.date}</div>
                  <div className="min-w-0">
                    <span className="font-medium">{g.venue}</span>
                    <span className="text-ink/50">
                      {" · "}
                      {g.city}
                      {g.country ? `, ${g.country}` : ""}
                    </span>
                  </div>
                </div>
              ))}
            </Section>
          )}

          {report.socialActivity &&
            (report.socialActivity.instagram ||
              report.socialActivity.tiktok) && (
              <Section title="04 — SOCIALS">
                {report.socialActivity.instagram && (
                  <SocialLine
                    network="IG"
                    handle={report.socialActivity.instagram.handle}
                    lastPost={report.socialActivity.instagram.lastPost}
                    status={report.socialActivity.instagram.status}
                    url={`https://instagram.com/${report.socialActivity.instagram.handle}`}
                  />
                )}
                {report.socialActivity.tiktok && (
                  <SocialLine
                    network="TT"
                    handle={report.socialActivity.tiktok.handle}
                    lastPost={report.socialActivity.tiktok.lastPost}
                    status={report.socialActivity.tiktok.status}
                    url={`https://tiktok.com/@${report.socialActivity.tiktok.handle}`}
                  />
                )}
              </Section>
            )}

          <div className="md:col-span-2 flex flex-wrap items-center gap-2 pt-2 border-t border-ink/10">
            <div className="mono text-ink/50">SIGNALS</div>
            {(report.signals ?? []).map((s) => (
              <span
                key={s}
                className={`mono border px-2 py-0.5 ${SIGNAL_CONFIG[s]?.chip ?? "border-ink/30"}`}
              >
                {SIGNAL_CONFIG[s]?.label ?? s.toUpperCase()}
              </span>
            ))}
            {report.bandsintownUrl && (
              <a
                href={report.bandsintownUrl}
                target="_blank"
                rel="noopener"
                className="mono ml-auto underline hover:text-red"
              >
                BANDSINTOWN →
              </a>
            )}
          </div>

          {report.notes && (
            <div className="md:col-span-2 serif-italic text-ink/70 text-sm">
              {report.notes}
            </div>
          )}

          {report.events && report.events.length > 0 && (
            <div className="md:col-span-2 pt-3 border-t border-ink/10">
              <div className="mono text-ink/50 mb-3">
                ◎ CUSTOMER CROSSOVER · TOUR INTERSECTION
              </div>
              <CustomerCrossoverPanel
                events={report.events}
                artistName={report.name}
                customerKeys={customerKeys(report)}
              />
            </div>
          )}

          <div className="md:col-span-2 pt-3 border-t border-ink/10">
            <div className="mono text-ink/50 mb-3">
              ★ DEEP CUTS · INTERVIEW PREP
            </div>
            {report.deepDive ? (
              <DeepDiveDisplay
                dive={report.deepDive}
                onRegenerate={generateDeepDive}
                regenerating={generating}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={generateDeepDive}
                  disabled={generating}
                  className="mono px-3 h-9 border border-ink/30 hover:bg-ink hover:text-cream transition-colors disabled:opacity-40"
                >
                  {generating ? "GENERATING…" : "GENERATE DEEP DIVE →"}
                </button>
                <span className="serif-italic text-ink/55 text-sm">
                  Reads Wikipedia + Genius, returns Nardwuar-style facts with
                  citations. Free, ~20–30s.
                </span>
              </div>
            )}
            {diveError && (
              <div className="mt-3 mono text-red text-xs">
                FAILED · {diveError}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const CATEGORY_LABEL: Record<string, string> = {
  biographical: "BIO",
  career: "CAREER",
  creative: "CREATIVE",
  collaborations: "COLLABS",
  personal: "PERSONAL",
  trivia: "TRIVIA",
};

function DeepDiveDisplay({
  dive,
  onRegenerate,
  regenerating,
}: {
  dive: import("@/lib/types").DeepDive;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  return (
    <div>
      <div className="serif-italic text-ink/80 mb-4 max-w-3xl">
        {dive.context}
      </div>
      <div className="space-y-2.5">
        {(dive.facts ?? []).map((f, i) => (
          <div key={i} className="flex gap-3 items-baseline">
            <span className="mono text-ink/40 w-5 shrink-0">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="mono text-ink/55 w-20 shrink-0">
              {CATEGORY_LABEL[f.category] ?? f.category.toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <span>{f.fact}</span>
              {f.source && (
                <a
                  href={f.source}
                  target="_blank"
                  rel="noopener"
                  className="mono text-ink/40 ml-2 hover:text-red"
                >
                  ↗
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3 text-xs">
        <span className="mono text-ink/40">
          SOURCES · {(dive.sourcesChecked ?? []).length}
        </span>
        {(dive.sourcesChecked ?? []).map((s) => {
          let host = s;
          try {
            host = new URL(s).hostname.replace("en.", "").replace("www.", "");
          } catch {}
          return (
            <a
              key={s}
              href={s}
              target="_blank"
              rel="noopener"
              className="mono text-ink/50 underline hover:text-red"
            >
              {host}
            </a>
          );
        })}
        <span className="mono text-ink/30 ml-auto">
          GENERATED {new Date(dive.generatedAt).toLocaleString()}
        </span>
        <button
          onClick={onRegenerate}
          disabled={regenerating}
          className="mono px-2 h-7 border border-ink/25 hover:bg-ink/5 disabled:opacity-40"
        >
          {regenerating ? "REGENERATING…" : "REGENERATE"}
        </button>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mono mb-3 pb-2 border-b border-ink/15">{title}</div>
      {children}
    </div>
  );
}

function SpotifyStat({
  label,
  hint,
  value,
  text,
  accent,
}: {
  label: string;
  hint?: string;
  value?: number;
  text?: string;
  accent?: boolean;
}) {
  // Use typeof === 'number' rather than !== undefined: the Spotify sidecar
  // returns literal null for missing stats, which would pass an undefined
  // check then crash on null.toLocaleString().
  const display =
    text !== undefined && text !== null
      ? text
      : typeof value === "number"
        ? value.toLocaleString()
        : "—";
  return (
    <div>
      <div className="mono text-ink/50 mb-1">{label}</div>
      <div
        className={`display ${accent ? "text-red text-3xl md:text-4xl" : "text-2xl md:text-3xl"}`}
      >
        {display}
      </div>
      {hint && (
        <div className="serif-italic text-ink/45 text-xs mt-1">{hint}</div>
      )}
    </div>
  );
}

function formatPlaycount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Categorize an artist by Spotify monthly listener count. Surfaced as a tiny
 * trailing label on the listener block so 422k vs 4.2M reads as a category
 * judgment ("MID" vs "TOP TIER") at-a-glance, not just a raw integer.
 *
 * Brackets are tuned for the indie/mid-tier roster Songfinch typically scouts
 * — emerging starts at zero, mid sits at the 50k–500k inflection where most
 * "we should reach out" candidates land, top tier is reserved for genuinely
 * stadium-scale artists where Songfinch placement economics shift.
 */
function tierOf(monthlyListeners: number): string {
  if (monthlyListeners < 5_000) return "EMERGING";
  if (monthlyListeners < 50_000) return "DEVELOPING";
  if (monthlyListeners < 500_000) return "MID";
  if (monthlyListeners < 5_000_000) return "MAJOR";
  return "TOP TIER";
}

function formatLocation(loc?: {
  country?: string;
  area?: string;
  beginArea?: string;
}): string | null {
  if (!loc) return null;
  // Prefer specific origin city, then general area, then country
  const parts = [loc.beginArea, loc.area, loc.country].filter(
    (p, i, arr) => p && arr.indexOf(p) === i,
  );
  if (parts.length === 0) return null;
  return parts.slice(0, 2).join(", ");
}

const SOCIAL_STATUS_COLOR: Record<string, string> = {
  ACTIVE: "bg-red",
  WARM: "bg-blue",
  COOLING: "bg-lime",
  QUIET: "bg-ink/30",
  UNKNOWN: "bg-ink/20",
};

function SocialLine({
  network,
  handle,
  lastPost,
  status,
  url,
}: {
  network: string;
  handle: string;
  lastPost?: string;
  status: string;
  url: string;
}) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <span className="mono w-6 text-ink/60">{network}</span>
      <span
        className={`inline-block w-2 h-2 rounded-full ${SOCIAL_STATUS_COLOR[status] ?? "bg-ink/20"}`}
      />
      <a
        href={url}
        target="_blank"
        rel="noopener"
        className="font-medium hover:underline"
      >
        @{handle}
      </a>
      <span className="mono text-ink/50">
        {status}
        {lastPost ? ` · LAST ${lastPost}` : ""}
      </span>
    </div>
  );
}
