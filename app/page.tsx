"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { Toolbar } from "./components/Toolbar";
import { ArtistRow } from "./components/ArtistRow";
import { ProgressPanel } from "./components/ProgressPanel";
import { ExportSection } from "./components/ExportSection";
import type {
  ArtistInput,
  ArtistReport,
  ScoutEvent,
  Signal,
} from "@/lib/types";
import { normalizeReport } from "@/lib/normalize";

type ParsedRow = Record<string, string>;
type FilterKey = "all" | Signal;

const STEP_LABELS: Record<string, string> = {
  musicbrainz: "MUSICBRAINZ",
  spotify: "SPOTIFY (LISTENERS + TOP TRACKS)",
  setlistfm: "SETLIST.FM (RECENT GIGS)",
  "bandsintown-search": "FINDING ON BANDSINTOWN",
  "bandsintown-page": "FETCHING TOUR DATES",
  socials: "CHECKING SOCIALS",
  synthesizing: "SYNTHESIZING",
};

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "ALL" },
  { key: "active-touring", label: "ACTIVE TOURING" },
  { key: "recent-release", label: "RECENT RELEASE" },
  { key: "industry-writer", label: "INDUSTRY WRITER" },
  { key: "between-cycles", label: "BETWEEN CYCLES" },
  { key: "quiet", label: "QUIET" },
];

