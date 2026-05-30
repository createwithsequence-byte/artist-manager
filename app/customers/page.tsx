"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import Papa from "papaparse";
import {
  aggregateByCity,
  parseCustomers,
  type CityAggregate,
  type GeocodeMap,
} from "@/lib/customerCrossover";

// Both viz components are client-only (three.js + Leaflet both need window).
// Dynamic import keeps the main bundle lean — three.js is ~600KB.
const CustomerGlobe = dynamic(() => import("../components/CustomerGlobe"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[560px] bg-ink flex items-center justify-center mono text-cream/60">
      LOADING GLOBE…
    </div>
  ),
});
const CustomerFlatMap = dynamic(() => import("../components/CustomerFlatMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[560px] border border-ink/15 flex items-center justify-center mono text-ink/50">
      LOADING MAP…
    </div>
  ),
});

type View = "globe" | "flat";
type GlobeMode = "points" | "hex";

type Stage =
  | { kind: "idle" }
  | { kind: "parsing"; fileName: string }
  | {
      kind: "ready";
      aggregate: CityAggregate[];
      customerCount: number;
      dropped: number;
      sourceLabel: string;
    }
  | { kind: "error"; message: string };

/**
 * SF customer world view — every previous customer on a 3D globe (default)
 * or 2D map. Upload a CSV once, persist to Turso, browse forever. Also
 * shows the canonical "master" dataset on load if one exists.
 */
