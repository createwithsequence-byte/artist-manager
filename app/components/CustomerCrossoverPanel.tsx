"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Papa from "papaparse";
import {
  crossover,
  buildRevisedTour,
  aggregateByCity,
  parseCustomers,
  proposeFutureTour,
  type Customer,
  type CustomerCrossover,
  type GeocodeMap,
  type Leg,
  type RoutingStyle,
  type RoutingSuggestion,
} from "@/lib/customerCrossover";
import type { Event as ArtistEvent } from "@/lib/types";
import { TourChat } from "./TourChat";
import { buildTourContext, type ProposedStop } from "@/lib/tourChat";

const TourMap = dynamic(() => import("./TourMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[380px] md:h-[460px] border border-ink/15 flex items-center justify-center mono text-ink/40">
      LOADING MAP…
    </div>
  ),
});

type Props = { events: ArtistEvent[]; artistName: string };

type Loaded = { fileName: string; customers: Customer[]; geocode: GeocodeMap };
type Stage =
  | { kind: "idle" }
  | { kind: "parsing"; fileName: string }
  | { kind: "ready"; loaded: Loaded }
  | { kind: "error"; message: string };

export function CustomerCrossoverPanel({ events, artistName }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const [radiusMiles, setRadiusMiles] = useState(60);
  // Tracks whether the current ready state was hydrated from the SF World
  // master dataset (vs uploaded locally this session). Drives the "USING
  // MASTER" badge in the panel header so the source of truth is visible.
  const [usingMaster, setUsingMaster] = useState(false);
  const inputId = `crossover-csv-${artistName.replace(/\W+/g, "-")}`;
  const fileInput = useRef<HTMLInputElement>(null);

  // On mount: try to hydrate from the canonical SF master dataset so the
  // user doesn't re-upload the same CSV across sessions. Stays in idle if
  // no master exists or Turso isn't configured — the drop zone takes over.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/customers?id=master&raw=1")
      .then((r) => r.json())
      .then(async (d) => {
        if (cancelled) return;
        if (d?.dataset && Array.isArray(d?.raw) && d.raw.length > 0) {
          const { US_CITY_LATLNG } = await import("@/lib/usCityToLatLng");
          if (cancelled) return;
          setStage({
            kind: "ready",
            loaded: {
              fileName: `★ MASTER · ${d.dataset.name}`,
              customers: d.raw as Customer[],
              geocode: US_CITY_LATLNG as unknown as GeocodeMap,
            },
          });
          setUsingMaster(true);
        }
      })
      .catch((err) =>
        console.warn(
          "[CROSSOVER]",
          err instanceof Error ? err.message : String(err),
        ),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFile = (file: File) => {
    setStage({ kind: "parsing", fileName: file.name });
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (result) => {
        try {
          const customers = parseCustomers(result.data);
          const { US_CITY_LATLNG } = await import("@/lib/usCityToLatLng");
          const geocode = US_CITY_LATLNG as unknown as GeocodeMap;
          setStage({
            kind: "ready",
            loaded: {
              fileName: file.name,
              customers,
              geocode,
            },
          });
          setUsingMaster(false);

          // Persist as the canonical SF master so SF World + future routing
          // sessions hydrate from the same source. Replaces any existing
          // master — Greg explicitly asked for "upload stays stored until a
          // new one is integrated." Fire-and-forget; UI shouldn't block.
          const { aggregate } = aggregateByCity(customers, geocode);
          fetch("/api/customers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: "master",
              name: file.name,
              aggregate,
              customerCount: customers.length,
              raw: customers,
            }),
          })
            .then((r) => r.json())
            .then((d) => {
              if (d?.ok) setUsingMaster(true);
            })
            .catch((err) =>
              console.warn(
                "[CROSSOVER] master persist failed:",
                err instanceof Error ? err.message : String(err),
              ),
            );
        } catch (err) {
          setStage({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
      error: (err) =>
        setStage({ kind: "error", message: err.message ?? "Parse failed" }),
    });
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  if (!events || events.length === 0) {
    return (
      <div className="serif-italic text-ink/55 text-sm">
        No upcoming events for {artistName}. Routing needs tour dates to plot —
        re-scout when {artistName} announces something.
      </div>
    );
  }

  return (
    <div>
      {stage.kind === "idle" && (
        <>
          <label
            htmlFor={inputId}
            onDrop={onDrop}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            className={`block cursor-pointer border-2 border-dashed transition-colors p-4 md:p-6 ${
              dragOver
                ? "border-red bg-red/5"
                : "border-ink/25 hover:border-ink/60"
            }`}
          >
            <div className="mono mb-1">UPLOAD CUSTOMER CSV → ROUTING SHEET</div>
            <div className="serif-italic text-ink/65 text-sm">
              Expected columns: <span className="mono">city, state</span> (plus
              anything else). Saved as the SF master — used here and on the ◯ SF
              World globe. Stays until you upload a new one.
            </div>
          </label>
          <input
            ref={fileInput}
            id={inputId}
            type="file"
            accept=".csv,text/csv,application/vnd.ms-excel,application/csv"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </>
      )}

      {stage.kind === "parsing" && (
        <div className="mono flex items-center gap-2 text-ink/60">
          <span className="inline-block w-2 h-2 rounded-full bg-red pulse-dot" />
          PARSING {stage.fileName}…
        </div>
      )}

      {stage.kind === "error" && (
        <div className="mono text-red">FAILED · {stage.message}</div>
      )}

      {stage.kind === "ready" && (
        <RoutingSheet
          loaded={stage.loaded}
          events={events}
          artistName={artistName}
          radiusMiles={radiusMiles}
          setRadiusMiles={setRadiusMiles}
          usingMaster={usingMaster}
          onReset={() => {
            setUsingMaster(false);
            setStage({ kind: "idle" });
          }}
        />
      )}
    </div>
  );
}

// ── leg severity grammar ──────────────────────────────────────────────────
function legDisplay(leg: Leg) {
  const dark = leg.gapDays >= 3;
  const milesPerDay = leg.segmentMiles / Math.max(leg.gapDays, 1);
  const fly = leg.segmentMiles > 600 && leg.gapDays <= 1;
  const driveHard = !fly && milesPerDay > 500;
  const verdict = fly
    ? "✈ FLY"
    : driveHard
      ? "DRIVE HARD"
      : dark
        ? "DARK"
        : "DRIVE OK";
  const slack = leg.gapDays < 7 ? 1 : leg.gapDays <= 21 ? 2 : 3;
  const color = dark ? "text-red" : fly ? "text-blue" : "text-ink/45";
  const railColor = dark ? "bg-red" : "bg-ink/20";
  const railWidth = dark ? "w-[3px]" : "w-px";
  return { dark, fly, verdict, slack, color, railColor, railWidth };
}

function fmtDay(date: string): string {
  // Parse at NOON so the YYYY-MM-DD (UTC-midnight) value doesn't shift back a
  // day when rendered in a US timezone — the classic off-by-one.
  const d = new Date(`${date}T12:00:00`);
  if (isNaN(d.getTime())) return date;
  return d
    .toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    })
    .toUpperCase();
}

