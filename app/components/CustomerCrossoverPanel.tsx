"use client";

import { useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Papa from "papaparse";
import {
  crossover,
  parseCustomers,
  type Customer,
  type CustomerCrossover,
  type GeocodeMap,
} from "@/lib/customerCrossover";
import type { Event as ArtistEvent } from "@/lib/types";

// Leaflet touches `window`, so the map can't server-render. Lazy + ssr:false.
const TourMap = dynamic(() => import("./TourMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[360px] md:h-[440px] border border-ink/15 flex items-center justify-center mono text-ink/40">
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
  const inputId = `crossover-csv-${artistName.replace(/\W+/g, "-")}`;
  const fileInput = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    setStage({ kind: "parsing", fileName: file.name });
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (result) => {
        try {
          const customers = parseCustomers(result.data);
          // Defer the 1MB lat/lng bundle until a CSV is actually dropped.
          const { US_CITY_LATLNG } = await import("@/lib/usCityToLatLng");
          setStage({
            kind: "ready",
            loaded: {
              fileName: file.name,
              customers,
              geocode: US_CITY_LATLNG as unknown as GeocodeMap,
            },
          });
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
        No upcoming events for {artistName}. Customer crossover needs a tour
        date to intersect with — re-scout when {artistName} announces something.
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
            <div className="mono mb-1">UPLOAD CUSTOMER CSV</div>
            <div className="serif-italic text-ink/65 text-sm">
              Expected columns: <span className="mono">city, state</span> (plus
              anything else). Stays in browser — never uploaded.
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
        <CrossoverResult
          loaded={stage.loaded}
          events={events}
          artistName={artistName}
          radiusMiles={radiusMiles}
          setRadiusMiles={setRadiusMiles}
          onReset={() => setStage({ kind: "idle" })}
        />
      )}
    </div>
  );
}

function CrossoverResult({
  loaded,
  events,
  artistName,
  radiusMiles,
  setRadiusMiles,
  onReset,
}: {
  loaded: Loaded;
  events: ArtistEvent[];
  artistName: string;
  radiusMiles: number;
  setRadiusMiles: (n: number) => void;
  onReset: () => void;
}) {
  // The pure engine re-runs instantly as the slider moves — no re-parse.
  const result: CustomerCrossover = useMemo(
    () =>
      crossover(loaded.customers, events, {
        radiusMiles,
        geocode: loaded.geocode,
      }),
    [loaded, events, radiusMiles],
  );

  // Existing stops, most-reached first. Prefer radius count; fall back to state.
  const sortedEvents = [...result.perEvent].sort(
    (a, b) =>
      (b.withinRadiusCount || b.sameStateCount) -
      (a.withinRadiusCount || a.sameStateCount),
  );

  // Group routing suggestions by the gap they fill (from→to + dates).
  const gapGroups = new Map<string, typeof result.routingSuggestions>();
  for (const s of result.routingSuggestions) {
    const key = `${s.fromCity}|${s.fromDate}|${s.toCity}|${s.toDate}`;
    const arr = gapGroups.get(key) ?? [];
    arr.push(s);
    gapGroups.set(key, arr);
  }

  const topGap = result.routingSuggestions[0];
  const reachPctLabel = Math.round(result.reachPct * 100);

  return (
    <div>
      {/* Header */}
      <div className="mono text-ink/55 mb-3 flex flex-wrap gap-x-4 gap-y-1 items-baseline">
        <span>
          ✓ {result.totalCustomers.toLocaleString()} CUSTOMERS ·{" "}
          {result.uniqueStates} STATES
          {result.droppedCount > 0 && (
            <span
              className="text-ink/40 ml-2"
              title={`${result.droppedCount} rows excluded — state value empty, "USA"/non-US, or unrecognized. Preserved in the file, just skipped for matching.`}
            >
              ({result.droppedCount.toLocaleString()} skipped)
            </span>
          )}
        </span>
        <span className="text-ink/40">{loaded.fileName}</span>
        <button
          onClick={onReset}
          className="mono text-ink/50 underline ml-auto hover:text-red"
        >
          REPLACE
        </button>
      </div>

      {/* Reach headline */}
      <div className="border-y border-ink/15 py-3 mb-4">
        <div className="display text-2xl md:text-3xl leading-tight">
          TOUR REACHES{" "}
          <span className="text-red">
            {result.reachedCustomers.toLocaleString()}
          </span>{" "}
          / {result.totalCustomers.toLocaleString()} CUSTOMERS ({reachPctLabel}
          %)
          <span className="text-ink/40 text-xl"> WITHIN {radiusMiles}MI</span>
        </div>
        {topGap && (
          <div className="serif-italic text-ink/70 mt-1">
            Biggest on-route gap:{" "}
            <span className="not-italic font-medium">
              {topGap.city}, {topGap.stateCode}
            </span>{" "}
            — {topGap.customers} customers in a {topGap.gapDays}-day window (+
            {topGap.detourMiles}mi detour).
          </div>
        )}
      </div>

      {/* Mileage slider */}
      <div className="flex items-center gap-4 mb-4">
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
          drag to widen reach + routing corridor
        </span>
      </div>

      {/* Map */}
      <div className="mb-5">
        <TourMap
          stops={result.mapData.stops}
          customerPoints={result.mapData.customerPoints}
          suggestions={result.mapData.suggestions}
          radiusMiles={radiusMiles}
        />
        <div className="mono text-ink/35 text-xs mt-1 flex flex-wrap gap-x-4">
          <span>
            <span className="text-red">●</span> TOUR STOP
          </span>
          <span>
            <span className="text-blue">●</span> SUGGESTED STOP
          </span>
          <span>🔥 CUSTOMER DENSITY</span>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-x-10 gap-y-6">
        {/* 01 — Existing stops */}
        <div>
          <div className="mono mb-3 pb-2 border-b border-ink/15">
            01 — TOUR STOPS · CUSTOMER REACH
          </div>
          <div className="space-y-3">
            {sortedEvents.map((e, i) => {
              const useRadius = e.lat !== undefined && e.lng !== undefined;
              const headline = useRadius
                ? e.withinRadiusCount
                : e.sameStateCount;
              return (
                <div key={i}>
                  <div className="flex items-baseline gap-3">
                    <span className="mono text-ink/55 w-20 shrink-0">
                      {e.event.date}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">
                        {e.event.venue || "Venue TBD"}
                      </div>
                      <div className="text-sm text-ink/60">{e.event.city}</div>
                    </div>
                    <div className="text-right">
                      <div className="display text-2xl">{headline}</div>
                      <div className="mono text-ink/40">
                        {useRadius
                          ? `≤${radiusMiles}MI`
                          : `IN ${e.stateCode ?? "?"}`}
                      </div>
                    </div>
                  </div>
                  {e.sameCityCount > 0 && (
                    <div className="ml-[5.5rem] mt-1 mono text-red">
                      ★ {e.sameCityCount} IN SAME CITY
                    </div>
                  )}
                  {e.sampleCustomers.length > 0 && (
                    <div className="ml-[5.5rem] mt-1 serif-italic text-ink/55 text-xs">
                      e.g.{" "}
                      {e.sampleCustomers
                        .map(
                          (c) => `${c.name ?? "(unnamed)"} (${c.city ?? "?"})`,
                        )
                        .join(", ")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 02 — Routing opportunities */}
        <div>
          <div className="mono mb-3 pb-2 border-b border-ink/15">
            02 — 💡 ROUTING OPPORTUNITIES
          </div>
          {gapGroups.size === 0 ? (
            <div className="serif-italic text-ink/55 text-sm">
              No fillable gaps found — either no multi-day gaps between stops,
              or no customer-dense cities sit on-route within {radiusMiles}mi.
              Widen the radius to surface more.
            </div>
          ) : (
            <div className="space-y-4">
              {[...gapGroups.entries()].map(([key, sugs]) => {
                const s0 = sugs[0];
                return (
                  <div key={key}>
                    <div className="mono text-ink/50 text-xs mb-1">
                      {s0.gapDays}-DAY GAP · {s0.fromCity} ({s0.fromDate}) →{" "}
                      {s0.toCity} ({s0.toDate})
                    </div>
                    {sugs.map((s, i) => (
                      <div
                        key={i}
                        className="flex items-baseline gap-3 ml-1 mb-1"
                      >
                        <span className="text-blue">→</span>
                        <span className="font-medium flex-1">
                          {s.city}, {s.stateCode}
                        </span>
                        <span className="display text-lg">{s.customers}</span>
                        <span className="mono text-ink/40 text-xs w-28 text-right">
                          +{s.detourMiles}mi · ~{s.suggestedDate.slice(5)}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {/* 03 — Untapped markets */}
          <div className="mono mb-3 mt-6 pb-2 border-b border-ink/15">
            03 — TOP UNTAPPED MARKETS · TOUR NEXT
          </div>
          {result.untappedMarkets.length === 0 ? (
            <div className="serif-italic text-ink/55 text-sm">
              Every dense customer city is already within range of a stop.
              Strong routing.
            </div>
          ) : (
            <div className="space-y-1.5">
              {result.untappedMarkets.map((m, i) => (
                <div key={i} className="flex items-baseline gap-3">
                  <span className="mono text-ink/40 w-5">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="font-medium flex-1">
                    {m.city}, {m.stateCode}
                  </span>
                  <span className="display text-lg">{m.customers}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 serif-italic text-ink/45 text-xs">
        Distances are straight-line (great-circle) from city centers — close
        enough to rank routing detours. Customers without a recognizable US city
        aren&apos;t mapped.
      </div>
    </div>
  );
}