export default function Home() {
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [sampleSize, setSampleSize] = useState(5);
  const [state, setState] = useState<"idle" | "scouting" | "done">("idle");
  const [reports, setReports] = useState<ArtistReport[]>([]);
  const [errors, setErrors] = useState<{ artist: string; message: string }[]>(
    [],
  );
  const [activeArtist, setActiveArtist] = useState<string>("");
  const [activeStep, setActiveStep] = useState<string>("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [withSocials, setWithSocials] = useState(false);
  const [loopAll, setLoopAll] = useState(false);
  const stopLoopRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Snapshot of reports.length when a scout run starts — used so the
  // progress bar's "completed" count reflects the current batch only,
  // not artists scouted in previous runs that are already in `reports`.
  const reportsAtRunStartRef = useRef(0);

  // Single-artist lookup mode — bypasses CSV upload entirely. When set,
  // overrides the artists derivation so the existing scout flow processes
  // exactly one synthetic "row". fileName stays empty so nothing persists
  // to Turso/localStorage (ephemeral by design — for quick triage, not
  // archival). Auto-triggers a scout once state settles.
  const [singleLookupArtist, setSingleLookupArtist] =
    useState<ArtistInput | null>(null);
  const lookupFiredRef = useRef(false);

  // Hide-stub filter — default ON. When 73% of rows are "AI synthesis
  // unavailable" stubs (current state of an LLM-exhausted scout), they
  // dominate the viewport with noise. Hiding them by default keeps the
  // view to artists you've actually computed a signal for. The chip
  // counter shows how many are hidden so it's never invisible work.
  const [hideStubs, setHideStubs] = useState(true);

  // Persistence backend: 'unknown' on mount → 'turso' or 'local' after first probe.
  const [persistenceMode, setPersistenceMode] = useState<
    "unknown" | "turso" | "local"
  >("unknown");
  const tursoSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Recent runs picker — populated from /api/csvs so coworkers can browse
  // previously-scouted rosters without having the source CSV handy.
  const [recentCsvs, setRecentCsvs] = useState<
    { csv_name: string; artist_count: number; last_updated: string }[]
  >([]);

  useEffect(() => {
    fetch("/api/csvs")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.csvs)) setRecentCsvs(d.csvs);
      })
      .catch((err) =>
        console.warn(
          "[RECENT_CSVS]",
          err instanceof Error ? err.message : String(err),
        ),
      );
  }, []);

  // Batch deep-dive state
  const [diveBatch, setDiveBatch] = useState<{
    running: boolean;
    total: number;
    done: string[];
    failed: { name: string; error: string }[];
    current: string[];
  }>({ running: false, total: 0, done: [], failed: [], current: [] });
  const diveAbortRef = useRef<AbortController | null>(null);

  const cacheKey = fileName ? `am:cache:${fileName}` : null;

  // Load cached reports on mount / when CSV changes.
  // Priority: Turso (if configured) → localStorage fallback.
  // If Turso is configured but empty AND localStorage has data, migrate it.
  useEffect(() => {
    if (!fileName) return;
    let cancelled = false;

    (async () => {
      // Probe Turso first
      try {
        const res = await fetch(
          `/api/reports?csv_name=${encodeURIComponent(fileName)}`,
        );
        const json = await res.json();
        if (cancelled) return;

        if (json.configured) {
          // Local fallback (for migration check + display while Turso loads)
          let localReports: ArtistReport[] = [];
          let localErrors: { artist: string; message: string }[] = [];
          if (cacheKey) {
            try {
              const cached = localStorage.getItem(cacheKey);
              if (cached) {
                const parsed = JSON.parse(cached);
                localReports = parsed.reports ?? [];
                localErrors = parsed.errors ?? [];
              }
            } catch {}
          }

          if ((json.reports?.length ?? 0) > 0) {
            // Turso has data — use it. Normalize to guard against legacy
            // reports missing fields that became required later (events,
            // releases, signals). Without this, ArtistRow crashes on render
            // and the global error boundary blanks the page.
            setReports(json.reports.map(normalizeReport));
            if (localErrors.length) setErrors(localErrors);
            setPersistenceMode("turso");
            return;
          }

          // Turso empty — migrate localStorage if present
          if (localReports.length > 0) {
            await fetch("/api/reports", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                csv_name: fileName,
                reports: localReports,
              }),
            });
            setReports(localReports.map(normalizeReport));
            if (localErrors.length) setErrors(localErrors);
            setPersistenceMode("turso");
            console.log(
              `[TURSO] migrated ${localReports.length} reports from localStorage`,
            );
            return;
          }

          setPersistenceMode("turso");
          return;
        }

        // Turso not configured — fall back to localStorage
        setPersistenceMode("local");
        if (cacheKey) {
          try {
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
              const parsed = JSON.parse(cached);
              if (parsed.reports?.length)
                setReports(parsed.reports.map(normalizeReport));
              if (parsed.errors?.length) setErrors(parsed.errors);
            }
          } catch {}
        }
      } catch (err) {
        if (cancelled) return;
        console.warn(
          "[PERSISTENCE] Turso probe failed, using localStorage",
          err,
        );
        setPersistenceMode("local");
        if (cacheKey) {
          try {
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
              const parsed = JSON.parse(cached);
              if (parsed.reports?.length)
                setReports(parsed.reports.map(normalizeReport));
              if (parsed.errors?.length) setErrors(parsed.errors);
            }
          } catch {}
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName]);

  // Persist reports + errors whenever they change.
  // Always write to localStorage (instant, offline-safe).
  // Also debounce-push to Turso when configured.
  useEffect(() => {
    if (!cacheKey) return;
    if (reports.length === 0 && errors.length === 0) return;
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ reports, errors }));
    } catch {
      // localStorage quota or disabled
    }

    if (persistenceMode !== "turso" || !fileName) return;
    if (tursoSyncTimerRef.current) clearTimeout(tursoSyncTimerRef.current);
    tursoSyncTimerRef.current = setTimeout(() => {
      fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv_name: fileName, reports }),
      }).catch((err) => console.warn("[TURSO] sync failed:", err));
    }, 1500);
  }, [reports, errors, cacheKey, fileName, persistenceMode]);

  const detectNameColumn = (rows: ParsedRow[]): string | null => {
    if (!rows.length) return null;
    const keys = Object.keys(rows[0]);
    return (
      keys.find((k) => /talent\s*name|artist\s*name|^name$/i.test(k)) ??
      keys.find((k) => /name/i.test(k)) ??
      keys[0] ??
      null
    );
  };

  const nameCol = useMemo(() => (rows ? detectNameColumn(rows) : null), [rows]);
  const artists = useMemo<ArtistInput[]>(() => {
    // Single-artist lookup overrides CSV-derived artists entirely.
    if (singleLookupArtist) return [singleLookupArtist];
    if (!rows || !nameCol) return [];
    return rows
      .map((r) => ({
        name: (r[nameCol] || "").trim(),
        spotifyUrl: r["Spotify"] || r["spotify"],
        instagram: r["Instagram"] || r["instagram"],
        tiktok: r["TikTok"] || r["tiktok"],
      }))
      .filter((a) => a.name);
  }, [rows, nameCol, singleLookupArtist]);

  // Backfill: cached reports from older runs don't have csvSpotifyUrl.
  // Cross-reference with the current artists list (from CSV) to populate it,
  // so deep-dives anchor on the correct identity even for legacy reports.
  // IMPORTANT: only call setReports if we actually changed something —
  // otherwise we ping-pong forever (the .map always allocates a new array).
  useEffect(() => {
    if (reports.length === 0 || artists.length === 0) return;
    const byName = new Map(
      artists.map((a) => [a.name.toLowerCase(), a.spotifyUrl]),
    );
    let changed = false;
    const next = reports.map((r) => {
      if (r.csvSpotifyUrl !== undefined) return r;
      const url = byName.get(r.name.toLowerCase());
      if (!url) return r; // no CSV match — leave key absent, don't loop
      changed = true;
      return { ...r, csvSpotifyUrl: url };
    });
    if (changed) setReports(next);
  }, [reports, artists]);

  const handleFile = useCallback((file: File) => {
    console.log(
      `[CSV] handleFile invoked · name="${file.name}" size=${file.size} type="${file.type}"`,
    );
    setFileName(file.name);
    Papa.parse<ParsedRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        console.log(
          `[CSV] parse complete · rows=${result.data.length} errors=${result.errors.length}`,
        );
        if (result.errors.length > 0) {
          console.warn("[CSV] parse errors:", result.errors.slice(0, 3));
        }
        if (result.data.length === 0) {
          console.warn(
            "[CSV] zero rows parsed — check that the file has a header row and isn't empty",
          );
        }
        setRows(result.data);
      },
      error: (err) => {
        console.error("[CSV] parse failed:", err);
      },
    });
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleEvent = (event: ScoutEvent) => {
    if (event.type === "start") {
      setActiveArtist(event.artist);
      setActiveStep("starting");
    } else if (event.type === "step") {
      setActiveArtist(event.artist);
      setActiveStep(event.step);
    } else if (event.type === "report") {
      // Normalize even streamed reports — if /api/scout ever emits one
      // missing a required array field (synth stub, partial response, etc.),
      // ArtistRow rendering would crash and blank the page.
      setReports((prev) => [...prev, normalizeReport(event.report)]);
    } else if (event.type === "error") {
      setErrors((prev) => [
        ...prev,
        { artist: event.artist, message: event.message },
      ]);
    }
  };

  // Ref mirrors `reports` so async loops see fresh data after each batch.
  const reportsRef = useRef<ArtistReport[]>([]);
  useEffect(() => {
    reportsRef.current = reports;
  }, [reports]);

  const runOnce = async (continueIfLooping: boolean) => {
    if (!artists.length) return;
    const scoutedNames = new Set(
      reportsRef.current.map((r) => r.name.toLowerCase()),
    );
    const remaining = artists.filter(
      (a) => !scoutedNames.has(a.name.toLowerCase()),
    );
    const subset = remaining.slice(0, sampleSize);
    if (subset.length === 0) return;
    // Snapshot reports count at run-start so progress math during scouting
    // can compute completed-this-batch correctly. The prior formula
    // (reports.filter not-in-scoutedNames) was mathematically always 0
    // because scoutedNames is derived from reports.
    reportsAtRunStartRef.current = reports.length;
    setState("scouting");
    setErrors([]);
    setActiveArtist("");
    setActiveStep("");

    const controller = new AbortController();
    abortRef.current = controller;

    let res: Response;
    try {
      res = await fetch("/api/scout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artists: subset, withSocials }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        setState("done");
        setActiveStep("");
        setActiveArtist("");
        return;
      }
      throw err;
    }
    if (!res.ok || !res.body) {
      setErrors([
        { artist: "(system)", message: `Request failed: ${res.status}` },
      ]);
      setState("done");
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as ScoutEvent;
            handleEvent(event);
          } catch {
            // partial JSON line; retry next chunk
          }
        }
      }
    } catch (err) {
      // AbortError when user pauses — silent, just exit the read loop
      if (!controller.signal.aborted) throw err;
    }
    abortRef.current = null;
    setState("done");
    setActiveStep("");
    setActiveArtist("");

    if (continueIfLooping && !stopLoopRef.current) {
      const stillRemaining = artists.filter(
        (a) =>
          !new Set(reportsRef.current.map((r) => r.name.toLowerCase())).has(
            a.name.toLowerCase(),
          ),
      );
      if (stillRemaining.length > 0) {
        await new Promise((r) => setTimeout(r, 1500));
        if (!stopLoopRef.current) await runOnce(true);
      }
    }
  };

  const runScout = async () => {
    stopLoopRef.current = false;
    await runOnce(loopAll);
  };

  const stopLoop = () => {
    stopLoopRef.current = true;
    abortRef.current?.abort();
  };

  const runBatchDeepDive = async (targets: ArtistReport[]) => {
    if (targets.length === 0 || diveBatch.running) return;
    const controller = new AbortController();
    diveAbortRef.current = controller;
    setDiveBatch({
      running: true,
      total: targets.length,
      done: [],
      failed: [],
      current: [],
    });

    const CONCURRENCY = 3;
    let cursor = 0;

    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
          if (controller.signal.aborted) return;
          const i = cursor++;
          if (i >= targets.length) return;
          const target = targets[i];
          setDiveBatch((prev) => ({
            ...prev,
            current: [...prev.current, target.name],
          }));
          try {
            const res = await fetch("/api/deep-dive", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: target.name,
                location: target.location,
                spotifyId: target.csvSpotifyUrl ?? target.spotify?.id,
                csvSpotifyUrl: target.csvSpotifyUrl,
                bandsintownUrl: target.bandsintownUrl,
                spotify:
                  target.csvSpotifyUrl &&
                  target.spotify?.id &&
                  target.csvSpotifyUrl.includes(target.spotify.id)
                    ? target.spotify
                    : undefined,
              }),
              signal: controller.signal,
            });
            const json = await res.json();
            if (!res.ok || !json.ok) {
              throw new Error(json.error ?? `HTTP ${res.status}`);
            }
            setReports((prev) =>
              prev.map((p) =>
                p.name === target.name ? { ...p, deepDive: json.dive } : p,
              ),
            );
            setDiveBatch((prev) => ({
              ...prev,
              current: prev.current.filter((n) => n !== target.name),
              done: [...prev.done, target.name],
            }));
          } catch (err) {
            if (controller.signal.aborted) return;
            const message = err instanceof Error ? err.message : String(err);
            setDiveBatch((prev) => ({
              ...prev,
              current: prev.current.filter((n) => n !== target.name),
              failed: [...prev.failed, { name: target.name, error: message }],
            }));
          }
        }
      }),
    );

    diveAbortRef.current = null;
    setDiveBatch((prev) => ({ ...prev, running: false, current: [] }));
  };

  const cancelBatchDeepDive = () => {
    diveAbortRef.current?.abort();
  };

  // Auto-fire scout when single-artist lookup state lands. We can't call
  // runOnce inline from the form handler because `artists` is derived via
  // useMemo and only updates AFTER React commits the state change. The
  // effect waits for the derived `artists` to reach exactly 1 (our synthetic
  // lookup row), then triggers runOnce once. The lookupFiredRef guards
  // against re-firing across renders.
  useEffect(() => {
    if (
      singleLookupArtist &&
      artists.length === 1 &&
      state === "idle" &&
      reports.length === 0 &&
      !lookupFiredRef.current
    ) {
      lookupFiredRef.current = true;
      runOnce(false);
    }
    if (!singleLookupArtist) {
      lookupFiredRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleLookupArtist, artists.length, state, reports.length]);

  const exitSingleLookup = () => {
    setSingleLookupArtist(null);
    lookupFiredRef.current = false;
    setReports([]);
    setErrors([]);
    setActiveArtist("");
    setActiveStep("");
    setState("idle");
  };

  const resetAll = () => {
    stopLoopRef.current = true;
    if (cacheKey) {
      try {
        localStorage.removeItem(cacheKey);
      } catch {}
    }
    if (persistenceMode === "turso" && fileName) {
      fetch(`/api/reports?csv_name=${encodeURIComponent(fileName)}`, {
        method: "DELETE",
      }).catch((err) => console.warn("[TURSO] delete failed:", err));
    }
    setState("idle");
    setReports([]);
    setErrors([]);
    setActiveArtist("");
    setActiveStep("");
  };

  const clearCsv = () => {
    if (cacheKey) {
      try {
        localStorage.removeItem(cacheKey);
      } catch {}
    }
    setRows(null);
    setFileName("");
    // Reset the file input's value — browsers dedupe re-uploads of the same
    // file (no onChange fires for an identical selection). Without this,
    // clicking IMPORT CSV → picking the same file again appears to do nothing.
    if (fileInput.current) fileInput.current.value = "";
    resetAll();
  };

  // A "stub" is a report whose synth fell back to the dummy summary because
  // every LLM provider was exhausted at synthesis time. They still hold raw
  // data (Spotify, events, releases) but have no signals or written summary,
  // so they're noise in the main list until re-classified via /api/resynth.
  const isStub = (r: ArtistReport) =>
    typeof r.summary === "string" &&
    r.summary.includes("AI synthesis unavailable");

  const filteredReports = useMemo(() => {
    let result = reports;
    if (filter !== "all") {
      result = result.filter((r) => (r.signals ?? []).includes(filter));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter((r) => r.name.toLowerCase().includes(q));
    }
    // Hide-stubs filter (default ON) — applied AFTER signal/search filters so
    // the user can still toggle a specific signal chip and see all matching
    // artists in that signal (signal-having artists are never stubs).
    if (hideStubs && filter === "all") {
      result = result.filter((r) => !isStub(r));
    }
    // Classified-first sort: artists with signals lead, stubs trail. Within
    // each group preserve insertion order so the user's mental map of "row
    // 037 is X" stays stable when toggling the hide-stubs filter.
    result = [...result].sort((a, b) => {
      const aStub = isStub(a);
      const bStub = isStub(b);
      if (aStub === bStub) return 0;
      return aStub ? 1 : -1;
    });
    return result;
  }, [reports, filter, searchQuery, hideStubs]);

  const stubCount = useMemo(() => reports.filter(isStub).length, [reports]);

  const scoutedNames = useMemo(
    () => new Set(reports.map((r) => r.name.toLowerCase())),
    [reports],
  );
  const remaining = useMemo(
    () => artists.filter((a) => !scoutedNames.has(a.name.toLowerCase())),
    [artists, scoutedNames],
  );

  const thisRunSize = Math.min(remaining.length, sampleSize);
  const total = state === "scouting" ? thisRunSize : remaining.length;
  const completed =
    state === "scouting"
      ? reports.length - reportsAtRunStartRef.current + errors.length
      : reports.length;
  const hasResults = reports.length > 0 || errors.length > 0;
  const currentStatus = activeArtist
    ? `${activeArtist.toUpperCase()} · ${STEP_LABELS[activeStep] ?? activeStep.toUpperCase()}`
    : undefined;

  return (
    <div className="min-h-screen">
      <Toolbar
        state={state}
        current={currentStatus}
        completed={completed}
        total={total}
        fileName={fileName || undefined}
        artistCount={artists.length || undefined}
        hasCsv={!!rows}
        onImport={() => fileInput.current?.click()}
        onRun={runScout}
        onReset={hasResults ? resetAll : clearCsv}
        canRun={remaining.length > 0}
        persistenceMode={persistenceMode}
      />

      <input
        ref={fileInput}
        id="csv-file-input"
        type="file"
        accept=".csv,text/csv,application/vnd.ms-excel,application/csv"
        className="sr-only"
        onChange={(e) => {
          const files = e.target.files;
          console.log(`[CSV] onChange · files=${files?.length ?? 0}`);
          const file = files?.[0];
          if (file) handleFile(file);
        }}
      />

      {/* Single-lookup mode banner — replaces the cream-on-cream toolbar
          context with a clear scope indicator so the user knows they're
          NOT looking at a full roster. Click the × to exit and return to
          the empty state. Only shows while singleLookupArtist is set. */}
      {singleLookupArtist && (
        <div className="bg-ink text-cream px-5 py-2 flex items-center gap-3">
          <span className="mono text-cream/60">LOOKING UP</span>
          <span className="font-medium truncate">
            {singleLookupArtist.name}
          </span>
          {singleLookupArtist.spotifyUrl && (
            <span className="mono text-cream/45 truncate hidden md:inline">
              · {singleLookupArtist.spotifyUrl}
            </span>
          )}
          <button
            onClick={exitSingleLookup}
            className="mono ml-auto text-cream/60 hover:text-red transition-colors"
            title="Exit single-artist mode and return to upload"
          >
            ✕ EXIT
          </button>
        </div>
      )}

      {!rows && !hasResults && !singleLookupArtist && (
        <section className="px-5 py-12 md:py-20">
          <div className="max-w-5xl">
            <h1 className="display text-6xl md:text-8xl lg:text-9xl leading-[0.85] mb-6">
              <span className="text-red">Artist</span>{" "}
              <span className="text-blue">Manager</span>
            </h1>
            <p className="serif-italic text-xl md:text-2xl text-ink/80 max-w-2xl mb-10">
              Upload a roster.{" "}
              <span className="not-italic font-sans text-base text-ink/60 block mt-2">
                Get a read on what every artist has going on — recent releases,
                tour dates, festival appearances, creative status — in one pass.
              </span>
            </p>

            <label
              htmlFor="csv-file-input"
              onDrop={onDrop}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              className={`block cursor-pointer border-2 border-dashed transition-colors p-12 md:p-16 ${
                dragOver
                  ? "border-red bg-red/5"
                  : "border-ink/30 hover:border-ink/60"
              }`}
            >
              <div className="display text-3xl md:text-5xl mb-2">Drop CSV</div>
              <div className="mono text-ink/60">
                OR CLICK TO BROWSE · ACCEPTS ANY HEADER WITH A &quot;NAME&quot;
                COLUMN
              </div>
            </label>

            {/* Single-artist quick lookup — bypasses CSV upload for one-off
                triage. Spotify URL is optional but recommended: when present
                the orchestrator anchors identity to it across MB + sidecar
                lookups, killing the "Tori → Tori Kelly" class of fuzzy-match
                identity poisoning. Submission auto-fires a scout via the
                effect above; result renders as a single expanded row with
                the Customer Crossover panel inline for geo-overlap analysis. */}
            <div className="mt-10">
              <div className="mono text-ink/50 mb-3">
                ↳ OR LOOK UP A SINGLE ARTIST
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  const name = String(fd.get("name") || "").trim();
                  if (!name) return;
                  const spotifyUrlRaw = String(
                    fd.get("spotifyUrl") || "",
                  ).trim();
                  setSingleLookupArtist({
                    name,
                    spotifyUrl: spotifyUrlRaw || undefined,
                  });
                }}
                className="flex flex-col sm:flex-row gap-2"
              >
                <input
                  name="name"
                  type="text"
                  required
                  placeholder="Artist name"
                  className="flex-1 border border-ink/30 bg-transparent px-3 h-11 focus:outline-none focus:border-ink placeholder:text-ink/35"
                />
                <input
                  name="spotifyUrl"
                  type="text"
                  placeholder="Spotify URL (optional — anchors identity)"
                  className="flex-[1.5] border border-ink/30 bg-transparent px-3 h-11 focus:outline-none focus:border-ink placeholder:text-ink/35 mono text-sm"
                />
                <button
                  type="submit"
                  className="mono h-11 px-5 bg-ink text-cream hover:bg-red transition-colors shrink-0"
                >
                  LOOK UP →
                </button>
              </form>
              <div className="serif-italic text-ink/55 text-sm mt-2">
                One-off triage. Result is ephemeral — not saved to Turso. Drop a
                customer CSV inside the expanded row for tour-overlap analysis.
              </div>
            </div>

            {recentCsvs.length > 0 && (
              <div className="mt-10">
                <div className="mono text-ink/50 mb-3">
                  ↳ OR OPEN A PREVIOUS RUN
                </div>
                <div className="space-y-px">
                  {recentCsvs.map((c) => (
                    <button
                      key={c.csv_name}
                      onClick={() => {
                        // Set fileName — the existing hydration useEffect
                        // (depends on cacheKey/fileName) picks this up and
                        // loads the saved reports from Turso. No need to
                        // re-parse the source CSV; rows stays null which
                        // hides the upload UI naturally via the
                        // {!rows && hasResults check below.
                        setFileName(c.csv_name);
                      }}
                      className="w-full text-left flex items-baseline gap-4 px-4 py-3 border-b border-ink/10 hover:bg-ink/[0.04] transition-colors group"
                    >
                      <span className="font-medium truncate flex-1">
                        {c.csv_name}
                      </span>
                      <span className="mono text-ink/60 shrink-0">
                        {c.artist_count} ARTISTS
                      </span>
                      <span className="mono text-ink/35 shrink-0 hidden sm:inline">
                        {c.last_updated
                          ? new Date(c.last_updated).toISOString().slice(0, 10)
                          : ""}
                      </span>
                      <span className="mono text-ink/40 group-hover:text-red shrink-0">
                        →
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-12 grid grid-cols-2 md:grid-cols-4 gap-x-8 gap-y-6 max-w-3xl">
              {[
                {
                  dot: "bg-red",
                  label: "ACTIVE TOURING",
                  body: "Confirmed dates in your 3-month window",
                },
                {
                  dot: "bg-blue",
                  label: "RECENT RELEASE",
                  body: "Single/EP/album in the last 90 days",
                },
                {
                  dot: "bg-lime",
                  label: "INDUSTRY WRITER",
                  body: "Writes/produces for others, light footprint",
                },
                {
                  dot: "bg-ink/30",
                  label: "QUIET / BETWEEN",
                  body: "No current cycle activity",
                },
              ].map((s) => (
                <div key={s.label}>
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${s.dot}`}
                    />
                    <span className="mono">{s.label}</span>
                  </div>
                  <div className="text-sm text-ink/60">{s.body}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {rows && reports.length > 0 && state !== "scouting" && (
        <ExportSection reports={reports} totalArtists={artists.length} />
      )}

      {rows && (
        <ProgressPanel
          scoutedCount={reports.length}
          failedCount={errors.length}
          queuedCount={
            remaining.length - errors.length > 0
              ? remaining.length - errors.length
              : Math.max(0, remaining.length - errors.length)
          }
          totalArtists={artists.length}
          sampleSize={sampleSize}
          setSampleSize={setSampleSize}
          sliderMax={Math.min(200, artists.length)}
          isScouting={state === "scouting"}
          withSocials={withSocials}
          setWithSocials={setWithSocials}
          inProgressLabel={currentStatus}
          inProgressCount={
            state === "scouting"
              ? thisRunSize -
                reports.filter((r) => scoutedNames.has(r.name.toLowerCase()))
                  .length
              : 0
          }
          onRun={runScout}
          onStop={stopLoop}
          estSecondsPerArtist={withSocials ? 38 : 25}
        />
      )}

      {(state === "scouting" || hasResults) && (
        <section>
          {hasResults && reports.length > 1 && (
            <div className="px-5 pt-5 pb-3 border-b border-ink/10 space-y-3">
              <div className="flex items-center gap-3">
                <span className="mono text-ink/50">SEARCH</span>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Type an artist name…"
                  className="font-sans flex-1 bg-transparent border-b border-ink/20 focus:border-ink/60 outline-none px-1 py-1"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="mono text-ink/40 hover:text-ink"
                  >
                    CLEAR
                  </button>
                )}
                {searchQuery && (
                  <span className="mono text-ink/40">
                    {filteredReports.length} MATCH
                    {filteredReports.length === 1 ? "" : "ES"}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {FILTERS.map((f) => {
                  const count =
                    f.key === "all"
                      ? reports.length
                      : reports.filter((r) =>
                          (r.signals ?? []).includes(f.key as Signal),
                        ).length;
                  if (f.key !== "all" && count === 0) return null;
                  const active = filter === f.key;
                  return (
                    <button
                      key={f.key}
                      onClick={() => setFilter(f.key)}
                      className={`mono px-2.5 h-7 border transition-colors ${
                        active
                          ? "bg-ink text-cream border-ink"
                          : "border-ink/25 hover:border-ink/60"
                      }`}
                    >
                      {f.label} · {count}
                    </button>
                  );
                })}
                {/* Hide-stubs toggle — only surfaces when the current view has
                    at least one stub to hide. Default ON because in current
                    LLM-exhaustion conditions ~73% of fresh-scout reports stub,
                    drowning the classified rows. Toggle is mono caps to match
                    the filter-chip register and stays visually subordinate. */}
                {filter === "all" && stubCount > 0 && (
                  <button
                    onClick={() => setHideStubs((s) => !s)}
                    title={
                      hideStubs
                        ? `Showing classified only. ${stubCount} stubs hidden — run /api/resynth to fill them in.`
                        : `Showing all ${reports.length} reports, including ${stubCount} stubs.`
                    }
                    className={`mono px-2.5 h-7 border transition-colors ${
                      hideStubs
                        ? "border-ink/25 hover:border-ink/60 text-ink/55"
                        : "bg-ink/[0.06] border-ink/40 text-ink"
                    }`}
                  >
                    {hideStubs
                      ? `↳ ${stubCount} STUBS HIDDEN`
                      : `◉ SHOWING ${stubCount} STUBS`}
                  </button>
                )}
                {(() => {
                  if (diveBatch.running) return null;
                  const needsDive = filteredReports.filter((r) => !r.deepDive);
                  const activeTouringNoDive = reports.filter(
                    (r) =>
                      (r.signals ?? []).includes("active-touring") &&
                      !r.deepDive,
                  );
                  const cap = 50;
                  return (
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      {filter !== "active-touring" &&
                        activeTouringNoDive.length > 0 && (
                          <button
                            onClick={() => {
                              setFilter("active-touring");
                              runBatchDeepDive(
                                activeTouringNoDive.slice(0, cap),
                              );
                            }}
                            className="mono px-2.5 h-7 border border-red text-red hover:bg-red hover:text-cream transition-colors"
                            title="Filter to active touring artists and dive them in one click"
                          >
                            ★ DIVE ACTIVE TOURING ·{" "}
                            {Math.min(activeTouringNoDive.length, cap)} →
                          </button>
                        )}
                      {needsDive.length > 0 && (
                        <button
                          onClick={() =>
                            runBatchDeepDive(needsDive.slice(0, cap))
                          }
                          className="mono px-2.5 h-7 bg-ink text-cream hover:bg-red transition-colors"
                          title={
                            needsDive.length > cap
                              ? `Capped at ${cap} per batch. Re-click to continue.`
                              : "Generate deep-cut interview prep for filtered artists"
                          }
                        >
                          ★ DIVE FILTERED · {Math.min(needsDive.length, cap)}
                          {needsDive.length > cap
                            ? ` / ${needsDive.length}`
                            : ""}
                          {" →"}
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>
              {diveBatch.running && (
                <div className="flex items-center gap-3 mono text-ink/60 pt-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-red pulse-dot" />
                  <span>
                    DIVING · {diveBatch.done.length}/{diveBatch.total}
                    {diveBatch.failed.length > 0 &&
                      ` · ${diveBatch.failed.length} FAILED`}
                  </span>
                  {diveBatch.current.length > 0 && (
                    <span className="text-ink/40 truncate">
                      → {diveBatch.current.join(", ")}
                    </span>
                  )}
                  <button
                    onClick={cancelBatchDeepDive}
                    className="ml-auto px-2 h-6 border border-ink/30 hover:bg-red hover:text-cream hover:border-red transition-colors"
                  >
                    CANCEL
                  </button>
                </div>
              )}
              {!diveBatch.running &&
                (diveBatch.done.length > 0 || diveBatch.failed.length > 0) && (
                  <div className="mono text-ink/50 pt-1">
                    <span className="text-lime">●</span> LAST BATCH ·{" "}
                    {diveBatch.done.length} dived
                    {diveBatch.failed.length > 0 &&
                      `, ${diveBatch.failed.length} failed`}
                  </div>
                )}
            </div>
          )}

          <div>
            {filteredReports.map((r, i) => (
              <ArtistRow
                key={r.name}
                report={r}
                index={i}
                onPatch={(patch) => {
                  setReports((prev) =>
                    prev.map((p) =>
                      p.name === r.name ? { ...p, ...patch } : p,
                    ),
                  );
                }}
              />
            ))}

            {state === "scouting" &&
              total - reports.length - errors.length > 0 &&
              Array.from({
                length: total - reports.length - errors.length,
              }).map((_, i) => (
                <div
                  key={`pending-${i}`}
                  className="border-b border-ink/10 px-5 py-4 flex items-center gap-4 relative overflow-hidden"
                >
                  <div className="absolute inset-0 shimmer pointer-events-none" />
                  <span className="w-2.5 h-2.5 rounded-full bg-ink/15" />
                  <span className="mono text-ink/30">
                    {String(reports.length + i + 1).padStart(3, "0")}
                  </span>
                  <span className="mono text-ink/40">
                    {i === 0 ? "PROCESSING…" : "QUEUED"}
                  </span>
                  <div className="h-6 w-1/2 bg-ink/5" />
                </div>
              ))}

            {errors.map((e, i) => (
              <div
                key={`err-${i}`}
                className="border-b border-ink/10 px-5 py-4 bg-red/5 flex items-start gap-4"
              >
                <span className="w-2.5 h-2.5 rounded-full bg-red mt-2" />
                <div>
                  <div className="mono text-red mb-1">
                    FAILED · {e.artist.toUpperCase()}
                  </div>
                  <div className="serif-italic text-sm text-ink/70">
                    {e.message}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function LayerToggle({
  label,
  description,
  enabled,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  enabled: boolean;
  disabled?: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange?.(!enabled)}
      disabled={disabled}
      className={`w-full flex items-center gap-3 text-left ${
        disabled ? "cursor-default" : "cursor-pointer hover:bg-ink/[0.02]"
      } px-2 py-1.5 -mx-2 transition-colors`}
    >
      <span
        className={`w-8 h-4 rounded-full relative transition-colors ${
          enabled ? "bg-ink" : "bg-ink/15"
        }`}
      >
        <span
          className={`absolute top-0.5 w-3 h-3 rounded-full bg-cream transition-transform ${
            enabled ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </span>
      <span className="mono">{label}</span>
      <span className="serif-italic text-ink/55 text-sm ml-2">
        {description}
      </span>
    </button>
  );
}