function RoutingSheet({
  loaded,
  events,
  artistName,
  radiusMiles,
  setRadiusMiles,
  usingMaster,
  onReset,
}: {
  loaded: Loaded;
  events: ArtistEvent[];
  artistName: string;
  radiusMiles: number;
  setRadiusMiles: (n: number) => void;
  usingMaster: boolean;
  onReset: () => void;
}) {
  const [selectedLeg, setSelectedLeg] = useState<number | null>(null);
  const [provisional, setProvisional] = useState<ArtistEvent[]>([]);
  const [planOpen, setPlanOpen] = useState(false);
  // Defer the radius fed to the (two) crossover passes so dragging the slider
  // stays responsive — the thumb + labels track the live value, the heavy
  // recompute catches up a tick later.
  const dRadius = useDeferredValue(radiusMiles);

  // Routing mode — CURRENT (gap-fill booked dates, today's behavior) vs
  // TOUR HERE (Jesse's "tour where the fans are" — propose a from-scratch run
  // through the densest untapped markets). Peer modes; defaults to CURRENT.
  const [mode, setMode] = useState<"current" | "tourhere">("current");
  // TOUR HERE inputs
  const [thCount, setThCount] = useState(8);
  const [thStart, setThStart] = useState(() =>
    new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
  );
  const [thSpacing, setThSpacing] = useState(4);
  const [thStyle, setThStyle] = useState<RoutingStyle>("geographic");
  // The proposed future tour the user is reviewing (before APPLY ALL).
  const [thProposal, setThProposal] = useState<ArtistEvent[]>([]);

  // Provisional what-if stops are appended to the event list; crossover
  // re-geocodes + re-sorts by date, so they slot into the spine + redraw the
  // route automatically. Keys flag them for distinct styling.
  const provisionalKeys = useMemo(
    () => new Set(provisional.map((p) => `${p.date}|${p.city}`)),
    [provisional],
  );
  const allEvents = useMemo(
    () => [...events, ...provisional],
    [events, provisional],
  );

  const result: CustomerCrossover = useMemo(
    () =>
      crossover(loaded.customers, allEvents, {
        radiusMiles: dRadius,
        geocode: loaded.geocode,
      }),
    [loaded, allEvents, dRadius],
  );

  // Baseline = anchored dates only. Used to compute the revised tour (so fills
  // are decided against the real dates, not a route already rerouted through
  // earlier fills) and to show the before→after reach delta.
  const baseline: CustomerCrossover = useMemo(
    () =>
      crossover(loaded.customers, events, {
        radiusMiles: dRadius,
        geocode: loaded.geocode,
      }),
    [loaded, events, dRadius],
  );

  // Build the chronological spine: shows sorted by date, with the matching
  // Leg connector slotted between consecutive shows.
  const shows = useMemo(
    () =>
      [...result.perEvent].sort((a, b) =>
        a.event.date < b.event.date ? -1 : a.event.date > b.event.date ? 1 : 0,
      ),
    [result.perEvent],
  );
  const legByPair = useMemo(() => {
    const m = new Map<string, { leg: Leg; index: number }>();
    result.legs.forEach((leg, index) => {
      m.set(`${leg.fromDate}|${leg.fromCity}|${leg.toDate}|${leg.toCity}`, {
        leg,
        index,
      });
    });
    return m;
  }, [result.legs]);

  const acceptSuggestion = (s: RoutingSuggestion) => {
    const key = `${s.suggestedDate}|${s.city}`;
    if (provisionalKeys.has(key)) return;
    // Reset selection: inserting a stop splits the gap and shifts every later
    // leg index, so a held selectedLeg would open the wrong tray / fly the map
    // to an unrelated leg.
    setSelectedLeg(null);
    setProvisional((prev) => [
      ...prev,
      {
        date: s.suggestedDate,
        city: s.city,
        state: s.stateCode,
        venue: "PROVISIONAL",
      } as ArtistEvent,
    ]);
  };
  const removeProvisional = (date: string, city: string) =>
    setProvisional((prev) =>
      prev.filter((p) => !(p.date === date && p.city === city)),
    );

  const revisedActive = provisional.length > 0;
  const buildRevised = () => {
    setSelectedLeg(null);
    setProvisional(buildRevisedTour(baseline));
  };
  const resetRevised = () => setProvisional([]);

  // TOUR HERE handlers — propose against the BASELINE untapped pool so it's
  // independent of any provisional stops the user has already accepted.
  const proposeTourHere = () => {
    const proposal = proposeFutureTour({
      count: thCount,
      startDate: thStart,
      spacingDays: thSpacing,
      style: thStyle,
      untapped: baseline.untappedMarkets,
    });
    setThProposal(proposal);
  };
  // TOUR HERE preview crossover — runs the engine against just the proposal
  // so the preview block can show per-stop fan counts without committing the
  // proposal into provisional yet. Memoized on (customers, thProposal, radius).
  const thPreview: CustomerCrossover | null = useMemo(() => {
    if (thProposal.length === 0) return null;
    return crossover(loaded.customers, thProposal, {
      radiusMiles: dRadius,
      geocode: loaded.geocode,
    });
  }, [loaded, thProposal, dRadius]);

  // APPLY ALL merges (matching applyAgentStops) so any manual ⊕ stops the
  // user already accepted survive. Dedupes by date|city. Clears the preview
  // after apply so the spine takes over — re-PROPOSE to compare.
  const applyTourHere = () => {
    if (thProposal.length === 0) return;
    setSelectedLeg(null);
    setProvisional((prev) => {
      const seen = new Set(prev.map((p) => `${p.date}|${p.city}`));
      const additions = thProposal.filter(
        (p) => !seen.has(`${p.date}|${p.city}`),
      );
      return [...prev, ...additions];
    });
    setThProposal([]);
    // Land the user on the committed view — the proposal is now interleaved
    // with the booked tour in the spine, which is CURRENT-mode territory.
    setMode("current");
  };

  // EXPORT MAILING LIST — flatten thPreview's per-stop "nearby" customers
  // (names already grouped by city by the engine) into one CSV row per fan,
  // then trigger a Blob download. No server round-trip. Empty-state guarded.
  const exportMailingList = () => {
    if (!thPreview || thProposal.length === 0) return;
    const rows: string[][] = [
      [
        "fan_name",
        "fan_city",
        "fan_state",
        "stop_city",
        "stop_state",
        "stop_date",
        "within_miles",
      ],
    ];
    thPreview.perEvent.forEach((pe) => {
      const stopCity = pe.event.city;
      const stopState = pe.event.state || pe.stateCode || "";
      const stopDate = pe.event.date;
      pe.nearby.forEach((n) => {
        n.names.forEach((name) => {
          rows.push([
            name,
            n.city,
            n.stateCode,
            stopCity,
            stopState,
            stopDate,
            String(dRadius),
          ]);
        });
      });
    });
    // RFC 4180-ish CSV escape: wrap any field with a comma, quote, or newline
    // in double quotes and double any internal quotes. Headers always safe.
    const esc = (s: string) =>
      /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    const csv = rows.map((r) => r.map(esc).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${artistName.replace(/\W+/g, "-").toLowerCase()}-tour-here-mailing-list.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const resetTourHere = () => setThProposal([]);

  // Apply the agent's proposed stops. Validates each against the bundled
  // lat/lng (a city we can't place would silently vanish from the map and
  // dilute reach), MERGES into the existing provisional set (so manual ⊕
  // fills / a built revised tour aren't discarded), dedupes by date|city, and
  // returns counts so the chat can report "applied N of M (1 not found)".
  const applyAgentStops = (
    stops: ProposedStop[],
  ): { placed: number; dropped: number } => {
    setSelectedLeg(null);
    const placeable = stops.filter(
      (s) =>
        !!loaded.geocode[
          `${s.city.toLowerCase().trim()}|${(s.state || "").toUpperCase()}`
        ],
    );
    const dropped = stops.length - placeable.length;
    setProvisional((prev) => {
      const seen = new Set(prev.map((p) => `${p.date}|${p.city}`));
      const additions = placeable
        .filter((s) => !seen.has(`${s.date}|${s.city}`))
        .map(
          (s) =>
            ({
              date: s.date,
              city: s.city,
              state: s.state,
              venue: "PROVISIONAL",
            }) as ArtistEvent,
        );
      return [...prev, ...additions];
    });
    return { placed: placeable.length, dropped };
  };
  // Diff the DISPLAYED (rounded) percentages so "14% → 17%" reads as "+3pts",
  // never a rounding-artifact "+2pts".
  const reachDeltaPts =
    Math.round(result.reachPct * 100) - Math.round(baseline.reachPct * 100);
  const addedMiles = Math.max(
    0,
    result.totalRouteMiles - baseline.totalRouteMiles,
  );

  const coverageBlocks = Math.round(result.reachPct * 5);
  const dateRange =
    shows.length > 0
      ? `${fmtDay(shows[0].event.date)} → ${fmtDay(shows[shows.length - 1].event.date)}`
      : "";

  // Map shows the selected leg's candidates when a leg is open, else all.
  const mapSuggestions =
    selectedLeg !== null && result.legs[selectedLeg]
      ? result.legs[selectedLeg].suggestions.map((s) => ({
          lat: s.lat,
          lng: s.lng,
          city: s.city,
          customers: s.customers,
        }))
      : result.mapData.suggestions;

  return (
    <div>
      {/* Header */}
      <div className="mono text-ink/55 mb-2 flex flex-wrap gap-x-4 gap-y-1 items-baseline">
        <span className="display text-lg text-ink">
          {artistName.toUpperCase()} — ROUTING SHEET
        </span>
        <span className="text-ink/40">{loaded.fileName}</span>
        {usingMaster && (
          <span
            className="text-lime"
            title="Hydrated from the SF master dataset. Replace to upload a new master."
          >
            ● SF MASTER
          </span>
        )}
        <button
          onClick={onReset}
          className="mono text-ink/50 underline ml-auto hover:text-red"
          title="Upload a different CSV — replaces the SF master"
        >
          REPLACE
        </button>
      </div>

      {/* Route strip — orientation, not verdict */}
      <div className="mono text-ink/70 border-y border-ink/15 py-2 mb-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span>{shows.length} DATES</span>
        <span className="text-ink/40">·</span>
        <span>{dateRange}</span>
        <span className="text-ink/40">·</span>
        <span>{result.totalRouteMiles.toLocaleString()} RTE MI</span>
        <span className="text-ink/40">·</span>
        <span>LONGEST GAP {result.longestGapDays}D</span>
        <span className="text-ink/40">·</span>
        <span className="flex items-center gap-1">
          FAN COVERAGE
          <span className="tracking-tight">
            {"▓".repeat(coverageBlocks)}
            <span className="text-ink/25">
              {"░".repeat(5 - coverageBlocks)}
            </span>
          </span>
          {Math.round(result.reachPct * 100)}%
          {result.reachPct < 0.15 && <span className="text-red ml-1">⚑</span>}
        </span>
      </div>

      {/* Sticky mode toggle — peer modes: keep the booked dates (CURRENT)
          vs propose a from-scratch fan-first run (TOUR HERE). Per the redesign
          this lives just above the routing controls so flipping never loses
          scroll position. role=radiogroup so screen readers announce the
          mode set; arrow keys would be a future polish. */}
      <div
        className="sticky top-0 z-20 -mx-1 px-1 py-2 bg-cream/95 backdrop-blur border-b border-ink/15 mb-3 flex items-center gap-3"
        role="radiogroup"
        aria-label="Routing mode"
      >
        <span className="mono text-ink/45 text-xs hidden sm:inline">
          ROUTING
        </span>
        <div className="flex border border-ink/25 mono text-xs">
          <button
            role="radio"
            aria-checked={mode === "current"}
            onClick={() => setMode("current")}
            className={`px-3 h-8 transition-colors ${
              mode === "current"
                ? "bg-ink text-cream"
                : "text-ink/55 hover:text-ink"
            }`}
            title="Fill gaps between his booked dates"
          >
            ● CURRENT TOUR
          </button>
          <button
            role="radio"
            aria-checked={mode === "tourhere"}
            onClick={() => setMode("tourhere")}
            className={`px-3 h-8 border-l border-ink/25 transition-colors ${
              mode === "tourhere"
                ? "bg-ink text-cream"
                : "text-ink/55 hover:text-ink"
            }`}
            title="Propose a from-scratch tour through his fanbase"
          >
            ✦ TOUR HERE
          </button>
        </div>
        <span className="serif-italic text-ink/55 text-xs hidden md:inline">
          {mode === "current"
            ? "Fill the gaps in his booked run."
            : "Build a future tour from his fanbase, from scratch."}
        </span>
      </div>

      {/* TOUR HERE controls — only render in tourhere mode. Inputs are dense,
          mono labels, on-system. Propose stays disabled when there's no
          untapped pool to draw from. */}
      {mode === "tourhere" && (
        <div className="mb-4 border border-ink/15 bg-ink/[0.02] p-3 flex flex-wrap items-end gap-x-4 gap-y-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="mono text-ink/50 text-xs">HOW MANY SHOWS</span>
            <input
              type="number"
              min={2}
              max={40}
              value={thCount}
              onChange={(e) =>
                setThCount(
                  Math.max(2, Math.min(40, parseInt(e.target.value, 10) || 8)),
                )
              }
              className="mono w-20 border border-ink/25 bg-cream px-2 h-9 focus:outline-none focus:border-ink"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="mono text-ink/50 text-xs">STARTING</span>
            <input
              type="date"
              value={thStart}
              onChange={(e) => setThStart(e.target.value)}
              className="mono border border-ink/25 bg-cream px-2 h-9 focus:outline-none focus:border-ink"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="mono text-ink/50 text-xs">SPACING (DAYS)</span>
            <input
              type="number"
              min={1}
              max={30}
              value={thSpacing}
              onChange={(e) =>
                setThSpacing(
                  Math.max(1, Math.min(30, parseInt(e.target.value, 10) || 4)),
                )
              }
              className="mono w-20 border border-ink/25 bg-cream px-2 h-9 focus:outline-none focus:border-ink"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="mono text-ink/50 text-xs">ROUTING STYLE</span>
            <div className="flex border border-ink/25 mono text-xs">
              {(
                [
                  ["geographic", "GEO CHAIN"],
                  ["density", "DENSITY"],
                  ["corridor", "CORRIDOR"],
                ] as const
              ).map(([k, label], i) => (
                <button
                  key={k}
                  onClick={() => setThStyle(k)}
                  className={`px-2.5 h-9 ${i > 0 ? "border-l border-ink/25" : ""} transition-colors ${
                    thStyle === k
                      ? "bg-ink text-cream"
                      : "text-ink/60 hover:text-ink"
                  }`}
                  title={
                    k === "geographic"
                      ? "Greedy nearest-neighbor — drivable, agent-style"
                      : k === "density"
                        ? "Top by fan count, ignore distance — fly anchors"
                        : "One geographic axis (Southeast, West Coast, …)"
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </label>
          <button
            onClick={proposeTourHere}
            disabled={baseline.untappedMarkets.length === 0}
            className="mono px-3 h-9 bg-blue text-cream hover:bg-ink transition-colors disabled:opacity-30"
          >
            {thProposal.length > 0 ? "RE-PROPOSE" : "PROPOSE TOUR"} →
          </button>
          {thProposal.length > 0 && (
            <>
              <button
                onClick={applyTourHere}
                className="mono px-3 h-9 bg-red text-cream hover:bg-ink transition-colors"
                title="Drop these stops into the spine as additive tour dates"
              >
                ⊕ APPLY ALL {thProposal.length}
              </button>
              <button
                onClick={exportMailingList}
                className="mono px-3 h-9 border border-ink text-ink hover:bg-ink hover:text-cream transition-colors"
                title="Download a CSV of every fan within radius of these stops"
              >
                ⇣ EXPORT MAILING LIST
              </button>
              <button
                onClick={resetTourHere}
                className="mono text-ink/50 underline hover:text-red"
              >
                CLEAR
              </button>
            </>
          )}
          {baseline.untappedMarkets.length === 0 && (
            <span className="serif-italic text-ink/55 text-xs">
              No untapped markets in the customer file — every dense city is
              already within range of a booked stop. (Try a wider radius.)
            </span>
          )}
        </div>
      )}

      {/* TOUR HERE preview — chronological list of the proposed stops with
          fan counts pulled from a one-shot crossover against just the
          proposal. Sits above the spine so the user reviews before APPLY.
          Mono row format mirrors the spine's visual rhythm; this is a
          preview, not a final selectable list, so no per-row controls. */}
      {mode === "tourhere" && thProposal.length > 0 && thPreview && (
        <div className="mb-4 border border-blue/40 bg-blue/[0.04]">
          <div className="px-3 py-2 border-b border-blue/30 flex items-baseline gap-3 mono text-xs">
            <span className="text-blue">
              PROPOSED · {thProposal.length} STOPS
            </span>
            <span className="text-ink/60">
              {thPreview.reachedCustomers.toLocaleString()} FANS REACHED
            </span>
            <span className="text-ink/45">
              ({Math.round(thPreview.reachPct * 100)}% OF FILE @ {dRadius}MI)
            </span>
            <span className="text-ink/45 ml-auto serif-italic">
              Review then APPLY ALL to commit to the spine.
            </span>
          </div>
          <ol className="divide-y divide-blue/15">
            {[...thPreview.perEvent]
              .sort((a, b) =>
                a.event.date < b.event.date
                  ? -1
                  : a.event.date > b.event.date
                    ? 1
                    : 0,
              )
              .map((pe, i) => (
                <li
                  key={`${pe.event.date}-${pe.event.city}`}
                  className="px-3 py-2 flex items-baseline gap-3 text-sm"
                >
                  <span className="mono text-ink/40 w-6 tabular-nums">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="mono text-ink/70 w-24">
                    {fmtDay(pe.event.date)}
                  </span>
                  <span className="font-medium">
                    {pe.event.city}
                    <span className="text-ink/45">
                      , {pe.event.state || pe.stateCode || "??"}
                    </span>
                  </span>
                  <span className="mono text-blue ml-auto tabular-nums">
                    {pe.withinRadiusCount.toLocaleString()} FANS
                  </span>
                </li>
              ))}
          </ol>
        </div>
      )}

      {/* CURRENT-MODE revised-tour bar — only render in current mode. */}
      {mode === "current" && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {!revisedActive ? (
            <>
              <button
                onClick={buildRevised}
                className="mono px-3 h-9 bg-blue text-cream hover:bg-ink transition-colors"
              >
                BUILD REVISED TOUR →
              </button>
              <span className="serif-italic text-ink/55 text-sm">
                Auto-fills every gap with the best customer cities on-route at{" "}
                {radiusMiles}mi — keeps your anchored dates, adds stops between
                them.
              </span>
            </>
          ) : (
            <>
              <span className="mono text-blue">
                REVISED ✓ +{provisional.length} STOP
                {provisional.length === 1 ? "" : "S"}
              </span>
              <span className="mono text-ink/70">
                REACH {Math.round(baseline.reachPct * 100)}% →{" "}
                <span className="text-red">
                  {Math.round(result.reachPct * 100)}%
                </span>
                {reachDeltaPts > 0 && (
                  <span className="text-ink/45"> (+{reachDeltaPts}pts)</span>
                )}
              </span>
              {addedMiles > 0 && (
                <span className="mono text-ink/45">
                  +{addedMiles.toLocaleString()} MI
                </span>
              )}
              <button
                onClick={buildRevised}
                className="mono text-ink/50 underline hover:text-ink"
                title="Recompute at the current radius"
              >
                REBUILD @ {radiusMiles}MI
              </button>
              <button
                onClick={resetRevised}
                className="mono text-ink/50 underline hover:text-red"
              >
                RESET
              </button>
            </>
          )}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-x-8 gap-y-4">
        {/* THE SPINE */}
        <div className="relative">
          {shows.map((show, i) => {
            const next = shows[i + 1];
            const pairKey = next
              ? `${show.event.date}|${show.event.city}|${next.event.date}|${next.event.city}`
              : "";
            const legMatch = next ? legByPair.get(pairKey) : undefined;
            return (
              <div key={`${show.event.date}-${show.event.city}-${i}`}>
                <ShowRow
                  show={show}
                  index={i}
                  radiusMiles={radiusMiles}
                  provisional={provisionalKeys.has(
                    `${show.event.date}|${show.event.city}`,
                  )}
                  selected={legMatch ? selectedLeg === legMatch.index : false}
                  onRemove={
                    show.event.venue === "PROVISIONAL"
                      ? () =>
                          removeProvisional(show.event.date, show.event.city)
                      : undefined
                  }
                  onSelect={() => setSelectedLeg(null)}
                />
                {legMatch && (
                  <LegConnector
                    leg={legMatch.leg}
                    legIndex={legMatch.index}
                    open={selectedLeg === legMatch.index}
                    onToggle={() =>
                      setSelectedLeg(
                        selectedLeg === legMatch.index ? null : legMatch.index,
                      )
                    }
                    onAccept={acceptSuggestion}
                    acceptedKeys={provisionalKeys}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* MAP — spatial twin */}
        <div>
          <TourMap
            stops={result.mapData.stops}
            customerPoints={result.mapData.customerPoints}
            suggestions={mapSuggestions}
            radiusMiles={radiusMiles}
            selectedLeg={selectedLeg}
            provisionalKeys={provisionalKeys}
            onSelectStop={() => setSelectedLeg(null)}
            onSelectLeg={(i) => setSelectedLeg(selectedLeg === i ? null : i)}
          />
          <div className="mono text-ink/35 text-xs mt-1 flex flex-wrap gap-x-4">
            <span>
              <span className="text-red">●</span> TOUR STOP
            </span>
            <span>
              <span className="text-blue">◇</span> FILL CANDIDATE
            </span>
            <span>FAN DENSITY · cold→hot</span>
            {selectedLeg !== null && result.legs[selectedLeg] && (
              <span className="text-ink/55">
                SELECTED · {result.legs[selectedLeg].fromCity} →{" "}
                {result.legs[selectedLeg].toCity}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Sticky radius lens */}
      <div className="sticky bottom-0 bg-cream/95 backdrop-blur border-t border-ink/15 mt-5 py-3 flex items-center gap-4">
        <span className="mono text-ink/55 shrink-0">
          RADIUS · {radiusMiles}MI
        </span>
        <input
          type="range"
          min={25}
          max={250}
          step={5}
          value={radiusMiles}
          onChange={(e) => setRadiusMiles(parseInt(e.target.value, 10))}
          className="flex-1 accent-red"
        />
        <span className="mono text-ink/35 shrink-0 hidden sm:inline">
          recounts reach · widens fill corridor
        </span>
      </div>

      {/* Untapped shelf + verdict */}
      <UntappedShelf
        result={result}
        planOpen={planOpen}
        setPlanOpen={setPlanOpen}
      />

      {/* Conversational tour agent — give context, it revises the run */}
      <TourChat
        context={buildTourContext(result, artistName, radiusMiles)}
        onApplyStops={applyAgentStops}
      />

      <div className="mt-4 serif-italic text-ink/45 text-xs">
        Straight-line (great-circle) miles from city centers — close enough to
        rank routing. Customers without a recognizable US city aren&apos;t
        plotted.
      </div>
    </div>
  );
}

// ── show row ────────────────────────────────────────────────────────────────
function ShowRow({
  show,
  index,
  radiusMiles,
  provisional,
  selected,
  onRemove,
  onSelect,
}: {
  show: CustomerCrossover["perEvent"][number];
  index: number;
  radiusMiles: number;
  provisional: boolean;
  selected: boolean;
  onRemove?: () => void;
  onSelect: () => void;
}) {
  const [whoOpen, setWhoOpen] = useState(false);
  const useRadius = show.lat !== undefined && show.lng !== undefined;
  const count = useRadius ? show.withinRadiusCount : show.sameStateCount;
  const offFanbase = useRadius && show.withinRadiusCount === 0;
  const nearby = show.nearby ?? [];
  const inCity = nearby.find((n) => n.isSameCity);
  const secondary = nearby.filter((n) => !n.isSameCity);
  const hasWho = nearby.length > 0;

  return (
    <div className="relative pl-10 py-2.5" onClick={onSelect}>
      {/* rail */}
      <div className="absolute left-[1.05rem] inset-y-0 w-px bg-ink/15" />
      <span
        className="absolute left-[0.55rem] top-3 w-3 h-3 rounded-full border-2"
        style={{
          background: provisional
            ? "#F4EFE6"
            : selected
              ? "#F23222"
              : "#0A0A0A",
          borderColor: provisional ? "#1E2DDB" : "#F23222",
          borderStyle: provisional ? "dashed" : "solid",
        }}
      />
      <div className="flex items-baseline gap-3">
        <span className="mono text-ink/55 shrink-0 w-28">
          {fmtDay(show.event.date)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">
            {show.event.venue === "PROVISIONAL" ? (
              // Sequence index keeps the ordinal context that "PROVISIONAL"
              // (now ADDITIVE) buried in the spine. Blue, mono, prefixed with
              // the run-order ordinal so a glance reads "this is stop 04 and
              // it's one I added on top of the booked dates."
              <span className="text-blue mono">
                ADDITIVE TOUR DATE · #{String(index + 1).padStart(2, "0")}
              </span>
            ) : (
              show.event.venue || "Venue TBD"
            )}
          </div>
        </div>
        <span className="mono text-ink/60 shrink-0 text-right">
          {(show.event.city || "?").toUpperCase()}
        </span>
        {onRemove && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="mono text-ink/40 hover:text-red shrink-0"
            title="Remove this additive date"
          >
            ✕
          </button>
        )}
      </div>
      {/* fan chip */}
      <div className="ml-[7.75rem] mt-0.5 flex items-center gap-2 mono text-xs">
        <FanChip
          count={count}
          radiusMiles={radiusMiles}
          useRadius={useRadius}
          stateCode={show.stateCode}
        />
        {show.sameCityCount > 0 && (
          <span className="text-red">★ {show.sameCityCount} IN CITY</span>
        )}
        {/* NEARBY = within the radius but NOT same-city. Surfaces the
            customers a venue could still reach via a regional fan base
            (drive-in, suburb spillover) even when the venue's literal city
            is fan-light. Renders only when there's a meaningful delta. */}
        {useRadius && show.withinRadiusCount - show.sameCityCount > 0 && (
          <span className="text-blue">
            ◌ {(show.withinRadiusCount - show.sameCityCount).toLocaleString()}{" "}
            NEARBY
          </span>
        )}
        {offFanbase && <span className="text-ink/40">⚑ OFF FANBASE</span>}
        {hasWho && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setWhoOpen((v) => !v);
            }}
            className="text-ink/45 hover:text-ink"
          >
            {whoOpen ? "▾ WHO" : "▸ WHO"}
          </button>
        )}
      </div>

      {/* who — actual customers within radius, grouped by city */}
      {whoOpen && hasWho && (
        <div className="ml-[7.75rem] mt-1.5 space-y-1.5">
          {inCity && <NearbyCity group={inCity} accent />}
          {secondary.length > 0 && (
            <div className="space-y-1">
              <div className="mono text-ink/40 text-[0.65rem]">
                NEARBY ≤{radiusMiles}MI
              </div>
              {secondary.map((g, i) => (
                <NearbyCity key={i} group={g} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NearbyCity({
  group,
  accent,
}: {
  group: {
    city: string;
    stateCode: string;
    count: number;
    names: string[];
  };
  accent?: boolean;
}) {
  const extra = group.count - group.names.length;
  return (
    <div className="text-xs leading-snug">
      <span className={`mono ${accent ? "text-red" : "text-ink/55"}`}>
        {accent ? "★ " : ""}
        {group.city.toUpperCase()}, {group.stateCode} ({group.count})
      </span>{" "}
      <span className="text-ink/70">
        {group.names.join(" · ")}
        {extra > 0 && <span className="text-ink/40"> +{extra} more</span>}
        {group.names.length === 0 && (
          <span className="text-ink/40">(names not in file)</span>
        )}
      </span>
    </div>
  );
}

function FanChip({
  count,
  radiusMiles,
  useRadius,
  stateCode,
}: {
  count: number;
  radiusMiles: number;
  useRadius: boolean;
  stateCode: string | null;
}) {
  const blocks = count === 0 ? "░░" : count < 15 ? "▓░" : "▓▓";
  return (
    <span className="text-ink/55">
      <span className={count > 0 ? "text-ink" : "text-ink/25"}>{blocks}</span>{" "}
      {count} {useRadius ? `≤${radiusMiles}MI` : `IN ${stateCode ?? "?"}`}
    </span>
  );
}

// ── leg connector ────────────────────────────────────────────────────────────
function LegConnector({
  leg,
  legIndex,
  open,
  onToggle,
  onAccept,
  acceptedKeys,
}: {
  leg: Leg;
  legIndex: number;
  open: boolean;
  onToggle: () => void;
  onAccept: (s: RoutingSuggestion) => void;
  acceptedKeys: Set<string>;
}) {
  const d = legDisplay(leg);
  const hasFills = leg.suggestions.length > 0;
  return (
    <div className="relative pl-10">
      {/* rail segment */}
      <div
        className={`absolute left-[1.05rem] -translate-x-1/2 inset-y-0 ${d.railWidth} ${d.railColor}`}
      />
      <button
        onClick={onToggle}
        className={`w-full text-left py-1.5 flex items-center gap-2 mono text-xs ${d.color} ${
          hasFills ? "hover:opacity-70" : "cursor-default"
        }`}
        disabled={!hasFills}
      >
        <span className="tracking-tight">
          {d.dark ? "⚑ " : ""}
          {leg.segmentMiles.toLocaleString()} MI
        </span>
        <span className="text-ink/30">{"▌".repeat(d.slack)}</span>
        <span>
          · {leg.gapDays} DAY{leg.gapDays === 1 ? "" : "S"} · {d.verdict}
        </span>
        {hasFills && (
          <span className="ml-auto text-ink/45">
            {open ? "▾" : "▸"} FILL ({leg.suggestions.length})
          </span>
        )}
      </button>

      {open && hasFills && (
        <div className="ml-2 mb-2 border-l-2 border-blue/40 pl-3 space-y-1">
          <div className="mono text-ink/45 text-xs">
            FILL THIS GAP · ON-ROUTE FAN CITIES
          </div>
          {leg.suggestions.map((s, i) => {
            const accepted = acceptedKeys.has(`${s.suggestedDate}|${s.city}`);
            return (
              <div key={i} className="flex items-baseline gap-2 text-sm">
                <button
                  onClick={() => onAccept(s)}
                  disabled={accepted}
                  className={`mono shrink-0 ${
                    accepted ? "text-ink/30" : "text-blue hover:text-red"
                  }`}
                  title={accepted ? "Added" : "Add as additive tour date"}
                >
                  {accepted ? "✓" : "⊕"}
                </button>
                <span className="font-medium flex-1">
                  {s.city}, {s.stateCode}
                </span>
                <span className="display text-base">{s.customers}</span>
                <span className="mono text-ink/40 text-xs w-28 text-right">
                  +{s.detourMiles}MI · ~{s.suggestedDate.slice(5)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── untapped markets + verdict + fan-first plan ──────────────────────────────
function UntappedShelf({
  result,
  planOpen,
  setPlanOpen,
}: {
  result: CustomerCrossover;
  planOpen: boolean;
  setPlanOpen: (b: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  // Greedy nearest-neighbor chain through the densest untapped markets — a
  // lightweight "if you toured your fans" proposal. Great-circle only.
  const fanFirst = useMemo(() => {
    const pts = result.untappedMarkets.slice(0, 8).map((m) => ({ ...m }));
    if (pts.length < 2) return { order: pts, miles: 0 };
    const used = new Set<number>();
    const order: typeof pts = [];
    let cur = 0; // start at densest
    used.add(0);
    order.push(pts[0]);
    let miles = 0;
    while (order.length < pts.length) {
      let best = -1;
      let bestD = Infinity;
      for (let j = 0; j < pts.length; j++) {
        if (used.has(j)) continue;
        const dx = pts[cur].lat - pts[j].lat;
        const dy = pts[cur].lng - pts[j].lng;
        const dd = dx * dx + dy * dy;
        if (dd < bestD) {
          bestD = dd;
          best = j;
        }
      }
      if (best < 0) break;
      // approximate miles via haversine-ish (degrees → miles rough)
      const a = pts[cur];
      const b = pts[best];
      const R = 3958.8;
      const toRad = Math.PI / 180;
      const dLat = (b.lat - a.lat) * toRad;
      const dLng = (b.lng - a.lng) * toRad;
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(a.lat * toRad) *
          Math.cos(b.lat * toRad) *
          Math.sin(dLng / 2) ** 2;
      miles += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
      used.add(best);
      order.push(pts[best]);
      cur = best;
    }
    return { order, miles: Math.round(miles) };
  }, [result.untappedMarkets]);

  const topMissed = result.untappedMarkets.slice(0, 3).map((m) => m.stateCode);
  const uniqueMissedStates = [...new Set(topMissed)].join("/");

  return (
    <div className="mt-5 border-t border-ink/15 pt-3">
      <button
        onClick={() => setOpen(!open)}
        className="mono text-ink/55 hover:text-ink flex items-center gap-2"
      >
        {open ? "▾" : "▸"} TOUR NEXT — TOP UNTAPPED MARKETS
        <span className="text-ink/35">
          (the fanbase this route never touches)
        </span>
      </button>

      {open && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-1 mt-3">
            {result.untappedMarkets.map((m, i) => (
              <div key={i} className="flex items-baseline gap-2">
                <span className="mono text-ink/40 w-5">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="font-medium flex-1 truncate">
                  {m.city}, {m.stateCode}
                </span>
                <span className="display text-base">{m.customers}</span>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-start gap-3">
            <p className="serif-italic text-ink/75 flex-1">
              ❯ This run reaches {Math.round(result.reachPct * 100)}% of the
              fanbase
              {uniqueMissedStates
                ? ` — the densest untapped markets are in ${uniqueMissedStates}.`
                : "."}{" "}
              {result.reachPct < 0.25 &&
                "The next routing should chase the fans, not the calendar."}
            </p>
            <button
              onClick={() => setPlanOpen(!planOpen)}
              className="mono shrink-0 px-3 h-8 border border-ink/30 hover:bg-ink hover:text-cream transition-colors"
            >
              {planOpen ? "HIDE PLAN" : "PLAN A FAN-FIRST RUN →"}
            </button>
          </div>

          {planOpen && fanFirst.order.length > 1 && (
            <div className="mt-3 border border-blue/30 p-3">
              <div className="mono text-blue text-xs mb-2">
                IF YOU TOURED YOUR FANS · greedy nearest-neighbor ·{" "}
                {fanFirst.miles.toLocaleString()} MI
              </div>
              <div className="font-medium text-sm leading-relaxed">
                {fanFirst.order.map((m, i) => (
                  <span key={i}>
                    {i > 0 && <span className="text-blue/50"> → </span>}
                    {m.city}, {m.stateCode}
                    <span className="mono text-ink/40 text-xs">
                      {" "}
                      ({m.customers})
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
