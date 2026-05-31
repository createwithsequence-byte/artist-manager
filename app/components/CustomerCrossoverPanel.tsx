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

type Props = {
  events: ArtistEvent[];
  artistName: string;
  /** Candidate dataset keys, primary first (stable `nm:<name>`, then `sp:…`
   *  healing fallbacks). Persist + world-link use the primary; hydrate tries
   *  each in order and self-heals data found under an old key. */
  customerKeys: string[];
};

type Loaded = { fileName: string; customers: Customer[]; geocode: GeocodeMap };
type Stage =
  | { kind: "idle" }
  | { kind: "parsing"; fileName: string }
  | { kind: "ready"; loaded: Loaded }
  | { kind: "error"; message: string };

export function CustomerCrossoverPanel({
  events,
  artistName,
  customerKeys,
}: Props) {
  // Primary key (stable, name-based) drives persist + world link. The full
  // list drives hydration's fallback+heal. keysDep is a stable effect dep.
  const primaryKey = customerKeys[0] ?? `nm:${artistName.trim().toLowerCase()}`;
  const keysDep = customerKeys.join("|");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const [radiusMiles, setRadiusMiles] = useState(60);
  // Tracks whether the current ready state was hydrated from the SF World
  // master dataset (vs uploaded locally this session). Drives the "USING
  // MASTER" badge in the panel header so the source of truth is visible.
  const [usingMaster, setUsingMaster] = useState(false);
  // When this artist has no saved dataset yet but the legacy global "master"
  // exists, offer a one-click adopt (copy master → this artist) so the 4k
  // already in Turso isn't lost to a re-upload. null = no offer.
  const [masterOffer, setMasterOffer] = useState<{ count: number } | null>(
    null,
  );
  const [adopting, setAdopting] = useState(false);
  const inputId = `crossover-csv-${artistName.replace(/\W+/g, "-")}`;
  const fileInput = useRef<HTMLInputElement>(null);

  // On mount: hydrate THIS ARTIST's saved customer dataset. Tries each
  // candidate key in order (stable name key first, then Spotify fallbacks) so
  // a dataset saved under any past identity form is still found. If a fallback
  // key wins, self-heal: re-save it under the primary key so next session
  // finds it directly. Falls back to the adopt-master offer if nothing exists.
  useEffect(() => {
    let cancelled = false;
    setMasterOffer(null);

    (async () => {
      try {
        let hit: { dataset: { name: string }; raw: Customer[] } | null = null;
        let hitKey = "";
        for (const key of customerKeys) {
          const d = await fetch(
            `/api/customers?id=${encodeURIComponent(key)}&raw=1`,
          ).then((r) => r.json());
          if (cancelled) return;
          if (d?.dataset && Array.isArray(d?.raw) && d.raw.length > 0) {
            hit = d;
            hitKey = key;
            break;
          }
        }

        if (hit) {
          const { US_CITY_LATLNG } = await import("@/lib/usCityToLatLng");
          if (cancelled) return;
          setStage({
            kind: "ready",
            loaded: {
              fileName: `★ ${hit.dataset.name}`,
              customers: hit.raw,
              geocode: US_CITY_LATLNG as unknown as GeocodeMap,
            },
          });
          setUsingMaster(true);
          // Self-heal: found under an OLD key → copy onto the stable primary
          // so the artist's data stops drifting between identity forms.
          if (hitKey !== primaryKey) {
            fetch("/api/customers", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                copyFrom: hitKey,
                id: primaryKey,
                name: artistName,
              }),
            }).catch((err) =>
              console.warn(
                "[CROSSOVER] self-heal failed:",
                err instanceof Error ? err.message : String(err),
              ),
            );
          }
          return;
        }

        // Nothing under any key — offer to adopt the legacy global master.
        if (primaryKey !== "master") {
          const list = await fetch("/api/customers").then((r) => r.json());
          if (cancelled) return;
          const master = Array.isArray(list?.datasets)
            ? list.datasets.find((x: { id: string }) => x.id === "master")
            : null;
          if (master && master.customerCount > 0) {
            setMasterOffer({ count: master.customerCount });
          }
        }
      } catch (err) {
        if (!cancelled)
          console.warn(
            "[CROSSOVER]",
            err instanceof Error ? err.message : String(err),
          );
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysDep]);

  // Adopt the legacy master as THIS artist's dataset — server-side copy
  // (master → customerKey), then hydrate the now-populated dataset. No
  // re-upload, no multi-MB blob through the browser.
  const adoptMaster = () => {
    setAdopting(true);
    fetch("/api/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        copyFrom: "master",
        id: primaryKey,
        name: artistName,
      }),
    })
      .then((r) => r.json())
      .then(async (d) => {
        if (!d?.ok) throw new Error(d?.error || "adopt failed");
        const hd = await fetch(
          `/api/customers?id=${encodeURIComponent(primaryKey)}&raw=1`,
        ).then((r) => r.json());
        if (hd?.dataset && Array.isArray(hd?.raw) && hd.raw.length > 0) {
          const { US_CITY_LATLNG } = await import("@/lib/usCityToLatLng");
          setStage({
            kind: "ready",
            loaded: {
              fileName: `★ ${hd.dataset.name}`,
              customers: hd.raw as Customer[],
              geocode: US_CITY_LATLNG as unknown as GeocodeMap,
            },
          });
          setUsingMaster(true);
          setMasterOffer(null);
        }
      })
      .catch((err) =>
        console.warn(
          "[CROSSOVER] adopt failed:",
          err instanceof Error ? err.message : String(err),
        ),
      )
      .finally(() => setAdopting(false));
  };

  const handleFile = (file: File) => {
    setStage({ kind: "parsing", fileName: file.name });
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (result) => {
        try {
          const customers = parseCustomers(result.data);
          const [{ US_CITY_LATLNG }, { WORLD_CITY_ADMIN, WORLD_CITY_COUNTRY }] =
            await Promise.all([
              import("@/lib/usCityToLatLng"),
              import("@/lib/worldCityToLatLng"),
            ]);
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

          // Persist keyed to THIS artist so their Songfinch World + future
          // routing sessions hydrate from the same source. Replaces this
          // artist's prior dataset (upload stays until re-uploaded). Dataset
          // name = artist name so the world is branded "{Artist}'s World".
          // World geocode passed so non-US fans plot. Fire-and-forget.
          const { aggregate } = aggregateByCity(customers, geocode, {
            admin: WORLD_CITY_ADMIN,
            country: WORLD_CITY_COUNTRY,
          });
          fetch("/api/customers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: primaryKey,
              name: artistName,
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
                "[CROSSOVER] customer persist failed:",
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
            <div className="mono mb-1">
              UPLOAD {artistName.toUpperCase()}&apos;S CUSTOMERS → ROUTING SHEET
            </div>
            <div className="serif-italic text-ink/65 text-sm">
              Expected columns: <span className="mono">city, state</span> (plus
              anything else). Saved as {artistName}&apos;s own dataset — powers
              this routing sheet and {artistName}&apos;s ◯ Songfinch World
              globe. Stays until you upload a new one.
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
          {/* Adopt-master offer — only when this artist has no data yet but a
              legacy master exists. One click keys it to them, no re-upload. */}
          {masterOffer && (
            <button
              onClick={adoptMaster}
              disabled={adopting}
              className="mt-3 w-full text-left flex items-center gap-3 border border-blue/40 bg-blue/[0.04] px-4 py-3 hover:bg-blue/[0.08] transition-colors disabled:opacity-50"
            >
              <span className="mono text-blue text-sm shrink-0">◎ ADOPT</span>
              <span className="serif-italic text-ink/70 text-sm flex-1">
                {adopting
                  ? `Adopting ${masterOffer.count.toLocaleString()} customers as ${artistName}'s…`
                  : `Existing master has ${masterOffer.count.toLocaleString()} customers — claim them as ${artistName}'s own (no re-upload).`}
              </span>
              {!adopting && <span className="mono text-blue shrink-0">→</span>}
            </button>
          )}
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
          customerKey={primaryKey}
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
  customerKey,
  radiusMiles,
  setRadiusMiles,
  usingMaster,
  onReset,
}: {
  loaded: Loaded;
  events: ArtistEvent[];
  artistName: string;
  customerKey: string;
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

  // Reach-bar scale — the densest booked stop anchors the bars so each row's
  // fill reads relative to the best stop on this run.
  const maxReach = Math.max(1, ...shows.map((s) => s.withinRadiusCount));
  // Insight nudge — how many fan-dense cities sit on-route, fillable in one
  // BUILD REVISED click. Honest count, no fabricated projected %.
  const onRouteFillCities = result.routingSuggestions.length;

  return (
    <div className="rsheet">
      {/* Header — kicker + artist name, saved badge, world link, replace */}
      <div className="rs-head">
        <div>
          <div className="rs-kicker">Routing Sheet</div>
          <div className="rs-name">{artistName}</div>
        </div>
        <div className="rs-head-actions">
          {usingMaster && (
            <span
              className="rs-master"
              title={`Saved as ${artistName}'s own customer dataset. Replace to upload a new one.`}
            >
              <span className="rs-dot" /> Saved
            </span>
          )}
          {/* Jump to this artist's own Songfinch World globe — same dataset,
              spatial lens. Opens the per-artist /customers view. */}
          <a
            className="rs-worldlink"
            href={`/customers?artist=${encodeURIComponent(customerKey)}&name=${encodeURIComponent(artistName)}`}
            title={`See ${artistName}'s customers on the globe`}
          >
            ◯ {artistName}&apos;s Songfinch World →
          </a>
          <button
            className="rs-replace"
            onClick={onReset}
            title="Upload a different CSV — replaces this artist's dataset"
          >
            Replace
          </button>
        </div>
      </div>

      {/* Stat ribbon — the bad number (low coverage) flags itself in red */}
      <div className="rs-ribbon">
        <div className="rs-stat">
          <div className="k">Dates</div>
          <div className="v rs-tnum">{shows.length}</div>
        </div>
        <div className="rs-stat">
          <div className="k">Window</div>
          <div className="v">{dateRange}</div>
        </div>
        <div className="rs-stat">
          <div className="k">Route</div>
          <div className="v rs-tnum">
            {result.totalRouteMiles.toLocaleString()} <small>mi</small>
          </div>
        </div>
        <div className="rs-stat">
          <div className="k">Longest gap</div>
          <div className="v rs-tnum">
            {result.longestGapDays} <small>days</small>
          </div>
        </div>
        <div className={`rs-stat${result.reachPct < 0.15 ? " flag" : ""}`}>
          <div className="k">Fan coverage</div>
          <div className="v rs-tnum">
            {Math.round(result.reachPct * 100)}%
            {result.reachPct < 0.15 && (
              <span className="rs-cov">
                <i
                  style={{
                    width: `${Math.max(3, Math.round(result.reachPct * 100))}%`,
                  }}
                />
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Insight — turn the worst stat into an action (current mode, pre-build) */}
      {mode === "current" && !revisedActive && onRouteFillCities > 0 && (
        <div className="rs-insight">
          <span className="rs-serif">
            Only <b>{Math.round(result.reachPct * 100)}%</b> of {artistName}
            &apos;s fanbase is within reach.{" "}
            <b>
              {onRouteFillCities} on-route{" "}
              {onRouteFillCities === 1 ? "city" : "cities"}
            </b>{" "}
            could lift it.
          </span>
          <button className="go" onClick={buildRevised}>
            Build revised tour →
          </button>
        </div>
      )}

      {/* Mode toggle + radius lens — one sticky control bar. The lens governs
          every fan number on screen, so it lives here (visible) not buried. */}
      <div className="rs-modebar" role="radiogroup" aria-label="Routing mode">
        <div className="rs-seg">
          <button
            role="radio"
            aria-checked={mode === "current"}
            onClick={() => setMode("current")}
            title="Fill gaps between his booked dates"
          >
            Current tour
          </button>
          <button
            role="radio"
            aria-checked={mode === "tourhere"}
            onClick={() => setMode("tourhere")}
            title="Propose a from-scratch tour through his fanbase"
          >
            Tour here
          </button>
        </div>
        <span className="rs-hint">
          {mode === "current"
            ? "Fill the gaps in his booked run."
            : "Build a future tour from his fanbase, from scratch."}
        </span>
        <label className="rs-lens" aria-label="Reach radius">
          <span className="rs-label">Reach radius</span>
          <input
            type="range"
            min={25}
            max={250}
            step={5}
            value={radiusMiles}
            onChange={(e) => setRadiusMiles(parseInt(e.target.value, 10))}
          />
          <span className="v rs-tnum">{radiusMiles} mi</span>
        </label>
      </div>

      {/* TOUR HERE controls — clean card. Propose disabled with no untapped. */}
      {mode === "tourhere" && (
        <div className="rs-thcard">
          <label className="rs-thfield">
            <span className="rs-label">How many shows</span>
            <input
              className="rs-thin"
              type="number"
              min={2}
              max={40}
              value={thCount}
              onChange={(e) =>
                setThCount(
                  Math.max(2, Math.min(40, parseInt(e.target.value, 10) || 8)),
                )
              }
            />
          </label>
          <label className="rs-thfield">
            <span className="rs-label">Starting</span>
            <input
              className="rs-thin"
              type="date"
              value={thStart}
              onChange={(e) => setThStart(e.target.value)}
            />
          </label>
          <label className="rs-thfield">
            <span className="rs-label">Spacing (days)</span>
            <input
              className="rs-thin"
              type="number"
              min={1}
              max={30}
              value={thSpacing}
              onChange={(e) =>
                setThSpacing(
                  Math.max(1, Math.min(30, parseInt(e.target.value, 10) || 4)),
                )
              }
            />
          </label>
          <label className="rs-thfield">
            <span className="rs-label">Routing style</span>
            <span className="rs-thseg">
              {(
                [
                  ["geographic", "Geo chain"],
                  ["density", "Density"],
                  ["corridor", "Corridor"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setThStyle(k)}
                  className={thStyle === k ? "sel" : ""}
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
            </span>
          </label>
          <button
            className="rs-btn blue"
            style={{ marginLeft: "auto" }}
            onClick={proposeTourHere}
            disabled={baseline.untappedMarkets.length === 0}
          >
            {thProposal.length > 0 ? "Re-propose" : "Propose tour"} →
          </button>
          {thProposal.length > 0 && (
            <>
              <button
                className="rs-btn blue"
                onClick={applyTourHere}
                title="Drop these stops into the spine as additive tour dates"
              >
                ⊕ Apply all {thProposal.length}
              </button>
              <button
                className="rs-btn"
                onClick={exportMailingList}
                title="Download a CSV of every fan within radius of these stops"
              >
                ⇣ Export mailing list
              </button>
              <button className="rs-btn ghost" onClick={resetTourHere}>
                Clear
              </button>
            </>
          )}
          {baseline.untappedMarkets.length === 0 && (
            <span className="rs-hint">
              No untapped markets — every dense city is already within range of
              a booked stop. Try a wider radius.
            </span>
          )}
        </div>
      )}

      {/* TOUR HERE preview — proposed stops with per-stop fan counts. Review
          before APPLY commits them to the spine as additive dates. */}
      {mode === "tourhere" && thProposal.length > 0 && thPreview && (
        <div style={{ marginBottom: "18px" }}>
          <div className="rs-thhead">
            <span className="rs-label" style={{ letterSpacing: "0.1em" }}>
              Proposed · {thProposal.length} stops
            </span>
            <span className="rs-thstat">
              {thPreview.reachedCustomers.toLocaleString()} fans reached{" "}
              <span style={{ color: "var(--rs-ink-3)" }}>
                · {Math.round(thPreview.reachPct * 100)}% of file @ {dRadius}mi
              </span>
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
            {[...thPreview.perEvent]
              .sort((a, b) =>
                a.event.date < b.event.date
                  ? -1
                  : a.event.date > b.event.date
                    ? 1
                    : 0,
              )
              .map((pe, i) => (
                <div
                  key={`${pe.event.date}-${pe.event.city}`}
                  className="rs-throw2"
                >
                  <span className="rs-thnode" />
                  <span className="rs-thidx rs-tnum">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="rs-thdate">{fmtDay(pe.event.date)}</span>
                  <span className="rs-thcity">
                    {pe.event.city}
                    <span className="st">
                      , {pe.event.state || pe.stateCode || "??"}
                    </span>
                  </span>
                  <span className="rs-thfans rs-tnum">
                    {pe.withinRadiusCount.toLocaleString()}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Revised-tour status — only once a revision exists. The BUILD CTA
          lives in the insight line above when nothing's been built yet. */}
      {mode === "current" && revisedActive && (
        <div
          className="rs-insight"
          style={{ borderLeftColor: "var(--rs-red)" }}
        >
          <span className="rs-serif">
            <b style={{ color: "var(--rs-blue)" }}>Revised ✓</b> +
            {provisional.length} stop{provisional.length === 1 ? "" : "s"} ·
            reach <b>{Math.round(baseline.reachPct * 100)}%</b> →{" "}
            <b style={{ color: "var(--rs-red)" }}>
              {Math.round(result.reachPct * 100)}%
            </b>
            {reachDeltaPts > 0 && (
              <span style={{ color: "var(--rs-ink-3)" }}>
                {" "}
                (+{reachDeltaPts}pts)
              </span>
            )}
            {addedMiles > 0 && (
              <span style={{ color: "var(--rs-ink-3)" }}>
                {" "}
                · +{addedMiles.toLocaleString()} mi
              </span>
            )}
          </span>
          <button
            className="rs-btn ghost"
            onClick={buildRevised}
            title="Recompute at the current radius"
          >
            Rebuild @ {radiusMiles}mi
          </button>
          <button className="rs-btn ghost" onClick={resetRevised}>
            Reset
          </button>
        </div>
      )}

      <div className="rs-grid">
        {/* THE SPINE */}
        <div className="rs-tl">
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
                  maxReach={maxReach}
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
        <div className="rs-mappane">
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
          <div className="rs-maplegend">
            <span className="lg">
              <span style={{ color: "var(--rs-red)" }}>●</span> Booked
            </span>
            <span className="lg">
              <span style={{ color: "var(--rs-blue)" }}>◇</span> Fill candidate
            </span>
            <span className="lg">Fan density · ◉ toggle on map</span>
            {selectedLeg !== null && result.legs[selectedLeg] && (
              <span className="lg" style={{ color: "var(--rs-ink-2)" }}>
                Selected · {result.legs[selectedLeg].fromCity} →{" "}
                {result.legs[selectedLeg].toCity}
              </span>
            )}
          </div>
        </div>
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

      <div className="rs-foot">
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
  maxReach,
  provisional,
  selected,
  onRemove,
  onSelect,
}: {
  show: CustomerCrossover["perEvent"][number];
  index: number;
  radiusMiles: number;
  maxReach: number;
  provisional: boolean;
  selected: boolean;
  onRemove?: () => void;
  onSelect: () => void;
}) {
  const [whoOpen, setWhoOpen] = useState(false);
  const useRadius = show.lat !== undefined && show.lng !== undefined;
  const count = useRadius ? show.withinRadiusCount : show.sameStateCount;
  const nearby = show.nearby ?? [];
  const inCity = nearby.find((n) => n.isSameCity);
  const secondary = nearby.filter((n) => !n.isSameCity);
  const hasWho = nearby.length > 0;
  const nearbyCount = Math.max(0, show.withinRadiusCount - show.sameCityCount);

  // Date split into weekday + month-day, parsed at noon to dodge the UTC
  // off-by-one (same trick fmtDay uses).
  const dt = new Date(`${show.event.date}T12:00:00`);
  const valid = !isNaN(dt.getTime());
  const dow = valid ? dt.toLocaleDateString("en-US", { weekday: "short" }) : "";
  const dm = valid
    ? dt.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : show.event.date;

  // Reach bar — width relative to the densest stop, color by quality tier.
  const ratio = maxReach > 0 ? count / maxReach : 0;
  const tier = ratio >= 0.6 ? "hi" : count > 0 ? "mid" : "lo";
  const barW = count > 0 ? Math.max(6, Math.round(ratio * 100)) : 0;
  const dim = count === 0 || ratio < 0.18;

  return (
    <>
      <div className={`rs-stop${selected ? " sel" : ""}`} onClick={onSelect}>
        <span className={`rs-node${provisional ? " add" : ""}`} />
        <div className="rs-date">
          <div className="dow">{dow}</div>
          <div className="dm">{dm}</div>
        </div>
        <div className="rs-body">
          <div className="rs-venue">
            {show.event.venue === "PROVISIONAL" ? (
              <span className="add-tag">
                Additive · #{String(index + 1).padStart(2, "0")}
              </span>
            ) : (
              show.event.venue || "Venue TBD"
            )}
          </div>
          <div className="rs-city">
            {show.event.city || "?"}
            {show.stateCode ? `, ${show.stateCode}` : ""}
            {hasWho && (
              <button
                className="rs-who"
                onClick={(e) => {
                  e.stopPropagation();
                  setWhoOpen((v) => !v);
                }}
              >
                {whoOpen ? "▾ Fans" : "▸ Fans"}
              </button>
            )}
            {onRemove && (
              <button
                className="rs-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove();
                }}
                title="Remove this additive date"
              >
                ✕
              </button>
            )}
          </div>
        </div>
        <div className="rs-reach">
          <div className={`n${dim ? " dim" : ""}`}>
            {count.toLocaleString()}
          </div>
          <div className="u">
            {count === 0
              ? "off fanbase"
              : useRadius
                ? `fans · ${radiusMiles}mi`
                : `fans · ${show.stateCode ?? ""}`}
          </div>
          <div className="rs-bar">
            <i className={tier} style={{ width: `${barW}%` }} />
          </div>
        </div>
      </div>

      {/* who — in-city/nearby split + actual names, revealed on demand */}
      {whoOpen && hasWho && (
        <div className="rs-whobox">
          <div className="rs-fhead">
            ★ {show.sameCityCount} in city · ◌ {nearbyCount} nearby ≤
            {radiusMiles}mi
          </div>
          {inCity && <WhoRow group={inCity} accent />}
          {secondary.map((g, i) => (
            <WhoRow key={i} group={g} />
          ))}
        </div>
      )}
    </>
  );
}

function WhoRow({
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
    <div className="rs-whorow">
      <span className={`c ${accent ? "accent" : "sec"}`}>
        {accent ? "★ " : ""}
        {group.city}, {group.stateCode} ({group.count})
      </span>{" "}
      <span className="nm">
        {group.names.join(" · ")}
        {extra > 0 && <span className="rs-whomore"> +{extra} more</span>}
        {group.names.length === 0 && (
          <span className="rs-whomore">(names not in file)</span>
        )}
      </span>
    </div>
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
  // Tick grows with idle days so a long dead gap reads as a taller red mark.
  const tickH = Math.min(46, 10 + leg.gapDays);
  const modeWord = d.fly
    ? "fly"
    : d.verdict === "DRIVE HARD"
      ? "long haul"
      : "drive";
  return (
    <div className={`rs-leg${d.dark ? " warn" : ""}`}>
      <div className="tick">
        <span style={{ height: `${tickH}px` }} />
      </div>
      <div className="lwrap">
        <button
          className="mi"
          onClick={onToggle}
          disabled={!hasFills}
          style={hasFills ? undefined : { cursor: "default" }}
        >
          ↓ {leg.segmentMiles.toLocaleString()} mi
        </button>
        <span className="dur">
          {leg.gapDays} day{leg.gapDays === 1 ? "" : "s"}
          {d.dark ? " idle" : ""}
        </span>
        <span className="mode-w">{modeWord}</span>
        {hasFills && (
          <button className="fill" onClick={onToggle}>
            {leg.suggestions.length} fan{" "}
            {leg.suggestions.length === 1 ? "city" : "cities"} on route{" "}
            {open ? "▾" : "▸"}
          </button>
        )}
      </div>

      {open && hasFills && (
        <div className="rs-fills">
          <div className="rs-fhead">
            Fill this gap · densest cities on route
          </div>
          {leg.suggestions.map((s, i) => {
            const accepted = acceptedKeys.has(`${s.suggestedDate}|${s.city}`);
            return (
              <div key={i} className="rs-fillrow">
                <button
                  className="add"
                  onClick={() => onAccept(s)}
                  disabled={accepted}
                  title={accepted ? "Added" : "Add as additive tour date"}
                >
                  {accepted ? "✓" : "⊕"}
                </button>
                <span className="fcity">
                  {s.city}, {s.stateCode}
                </span>
                <span className="fmeta">
                  +{s.detourMiles}mi · ~{s.suggestedDate.slice(5)}
                </span>
                <span className="ffans">{s.customers}</span>
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
