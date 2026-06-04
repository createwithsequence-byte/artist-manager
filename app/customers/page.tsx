"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import Papa from "papaparse";
import {
  aggregateByCity,
  parseCustomers,
  parseImportedFans,
  mergeFanSources,
  type Customer,
  type CityAggregate,
  type GeocodeMap,
} from "@/lib/customerCrossover";
import { uploadCustomerDataset } from "@/lib/uploadDataset";

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
  // Stackable globe overlays — additive on top of the POINTS/HEX base.
  const [ovRings, setOvRings] = useState(false);
  const [ovLabels, setOvLabels] = useState(false);
  const [ovPins, setOvPins] = useState(false);
  const [ovHeat, setOvHeat] = useState(false);
  const [ovArcs, setOvArcs] = useState(false);
  // How many top markets get city labels — revealed only when LABELS is on.
  const [labelCount, setLabelCount] = useState(10);
  const [datasetName, setDatasetName] = useState("Songfinch Customer Master");
  // Dataset id — per-artist (sp:… / nm:…) when arrived at via ?artist, else
  // the global "master". Drives hydrate + persist so each artist's world is
  // their own. isArtistWorld brands the header.
  const [datasetId, setDatasetId] = useState("master");
  const [isArtistWorld, setIsArtistWorld] = useState(false);
  const [persistedAt, setPersistedAt] = useState<string | null>(null);
  // Surfaced when the dataset fails to persist (was a silent catch).
  const [persistError, setPersistError] = useState<string | null>(null);
  // Songfinch vs imported breakdown of the loaded fanbase, for the header.
  const [fanSplit, setFanSplit] = useState<{
    songfinch: number;
    imported: number;
  } | null>(null);
  // Adopt-master offer for an empty artist world (mirror of the routing panel).
  const [masterOffer, setMasterOffer] = useState<{ count: number } | null>(
    null,
  );
  const [adopting, setAdopting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  // Arrived from a dashboard "＋ import fan list" link (?import=1) — flag the
  // IMPORT FANBASE button so the eye lands on it. (We don't auto-open the file
  // picker: browsers block programmatic picker opens without a user gesture.)
  const [highlightImport, setHighlightImport] = useState(false);

  // On mount: read ?artist + ?name from the URL (window.location avoids the
  // useSearchParams Suspense-boundary requirement), then hydrate THAT dataset.
  // No param → the global master. Stays idle (upload zone) if the dataset is
  // empty — e.g. an artist whose customers haven't been uploaded yet.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const artist = params.get("artist");
    const name = params.get("name");
    const id = artist || "master";
    setDatasetId(id);
    setIsArtistWorld(!!artist);
    if (name) setDatasetName(name);
    if (params.get("import") === "1") setHighlightImport(true);

    fetch(`/api/customers?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.dataset?.aggregate?.length) {
          setStage({
            kind: "ready",
            aggregate: d.dataset.aggregate,
            customerCount: d.dataset.customerCount,
            dropped: 0,
            sourceLabel: `★ ${d.dataset.name} · saved ${new Date(d.dataset.updatedAt).toISOString().slice(0, 10)}`,
          });
          // The URL's ?name (artist's display name) wins for branding — the
          // stored dataset name may be an old CSV filename. Only fall back to
          // the stored name when no name was passed (e.g. the global master).
          if (!name) setDatasetName(d.dataset.name);
          setPersistedAt(d.dataset.updatedAt);
        } else if (artist) {
          // Empty artist world — offer to adopt the legacy master if present.
          fetch("/api/customers")
            .then((r) => r.json())
            .then((list) => {
              const master = Array.isArray(list?.datasets)
                ? list.datasets.find((x: { id: string }) => x.id === "master")
                : null;
              if (master && master.customerCount > 0) {
                setMasterOffer({ count: master.customerCount });
              }
            })
            .catch(() => {});
        }
      })
      .catch((err) =>
        console.warn(
          "[CUSTOMERS] hydrate failed:",
          err instanceof Error ? err.message : String(err),
        ),
      );
  }, []);

  // Source-aware ingest. A Songfinch CSV and the artist's imported mailing list
  // both land in ONE per-artist dataset: each upload replaces only its own
  // source's rows (mergeFanSources) and dedupes by email across sources, so
  // re-uploading one never wipes the other. The merged set drives the globe +
  // routing + outreach exactly as before.
  const ingestFans = useCallback(
    (file: File, source: "songfinch" | "imported") => {
      setStage({ kind: "parsing", fileName: file.name });
      Papa.parse<Record<string, string>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: async (result) => {
          try {
            const parsed =
              source === "imported"
                ? parseImportedFans(result.data)
                : parseCustomers(result.data);
            if (parsed.length === 0) {
              setStage({
                kind: "error",
                message:
                  source === "imported"
                    ? "No emails found — the mailing-list CSV needs an email column."
                    : "No customers found. Check the CSV has name/city/state columns.",
              });
              return;
            }

            // Merge with whatever's already stored for this dataset.
            let existing: Customer[] = [];
            try {
              const d = await fetch(
                `/api/customers?id=${encodeURIComponent(datasetId)}&raw=1`,
              ).then((r) => r.json());
              if (Array.isArray(d?.raw)) existing = d.raw as Customer[];
            } catch {
              // No existing dataset (or fetch failed) — start from empty.
            }
            const merged = mergeFanSources(existing, parsed, source);
            const sfCount = merged.filter(
              (c) => (c.source ?? "songfinch") === "songfinch",
            ).length;
            setFanSplit({
              songfinch: sfCount,
              imported: merged.length - sfCount,
            });

            const [
              { US_CITY_LATLNG },
              { WORLD_CITY_ADMIN, WORLD_CITY_COUNTRY },
            ] = await Promise.all([
              import("@/lib/usCityToLatLng"),
              import("@/lib/worldCityToLatLng"),
            ]);
            const { aggregate, dropped } = aggregateByCity(
              merged,
              US_CITY_LATLNG as unknown as GeocodeMap,
              { admin: WORLD_CITY_ADMIN, country: WORLD_CITY_COUNTRY },
            );
            if (aggregate.length === 0) {
              setStage({
                kind: "error",
                message:
                  "No geocoded cities found. Check the CSV has city + state columns.",
              });
              return;
            }
            setStage({
              kind: "ready",
              aggregate,
              customerCount: merged.length,
              dropped,
              sourceLabel: file.name,
            });

            setPersistError(null);
            uploadCustomerDataset({
              id: datasetId,
              name: datasetName,
              aggregate,
              customerCount: merged.length,
              customers: merged,
            })
              .then(() => setPersistedAt(new Date().toISOString()))
              .catch((err) => {
                console.warn(
                  "[CUSTOMERS] persist failed:",
                  err instanceof Error ? err.message : String(err),
                );
                setPersistError(
                  err instanceof Error ? err.message : "Save failed",
                );
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
    },
    [datasetName, datasetId],
  );

  const handleFile = useCallback(
    (file: File) => ingestFans(file, "songfinch"),
    [ingestFans],
  );
  const importFans = useCallback(
    (file: File) => ingestFans(file, "imported"),
    [ingestFans],
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

  // Adopt the legacy master as this artist's world (server-side copy), then
  // hydrate the now-populated dataset. Mirror of the routing panel's adopt.
  const adoptMaster = () => {
    setAdopting(true);
    fetch("/api/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        copyFrom: "master",
        id: datasetId,
        name: datasetName,
      }),
    })
      .then((r) => r.json())
      .then(async (d) => {
        if (!d?.ok) throw new Error(d?.error || "adopt failed");
        const hd = await fetch(
          `/api/customers?id=${encodeURIComponent(datasetId)}`,
        ).then((r) => r.json());
        if (hd?.dataset?.aggregate?.length) {
          setStage({
            kind: "ready",
            aggregate: hd.dataset.aggregate,
            customerCount: hd.dataset.customerCount,
            dropped: 0,
            sourceLabel: `★ ${hd.dataset.name} · saved ${new Date(hd.dataset.updatedAt).toISOString().slice(0, 10)}`,
          });
          setPersistedAt(hd.dataset.updatedAt);
          setMasterOffer(null);
        }
      })
      .catch((err) =>
        console.warn(
          "[CUSTOMERS] adopt failed:",
          err instanceof Error ? err.message : String(err),
        ),
      )
      .finally(() => setAdopting(false));
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
    // h-dvh (not min-h-screen) bounds the column so the globe's flex-1 fills
    // exactly the leftover viewport — no dead band. bg-white per the SF World
    // brief (cream is the workbench; the worlds read cleaner on white).
    <div className="h-dvh flex flex-col bg-white overflow-hidden">
      {/* Top bar — minimal, mirrors the home toolbar's compact rhythm. */}
      <header className="flex items-center gap-4 px-5 py-3 border-b border-ink/15 bg-white">
        <Link
          href="/"
          className="mono text-xs border border-ink/30 hover:bg-ink hover:text-cream transition-colors px-2.5 h-8 inline-flex items-center gap-1.5 shrink-0"
          title="Back to the artist roster"
        >
          ← ROSTER
        </Link>
        <span className="display text-2xl">
          {isArtistWorld ? (
            <>
              <span className="text-red">{datasetName}</span>
              <span className="text-ink/40">&apos;s</span>{" "}
              <span className="text-blue">World</span>
            </>
          ) : (
            <>
              <span className="text-red">SF</span>{" "}
              <span className="text-blue">World</span>
            </>
          )}
        </span>
        <span className="serif-italic text-ink/55 hidden md:inline">
          {isArtistWorld
            ? `every fan ${datasetName} has sold a song to, on a globe`
            : "everyone you've ever sold a song to, on a globe"}
        </span>
        {stage.kind === "ready" && headerStats && (
          <div className="ml-auto flex items-baseline gap-4 mono text-xs">
            <span>
              <span className="text-ink/45">FANS</span>{" "}
              <span className="font-bold">
                {headerStats.total.toLocaleString()}
              </span>
              {fanSplit && fanSplit.imported > 0 && (
                <span className="text-ink/40">
                  {" "}
                  ({fanSplit.songfinch.toLocaleString()} SF +{" "}
                  {fanSplit.imported.toLocaleString()} list)
                </span>
              )}
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
              onClick={() => {
                setHighlightImport(false);
                importInput.current?.click();
              }}
              className={`px-2 h-7 border transition-colors ${
                highlightImport
                  ? "bg-blue text-cream border-blue ring-2 ring-blue/40 ring-offset-2 ring-offset-cream pulse-dot"
                  : "border-blue/40 text-blue hover:bg-blue hover:text-cream"
              }`}
              title="Import the artist's own mailing list (CSV with an email column) — merges with the Songfinch fans, deduped by email"
            >
              ＋ IMPORT FANBASE
            </button>
            <button
              onClick={replaceDataset}
              className="px-2 h-7 border border-ink/30 hover:bg-ink hover:text-cream transition-colors"
              title="Upload a different Songfinch CSV (replaces only the Songfinch fans; your imported list stays)"
            >
              ↑ REPLACE
            </button>
            <input
              ref={importInput}
              type="file"
              accept=".csv,text/csv,application/vnd.ms-excel,application/csv"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importFans(f);
                e.target.value = "";
              }}
            />
          </div>
        )}
      </header>

      {/* IDLE / EMPTY — upload zone. */}
      {stage.kind === "idle" && (
        <section className="flex-1 flex items-center justify-center px-5 py-12">
          <div className="max-w-3xl w-full">
            <h1 className="display text-5xl md:text-7xl leading-[0.9] mb-4">
              Drop{" "}
              <span className="text-red">
                {isArtistWorld ? `${datasetName}'s` : "your"}
              </span>{" "}
              <span className="text-blue">customers</span>.
            </h1>
            <p className="serif-italic text-ink/70 text-lg mb-8">
              City + state columns required.{" "}
              <span className="not-italic text-base text-ink/55">
                One CSV → globe forever.{" "}
                {isArtistWorld
                  ? `Saved as ${datasetName}'s own world.`
                  : "Auto-saves as the canonical SF master."}
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
            {/* Adopt-master offer — empty artist world + a legacy master. */}
            {masterOffer && (
              <button
                onClick={adoptMaster}
                disabled={adopting}
                className="mt-5 w-full text-left flex items-center gap-3 border border-blue/40 bg-blue/[0.04] px-5 py-4 hover:bg-blue/[0.08] transition-colors disabled:opacity-50"
              >
                <span className="mono text-blue shrink-0">◎ ADOPT</span>
                <span className="serif-italic text-ink/70 flex-1">
                  {adopting
                    ? `Adopting ${masterOffer.count.toLocaleString()} customers as ${datasetName}'s…`
                    : `Existing master has ${masterOffer.count.toLocaleString()} customers — claim them as ${datasetName}'s world (no re-upload).`}
                </span>
                {!adopting && (
                  <span className="mono text-blue shrink-0">→</span>
                )}
              </button>
            )}
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
                {/* Stackable overlays — all additive on top of the base. */}
                <span className="mono text-ink/35 text-xs">+</span>
                <div className="flex border border-ink/25 mono text-xs">
                  {(
                    [
                      [
                        "RINGS",
                        ovRings,
                        setOvRings,
                        "Pulsing rings on top markets",
                      ],
                      [
                        "LABELS",
                        ovLabels,
                        setOvLabels,
                        "City names on top markets",
                      ],
                      ["PINS", ovPins, setOvPins, "Pin markers on top markets"],
                      ["HEAT", ovHeat, setOvHeat, "Surface density heat glow"],
                      [
                        "ARCS",
                        ovArcs,
                        setOvArcs,
                        "Great-circle spine connecting the top 10 markets in rank order",
                      ],
                    ] as const
                  ).map(([label, val, set, tip], i) => (
                    <button
                      key={label}
                      onClick={() => set(!val)}
                      title={tip}
                      aria-pressed={val}
                      className={`px-2.5 h-8 ${i > 0 ? "border-l border-ink/25" : ""} transition-colors ${
                        val ? "bg-ink text-cream" : "text-ink/55 hover:text-ink"
                      }`}
                    >
                      {val ? "◉" : "○"} {label}
                    </button>
                  ))}
                </div>
                {/* Label-count control — only meaningful while LABELS is on.
                    Clarifies that labels mark the TOP markets, and lets the
                    user widen the set (the "why only some cities?" answer). */}
                {ovLabels && (
                  <div
                    className="flex items-center border border-ink/25 mono text-xs"
                    title="How many of the top markets get a city-name label"
                  >
                    <span className="px-2 h-8 inline-flex items-center text-ink/45 border-r border-ink/25">
                      TOP
                    </span>
                    {([10, 25, 50] as const).map((n, i) => (
                      <button
                        key={n}
                        onClick={() => setLabelCount(n)}
                        aria-pressed={labelCount === n}
                        className={`px-2.5 h-8 ${i > 0 ? "border-l border-ink/25" : ""} transition-colors ${
                          labelCount === n
                            ? "bg-ink text-cream"
                            : "text-ink/55 hover:text-ink"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                )}
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
              {persistedAt && !persistError && (
                <span
                  className="text-lime-ink ml-2"
                  title={`Saved ${persistedAt}`}
                >
                  ● SAVED
                </span>
              )}
              {persistError && (
                <span className="text-red ml-2" title={persistError}>
                  ⚠ NOT SAVED — re-upload to retry
                </span>
              )}
            </span>
          </div>

          {/* The viz itself. Mounted-and-frozen pattern: switching VIEW unmounts
              the other to keep memory clean (three.js scenes don't free on
              their own). Globe gets full bleed (dark bg), flat gets a border.
              flex-1 + min-h-0 lets the globe fill the viewport instead of
              floating in a fixed box with dead space below. */}
          <div className="flex-1 min-h-0 flex flex-col">
            {view === "globe" ? (
              <CustomerGlobe
                aggregate={stage.aggregate}
                mode={globeMode}
                showRings={ovRings}
                showLabels={ovLabels}
                showPins={ovPins}
                showHeat={ovHeat}
                showArcs={ovArcs}
                labelCount={labelCount}
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