export default function CustomersPage() {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const [view, setView] = useState<View>("globe");
  const [globeMode, setGlobeMode] = useState<GlobeMode>("points");
  const [datasetName, setDatasetName] = useState("Songfinch Customer Master");
  const [persistedAt, setPersistedAt] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // On mount, try to hydrate the canonical "master" dataset from Turso.
  // No-op if Turso isn't configured or there's no master saved yet.
  useEffect(() => {
    fetch("/api/customers?id=master")
      .then((r) => r.json())
      .then((d) => {
        if (d?.dataset?.aggregate?.length) {
          setStage({
            kind: "ready",
            aggregate: d.dataset.aggregate,
            customerCount: d.dataset.customerCount,
            dropped: 0,
            sourceLabel: `★ MASTER · saved ${new Date(d.dataset.updatedAt).toISOString().slice(0, 10)}`,
          });
          setDatasetName(d.dataset.name);
          setPersistedAt(d.dataset.updatedAt);
        }
      })
      .catch((err) =>
        console.warn(
          "[CUSTOMERS] master hydrate failed:",
          err instanceof Error ? err.message : String(err),
        ),
      );
  }, []);

  const handleFile = useCallback(
    (file: File) => {
      setStage({ kind: "parsing", fileName: file.name });
      Papa.parse<Record<string, string>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: async (result) => {
          try {
            const customers = parseCustomers(result.data);
            const { US_CITY_LATLNG } = await import("@/lib/usCityToLatLng");
            const { aggregate, dropped } = aggregateByCity(
              customers,
              US_CITY_LATLNG as unknown as GeocodeMap,
            );
            if (aggregate.length === 0) {
              setStage({
                kind: "error",
                message:
                  "No geocoded cities found. Check that the CSV has city + state columns and is US-based.",
              });
              return;
            }
            setStage({
              kind: "ready",
              aggregate,
              customerCount: customers.length,
              dropped,
              sourceLabel: file.name,
            });

            // Auto-persist to Turso as the canonical master so the next visit
            // hydrates instantly AND so the routing-sheet crossover panel can
            // pull from the same source without re-upload. Includes raw rows
            // so the routing panel doesn't have to re-parse the CSV.
            fetch("/api/customers", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id: "master",
                name: datasetName,
                aggregate,
                customerCount: customers.length,
                raw: customers,
              }),
            })
              .then((r) => r.json())
              .then((d) => {
                if (d?.ok) setPersistedAt(new Date().toISOString());
              })
              .catch((err) =>
                console.warn(
                  "[CUSTOMERS] persist failed:",
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
    },
    [datasetName],
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const replaceDataset = () => {
    setStage({ kind: "idle" });
    if (fileInput.current) fileInput.current.value = "";
  };

  const headerStats = useMemo(() => {
    if (stage.kind !== "ready") return null;
    const total = stage.customerCount;
    const cities = stage.aggregate.length;
    const states = new Set(stage.aggregate.map((a) => a.stateCode)).size;
    const top = stage.aggregate.slice(0, 3);
    return { total, cities, states, top };
  }, [stage]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top bar — minimal, mirrors the home toolbar's compact rhythm. */}
      <header className="flex items-center gap-4 px-5 py-3 border-b border-ink/15">
        <Link
          href="/"
          className="display text-2xl hover:text-red transition-colors"
          title="Back to artist roster"
        >
          ←
        </Link>
        <span className="display text-2xl">
          <span className="text-red">SF</span>{" "}
          <span className="text-blue">World</span>
        </span>
        <span className="serif-italic text-ink/55 hidden md:inline">
          everyone you&apos;ve ever sold a song to, on a globe
        </span>
        {stage.kind === "ready" && headerStats && (
          <div className="ml-auto flex items-baseline gap-4 mono text-xs">
            <span>
              <span className="text-ink/45">FANS</span>{" "}
              <span className="font-bold">
                {headerStats.total.toLocaleString()}
              </span>
            </span>
            <span>
              <span className="text-ink/45">CITIES</span>{" "}
              <span className="font-bold">
                {headerStats.cities.toLocaleString()}
              </span>
            </span>
            <span>
              <span className="text-ink/45">STATES</span>{" "}
              <span className="font-bold">{headerStats.states}</span>
            </span>
            <button
              onClick={replaceDataset}
              className="px-2 h-7 border border-ink/30 hover:bg-ink hover:text-cream transition-colors"
              title="Upload a different CSV to replace the master"
            >
              ↑ REPLACE
            </button>
          </div>
        )}
      </header>

      {/* IDLE / EMPTY — upload zone. */}
      {stage.kind === "idle" && (
        <section className="flex-1 flex items-center justify-center px-5 py-12">
          <div className="max-w-3xl w-full">
            <h1 className="display text-5xl md:text-7xl leading-[0.9] mb-4">
              Drop your <span className="text-red">customer</span>{" "}
              <span className="text-blue">list</span>.
            </h1>
            <p className="serif-italic text-ink/70 text-lg mb-8">
              City + state columns required.{" "}
              <span className="not-italic text-base text-ink/55">
                One CSV → globe forever. Auto-saves as the canonical SF master.
              </span>
            </p>
            <label
              htmlFor="customers-csv"
              onDrop={onDrop}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              className={`block cursor-pointer border-2 border-dashed transition-colors p-10 md:p-14 ${
                dragOver
                  ? "border-red bg-red/5"
                  : "border-ink/30 hover:border-ink/60"
              }`}
            >
              <div className="display text-3xl md:text-4xl mb-1">Drop CSV</div>
              <div className="mono text-ink/55">
                OR CLICK TO BROWSE · CITY + STATE COLUMNS REQUIRED
              </div>
            </label>
            <input
              ref={fileInput}
              id="customers-csv"
              type="file"
              accept=".csv,text/csv,application/vnd.ms-excel,application/csv"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
          </div>
        </section>
      )}

      {/* PARSING */}
      {stage.kind === "parsing" && (
        <section className="flex-1 flex items-center justify-center px-5">
          <div className="mono text-ink/60">PARSING · {stage.fileName}…</div>
        </section>
      )}

      {/* ERROR */}
      {stage.kind === "error" && (
        <section className="flex-1 flex flex-col items-center justify-center px-5 gap-4">
          <div className="mono text-red">ERROR · {stage.message}</div>
          <button
            onClick={replaceDataset}
            className="mono px-3 h-9 border border-ink hover:bg-ink hover:text-cream transition-colors"
          >
            ↑ TRY AGAIN
          </button>
        </section>
      )}

      {/* READY — viz */}
      {stage.kind === "ready" && (
        <section className="flex-1 flex flex-col">
          {/* View + mode controls. */}
          <div className="px-5 py-2 flex flex-wrap items-center gap-3 border-b border-ink/10">
            <span className="mono text-ink/45 text-xs hidden sm:inline">
              VIEW
            </span>
            <div
              className="flex border border-ink/25 mono text-xs"
              role="radiogroup"
              aria-label="Visualization mode"
            >
              <button
                role="radio"
                aria-checked={view === "globe"}
                onClick={() => setView("globe")}
                className={`px-3 h-8 transition-colors ${
                  view === "globe"
                    ? "bg-ink text-cream"
                    : "text-ink/55 hover:text-ink"
                }`}
              >
                ◯ GLOBE
              </button>
              <button
                role="radio"
                aria-checked={view === "flat"}
                onClick={() => setView("flat")}
                className={`px-3 h-8 border-l border-ink/25 transition-colors ${
                  view === "flat"
                    ? "bg-ink text-cream"
                    : "text-ink/55 hover:text-ink"
                }`}
              >
                ▭ FLAT MAP
              </button>
            </div>
            {view === "globe" && (
              <>
                <span className="mono text-ink/35 text-xs">·</span>
                <span className="mono text-ink/45 text-xs hidden sm:inline">
                  LAYER
                </span>
                <div className="flex border border-ink/25 mono text-xs">
                  <button
                    onClick={() => setGlobeMode("points")}
                    className={`px-3 h-8 transition-colors ${
                      globeMode === "points"
                        ? "bg-ink text-cream"
                        : "text-ink/55 hover:text-ink"
                    }`}
                    title="One weighted dot per city"
                  >
                    • POINTS
                  </button>
                  <button
                    onClick={() => setGlobeMode("hex")}
                    className={`px-3 h-8 border-l border-ink/25 transition-colors ${
                      globeMode === "hex"
                        ? "bg-ink text-cream"
                        : "text-ink/55 hover:text-ink"
                    }`}
                    title="Hex-bin auto-cluster — better at low zoom"
                  >
                    ⬢ HEX
                  </button>
                </div>
              </>
            )}
            <span className="mono text-ink/45 text-xs ml-auto truncate">
              {stage.sourceLabel}
              {stage.dropped > 0 && (
                <span className="text-ink/30">
                  {" "}
                  · {stage.dropped} ROWS DROPPED (un-geocoded)
                </span>
              )}
              {persistedAt && (
                <span className="text-lime ml-2" title={`Saved ${persistedAt}`}>
                  ● SAVED
                </span>
              )}
            </span>
          </div>

          {/* The viz itself. Mounted-and-frozen pattern: switching VIEW unmounts
              the other to keep memory clean (three.js scenes don't free on
              their own). Globe gets full bleed (dark bg), flat gets a border.
              flex-1 + min-h-0 lets the globe fill the viewport instead of
              floating in a fixed box with dead cream space below. */}
          <div className="flex-1 min-h-[68vh] flex flex-col">
            {view === "globe" ? (
              <CustomerGlobe
                aggregate={stage.aggregate}
                mode={globeMode}
                autoRotate
              />
            ) : (
              <CustomerFlatMap aggregate={stage.aggregate} />
            )}
          </div>

          {/* Top-cities sidebar strip — bottom of the page. Mono caps mirror
              the artist roster's rhythm. */}
          {headerStats && (
            <div className="px-5 py-3 border-t border-ink/15">
              <div className="mono text-ink/45 text-xs mb-2">
                TOP CITIES · BY FAN COUNT
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {stage.aggregate.slice(0, 10).map((a, i) => (
                  <div
                    key={`${a.city}-${a.stateCode}`}
                    className="flex items-baseline gap-2"
                  >
                    <span className="mono text-ink/40 tabular-nums w-6">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="font-medium">{a.city}</span>
                    <span className="text-ink/45">, {a.stateCode}</span>
                    <span className="mono text-red tabular-nums">
                      {a.count.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
