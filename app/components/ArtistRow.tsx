"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ArtistReport, Signal } from "@/lib/types";
import { customerKeys } from "@/lib/identity";
import { customerEmail, type Customer } from "@/lib/customerCrossover";
import { firstName, type OrderSummary } from "@/lib/orders";
import {
  ANNOUNCEMENT_LABEL,
  buildBroadcastEmail,
  type Announcement,
  type AnnouncementType,
} from "@/lib/updates";
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

          <IdentityMirror
            artistKey={customerKeys(report)[0]}
            artistName={report.name}
          />

          <NotesSection artistKey={customerKeys(report)[0]} />

          <AnnouncementsSection
            artistKey={customerKeys(report)[0]}
            artistName={report.name}
          />

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

// Identity Mirror — the artist's body-of-work portrait, rolled up from the
// songs they've made: occasions, genres, patrons, where their people are.
// Absent until orders are uploaded for the artist.
function IdentityMirror({
  artistKey,
  artistName,
}: {
  artistKey: string;
  artistName: string;
}) {
  const [summary, setSummary] = useState<OrderSummary | null>(null);
  const [topStates, setTopStates] = useState<
    { state: string; count: number }[]
  >([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "none">("loading");

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    fetch(`/api/orders?artist=${encodeURIComponent(artistKey)}&summary=1`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.summary && d.summary.total > 0) {
          setSummary(d.summary);
          setPhase("ready");
        } else setPhase("none");
      })
      .catch((err) => {
        console.warn("[MIRROR] summary failed:", err);
        if (!cancelled) setPhase("none");
      });
    return () => {
      cancelled = true;
    };
  }, [artistKey]);

  // Top states from the customer aggregate (city roll-up) — optional, graceful.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/customers?id=${encodeURIComponent(artistKey)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const agg = d?.dataset?.aggregate;
        if (!Array.isArray(agg)) return;
        const m = new Map<string, number>();
        for (const c of agg) {
          const s = (c?.stateCode || "").trim();
          if (s) m.set(s, (m.get(s) ?? 0) + (c?.count || 0));
        }
        setTopStates(
          [...m.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([state, count]) => ({ state, count })),
        );
      })
      .catch((err) => console.warn("[MIRROR] geo failed:", err));
    return () => {
      cancelled = true;
    };
  }, [artistKey]);

  if (phase !== "ready" || !summary) return null;

  const occMax = summary.byOccasion[0]?.count || 1;
  const line = characterizePortrait(summary);

  return (
    <div className="md:col-span-2 pt-3 border-t border-ink/10">
      <div className="mono text-ink/50 mb-3">
        ✦ BODY OF WORK · {artistName.toUpperCase()}
      </div>
      <div className="flex items-baseline gap-3 flex-wrap mb-1">
        <span className="display text-4xl md:text-5xl text-red">
          {summary.total.toLocaleString()}
        </span>
        <span className="serif-italic text-ink/70">
          songs for {summary.uniqueFans.toLocaleString()} real people
        </span>
      </div>
      {line && (
        <div className="serif-italic text-ink/80 mb-4 max-w-2xl">{line}</div>
      )}

      <div className="grid md:grid-cols-2 gap-x-10 gap-y-4">
        <div>
          <div className="mono text-ink/45 mb-2 text-xs">OCCASIONS</div>
          <div className="space-y-1">
            {summary.byOccasion.slice(0, 8).map((o) => {
              const pct = Math.round((o.count / summary.total) * 100);
              return (
                <div
                  key={o.occasion}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className="w-32 md:w-40 truncate shrink-0">
                    {o.occasion}
                  </span>
                  <span className="flex-1 h-2 bg-ink/10">
                    <span
                      className="block h-full bg-red"
                      style={{
                        width: `${Math.max(3, Math.round((o.count / occMax) * 100))}%`,
                      }}
                    />
                  </span>
                  <span className="mono text-ink/55 w-20 text-right shrink-0">
                    {o.count.toLocaleString()} · {pct}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-4">
          {summary.byGenre.length > 0 && (
            <div>
              <div className="mono text-ink/45 mb-2 text-xs">GENRES</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {summary.byGenre.map((g) => (
                  <span key={g.genre}>
                    <span className="font-medium">{g.genre}</span>{" "}
                    <span className="mono text-ink/45">
                      {Math.round((g.count / summary.total) * 100)}%
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {summary.patronCount > 0 && (
            <div>
              <div className="mono text-ink/45 mb-2 text-xs">
                PATRONS · CAME BACK
              </div>
              <div className="text-sm">
                <span className="font-medium">{summary.patronCount}</span>{" "}
                ordered 2+ songs.{" "}
                {summary.topPatrons.length > 0 && (
                  <span className="text-ink/70">
                    Most-trusted:{" "}
                    {summary.topPatrons
                      .map((p) => `${firstName(p.name)} (${p.count})`)
                      .join(", ")}
                    .
                  </span>
                )}
              </div>
            </div>
          )}

          {topStates.length > 0 && (
            <div>
              <div className="mono text-ink/45 mb-2 text-xs">
                WHERE THEIR PEOPLE ARE
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {topStates.map((s) => (
                  <span key={s.state}>
                    <span className="font-medium">{s.state}</span>{" "}
                    <span className="mono text-ink/45">
                      {s.count.toLocaleString()}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {summary.ratedAvg != null && (
            <div className="mono text-ink/45 text-xs">
              AVG RATING · {summary.ratedAvg.toFixed(1)} / 5
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// A short, data-true characterization of the catalog. Names the dominant
// occasions, and surfaces memorials as the distinctive trust signal when
// they're a meaningful share — that's the line that stops an artist cold.
function characterizePortrait(s: OrderSummary): string {
  if (!s.byOccasion.length) return "";
  const top = s.byOccasion[0];
  const topPct = Math.round((top.count / s.total) * 100);
  const second = s.byOccasion[1];
  const memorial = s.byOccasion.find((o) =>
    /memorial|in memory|passed|passing|grief|sympathy|loss/i.test(o.occasion),
  );
  let line = `Mostly ${top.occasion.toLowerCase()} songs (${topPct}%)`;
  if (second && second.count > 0)
    line += `, then ${second.occasion.toLowerCase()}`;
  line += ".";
  if (memorial && memorial !== top && memorial.count >= 10) {
    line += ` ${memorial.count.toLocaleString()} are memorials — people trust this artist with grief.`;
  }
  return line;
}

// Internal team notes per artist — autosaving scratchpad, keyed by the stable
// name-first identity so it survives re-scouts and never orphans.
function NotesSection({ artistKey }: { artistKey: string }) {
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<
    "loading" | "idle" | "saving" | "saved" | "error"
  >("loading");
  // Last value known to be persisted. null = not yet loaded for this artist,
  // which suppresses autosave so a pending edit can't write to the wrong key.
  const lastSavedRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    lastSavedRef.current = null;
    setStatus("loading");
    fetch(`/api/notes?artist=${encodeURIComponent(artistKey)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const n = typeof d.note === "string" ? d.note : "";
        setNote(n);
        lastSavedRef.current = n;
        setStatus("idle");
      })
      .catch((err) => {
        console.warn("[NOTES] hydrate failed:", err);
        if (!cancelled) setStatus("idle");
      });
    return () => {
      cancelled = true;
    };
  }, [artistKey]);

  useEffect(() => {
    if (lastSavedRef.current === null) return; // not loaded yet
    if (note === lastSavedRef.current) return; // unchanged
    setStatus("saving");
    const t = setTimeout(() => {
      fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artist: artistKey, note }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.error) throw new Error(d.error);
          lastSavedRef.current = note;
          setStatus("saved");
        })
        .catch((err) => {
          console.warn("[NOTES] save failed:", err);
          setStatus("error");
        });
    }, 800);
    return () => clearTimeout(t);
  }, [note, artistKey]);

  const statusLabel =
    status === "saving"
      ? "Saving…"
      : status === "saved"
        ? "Saved ✓"
        : status === "error"
          ? "Save failed — retry"
          : status === "loading"
            ? "Loading…"
            : "";

  return (
    <div className="md:col-span-2 pt-3 border-t border-ink/10">
      <div className="flex items-center gap-3 mb-2">
        <div className="mono text-ink/50">✎ INTERNAL NOTES</div>
        <span
          className={`mono text-xs ${
            status === "error"
              ? "text-red"
              : status === "saved"
                ? "text-lime-ink"
                : "text-ink/40"
          }`}
        >
          {statusLabel}
        </span>
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Team notes on this artist — outreach status, contacts, fit, anything. Autosaves as you type."
        rows={4}
        className="w-full bg-cream border border-ink/20 focus:border-ink/60 focus:outline-none px-3 py-2 text-sm leading-relaxed resize-y placeholder:text-ink/35"
      />
    </div>
  );
}

// Per-artist announcements — write in releases/tours/merch/news, then broadcast
// to the fanbase (compose + hand off, never auto-send).
function AnnouncementsSection({
  artistKey,
  artistName,
}: {
  artistKey: string;
  artistName: string;
}) {
  const [items, setItems] = useState<Announcement[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [broadcast, setBroadcast] = useState<Announcement | null>(null);
  const [saveErr, setSaveErr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/updates?artist=${encodeURIComponent(artistKey)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (Array.isArray(d.updates)) setItems(d.updates);
        setLoaded(true);
      })
      .catch((err) => {
        console.warn("[UPDATES] hydrate failed:", err);
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [artistKey]);

  const persist = (next: Announcement[]) => {
    const prev = items; // snapshot for rollback
    setItems(next);
    setSaveErr(false);
    fetch("/api/updates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artist: artistKey, updates: next }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
      })
      .catch((err) => {
        // Roll the optimistic edit back and surface it — announcements feed
        // fanbase broadcasts, so a silently-lost save would let the team
        // believe something is queued when it isn't (NotesSection does this).
        console.warn("[UPDATES] save failed:", err);
        setItems(prev);
        setSaveErr(true);
      });
  };

  const addItem = (draft: Omit<Announcement, "id" | "createdAt">) => {
    const item: Announcement = {
      ...draft,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    persist([item, ...items]);
    setAdding(false);
  };

  return (
    <div className="md:col-span-2 pt-3 border-t border-ink/10">
      <div className="flex items-center gap-3 mb-2">
        <div className="mono text-ink/50">📣 ANNOUNCEMENTS</div>
        <button
          onClick={() => setAdding((v) => !v)}
          className="mono text-xs border border-ink/25 hover:border-ink/60 px-2 py-0.5 transition-colors"
        >
          {adding ? "✕ Cancel" : "＋ Add"}
        </button>
        {saveErr && (
          <span className="mono text-xs text-red">Save failed — retry</span>
        )}
      </div>
      {adding && (
        <AnnouncementForm onAdd={addItem} onCancel={() => setAdding(false)} />
      )}
      {loaded && items.length === 0 && !adding && (
        <div className="serif-italic text-ink/50 text-sm">
          Nothing queued. Add a release, tour, merch drop, or bit of news, then
          broadcast it to the fanbase.
        </div>
      )}
      <div className="space-y-2 mt-2">
        {items.map((a) => (
          <AnnouncementItem
            key={a.id}
            a={a}
            onDelete={() => persist(items.filter((i) => i.id !== a.id))}
            onBroadcast={() => setBroadcast(a)}
          />
        ))}
      </div>
      {broadcast && (
        <BroadcastComposer
          announcement={broadcast}
          artistName={artistName}
          artistKey={artistKey}
          onClose={() => setBroadcast(null)}
        />
      )}
    </div>
  );
}

const ANNOUNCEMENT_TYPES: AnnouncementType[] = [
  "release",
  "tour",
  "merch",
  "news",
];

function AnnouncementForm({
  onAdd,
  onCancel,
}: {
  onAdd: (a: Omit<Announcement, "id" | "createdAt">) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<AnnouncementType>("release");
  const [headline, setHeadline] = useState("");
  const [date, setDate] = useState("");
  const [url, setUrl] = useState("");
  const [blurb, setBlurb] = useState("");
  const inputCls =
    "w-full bg-cream border border-ink/20 focus:border-ink/60 focus:outline-none px-2.5 py-1.5 text-sm";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!headline.trim()) return;
        onAdd({
          type,
          headline: headline.trim(),
          ...(date.trim() ? { date: date.trim() } : {}),
          ...(url.trim() ? { url: url.trim() } : {}),
          ...(blurb.trim() ? { blurb: blurb.trim() } : {}),
        });
      }}
      className="border border-ink/15 p-3 mb-2 space-y-2 bg-ink/[0.015]"
    >
      <div className="flex gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as AnnouncementType)}
          className="mono text-xs bg-cream border border-ink/20 px-2 py-1.5"
        >
          {ANNOUNCEMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {ANNOUNCEMENT_LABEL[t]}
            </option>
          ))}
        </select>
        <input
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
          placeholder="Headline (e.g. new single 'Think Of Me')"
          className={inputCls}
          autoFocus
        />
      </div>
      <div className="flex gap-2">
        <input
          value={date}
          onChange={(e) => setDate(e.target.value)}
          placeholder="When (optional)"
          className={inputCls}
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Link (optional)"
          className={inputCls}
        />
      </div>
      <textarea
        value={blurb}
        onChange={(e) => setBlurb(e.target.value)}
        placeholder="Details (optional)"
        rows={2}
        className={`${inputCls} resize-y`}
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!headline.trim()}
          className="mono text-xs px-3 h-8 bg-ink text-cream hover:bg-blue transition-colors disabled:opacity-30"
        >
          SAVE
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="mono text-xs px-3 h-8 border border-ink/25 hover:border-ink/60 transition-colors"
        >
          CANCEL
        </button>
      </div>
    </form>
  );
}

const TYPE_CHIP: Record<AnnouncementType, string> = {
  release: "border-blue/60 text-blue",
  tour: "border-red/60 text-red",
  merch: "border-lime/70 text-ink bg-lime/10",
  news: "border-ink/40 text-ink/70",
};

function AnnouncementItem({
  a,
  onDelete,
  onBroadcast,
}: {
  a: Announcement;
  onDelete: () => void;
  onBroadcast: () => void;
}) {
  return (
    <div className="flex items-start gap-3 border border-ink/12 px-3 py-2">
      <span
        className={`mono text-[0.6rem] border px-1.5 py-0.5 mt-0.5 shrink-0 ${TYPE_CHIP[a.type]}`}
      >
        {ANNOUNCEMENT_LABEL[a.type]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {a.headline}
          {a.date && <span className="text-ink/45 text-sm"> · {a.date}</span>}
        </div>
        {a.blurb && (
          <div className="serif-italic text-ink/65 text-sm mt-0.5">
            {a.blurb}
          </div>
        )}
        {a.url && (
          <a
            href={a.url}
            target="_blank"
            rel="noopener"
            className="mono text-xs text-blue hover:underline break-all"
          >
            {a.url} ↗
          </a>
        )}
      </div>
      <button
        onClick={onBroadcast}
        className="mono text-xs px-2.5 h-8 border border-blue/50 text-blue hover:bg-blue hover:text-cream transition-colors shrink-0"
        title="Compose a fanbase email about this"
      >
        ✉ Email fans
      </button>
      <button
        onClick={onDelete}
        className="mono text-ink/35 hover:text-red shrink-0 px-1"
        title="Delete"
        aria-label={`Delete ${a.headline}`}
      >
        ✕
      </button>
    </div>
  );
}

// Compose a fanbase broadcast: pick audience (all / a state), review/edit the
// email, then hand off — Gmail compose for small sends, batched + copy/CSV for
// big ones. Never sends on its own.
function BroadcastComposer({
  announcement,
  artistName,
  artistKey,
  onClose,
}: {
  announcement: Announcement;
  artistName: string;
  artistKey: string;
  onClose: () => void;
}) {
  const [fans, setFans] = useState<Customer[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [audience, setAudience] = useState<string>("all"); // "all" | state name
  const seeded = buildBroadcastEmail(announcement, artistName);
  const [subject, setSubject] = useState(seeded.subject);
  const [body, setBody] = useState(seeded.body);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/customers?id=${encodeURIComponent(artistKey)}&raw=1`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (Array.isArray(d.raw) && d.raw.length > 0) setFans(d.raw);
        else {
          setFans([]);
          setLoadErr("No fanbase uploaded for this artist yet.");
        }
      })
      .catch((err) => {
        console.warn("[BROADCAST] fanbase load failed:", err);
        if (!cancelled) {
          setFans([]);
          setLoadErr("Couldn't load the fanbase.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [artistKey]);

  // States present, by reachable-fan count. Dedupe by email per state (a Set,
  // not a row count) so each pill matches the actual deduped BCC list — repeat
  // buyers / case-variant duplicate addresses must not inflate the number.
  const states = useMemo(() => {
    if (!fans) return [];
    const m = new Map<string, Set<string>>();
    for (const c of fans) {
      const s = (c.state || "").trim();
      const e = customerEmail(c);
      if (s && e) {
        const set = m.get(s);
        if (set) set.add(e);
        else m.set(s, new Set([e]));
      }
    }
    return [...m.entries()]
      .map(([s, set]) => [s, set.size] as [string, number])
      .sort((a, b) => b[1] - a[1]);
  }, [fans]);

  // Deduped recipient emails for the chosen audience.
  const emails = useMemo(() => {
    if (!fans) return [];
    const set = new Set<string>();
    for (const c of fans) {
      if (audience !== "all" && (c.state || "").trim() !== audience) continue;
      const e = customerEmail(c);
      if (e) set.add(e);
    }
    return [...set];
  }, [fans, audience]);

  const GMAIL_CAP = 400;
  const batches = Math.max(1, Math.ceil(emails.length / GMAIL_CAP));
  const su = encodeURIComponent(subject);
  const bd = encodeURIComponent(body);
  const openGmail = (slice: string[]) => {
    window.open(
      `https://mail.google.com/mail/?view=cm&fs=1&bcc=${encodeURIComponent(slice.join(","))}&su=${su}&body=${bd}`,
      "_blank",
      "noopener,noreferrer",
    );
    // Log the broadcast so the outreach ledger remembers it (feeds the
    // dashboard's "last reached out" + recurrence guards).
    fetch("/api/outreach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        artist: artistKey,
        channel: "broadcast",
        target: announcement.headline,
        recipientCount: slice.length,
        note: ANNOUNCEMENT_LABEL[announcement.type],
      }),
    }).catch((err) => console.warn("[OUTREACH] broadcast log failed:", err));
  };
  const copyEmails = () =>
    navigator.clipboard
      ?.writeText(emails.join(", "))
      .catch((err) => console.warn("[BROADCAST] copy failed:", err));
  const downloadCsv = () => {
    const csv = `email\n${emails.join("\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    const seg = audience === "all" ? "all" : audience;
    a.download = `${artistName.replace(/\W+/g, "-").toLowerCase()}-${seg.replace(/\W+/g, "-").toLowerCase()}-emails.csv`;
    a.click();
    URL.revokeObjectURL(u);
  };

  return (
    <div className="broadcast-overlay" onClick={onClose}>
      <div
        className="broadcast-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="broadcast-head">
          <div>
            <div className="broadcast-kicker">
              Broadcast · {ANNOUNCEMENT_LABEL[announcement.type]}
            </div>
            <div className="broadcast-title">{announcement.headline}</div>
          </div>
          <button className="broadcast-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="broadcast-body">
          {/* Audience */}
          <div className="broadcast-field">
            <div className="broadcast-label">Audience</div>
            <div className="broadcast-aud">
              <button
                className={`broadcast-pill${audience === "all" ? " active" : ""}`}
                onClick={() => setAudience("all")}
              >
                All fans{fans ? ` · ${totalReachable(fans)}` : ""}
              </button>
              {states.slice(0, 8).map(([s, n]) => (
                <button
                  key={s}
                  className={`broadcast-pill${audience === s ? " active" : ""}`}
                  onClick={() => setAudience(s)}
                >
                  {s} · {n}
                </button>
              ))}
              {states.length > 8 && (
                <select
                  value={states.some(([s]) => s === audience) ? audience : ""}
                  onChange={(e) =>
                    e.target.value && setAudience(e.target.value)
                  }
                  className="broadcast-pill"
                >
                  <option value="">more states…</option>
                  {states.slice(8).map(([s, n]) => (
                    <option key={s} value={s}>
                      {s} · {n}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Message */}
          <div className="broadcast-field">
            <div className="broadcast-label">Subject</div>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="broadcast-input"
            />
          </div>
          <div className="broadcast-field">
            <div className="broadcast-label">Message</div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={9}
              className="broadcast-input broadcast-textarea"
            />
          </div>

          {/* Handoff */}
          <div className="broadcast-send">
            {fans === null ? (
              <div className="broadcast-note">Loading fanbase…</div>
            ) : loadErr ? (
              <div className="broadcast-note err">{loadErr}</div>
            ) : emails.length === 0 ? (
              <div className="broadcast-note">
                No reachable emails in this audience.
              </div>
            ) : (
              <>
                <div className="broadcast-recip">
                  {emails.length.toLocaleString()} recipient
                  {emails.length === 1 ? "" : "s"}
                  {batches > 1
                    ? ` · ${batches} Gmail batches of ≤${GMAIL_CAP}`
                    : ""}
                </div>
                {emails.length <= GMAIL_CAP ? (
                  <button
                    className="broadcast-go"
                    onClick={() => openGmail(emails)}
                  >
                    ✉ Open in Gmail · {emails.length} BCC&apos;d
                  </button>
                ) : (
                  <div className="broadcast-batches">
                    {Array.from({ length: batches }, (_, i) => (
                      <button
                        key={i}
                        className="broadcast-batch"
                        onClick={() =>
                          openGmail(
                            emails.slice(i * GMAIL_CAP, (i + 1) * GMAIL_CAP),
                          )
                        }
                      >
                        Gmail {i + 1}/{batches}
                      </button>
                    ))}
                  </div>
                )}
                <div className="broadcast-alt">
                  <button onClick={copyEmails}>⎘ Copy all emails</button>
                  <button onClick={downloadCsv}>⇣ CSV for your ESP</button>
                </div>
                <div className="broadcast-note">
                  Nothing sends automatically. Big lists: paste the CSV into
                  Klaviyo/Mailchimp (they handle unsubscribe), or fire the Gmail
                  batches one at a time.
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function totalReachable(fans: Customer[]): number {
  const set = new Set<string>();
  for (const c of fans) {
    const e = customerEmail(c);
    if (e) set.add(e);
  }
  return set.size;
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
