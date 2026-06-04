"use client";

import Link from "next/link";

type Props = {
  state: "idle" | "scouting" | "done";
  current?: string;
  completed: number;
  total: number;
  fileName?: string;
  artistCount?: number;
  hasCsv: boolean;
  onImport: () => void;
  onRun: () => void;
  onReset: () => void;
  canRun: boolean;
  persistenceMode?: "unknown" | "turso" | "local";
};

export function Toolbar({
  state,
  current,
  completed,
  total,
  fileName,
  artistCount,
  hasCsv,
  onImport,
  onRun,
  onReset,
  canRun,
  persistenceMode,
}: Props) {
  const dotColor =
    state === "scouting"
      ? "bg-red pulse-dot"
      : state === "done"
        ? "bg-lime"
        : hasCsv
          ? "bg-blue"
          : "bg-ink/30";

  const statusText =
    state === "scouting"
      ? current
        ? `RUNNING · ${completed}/${total} · ${current}`
        : `RUNNING · ${completed}/${total}`
      : state === "done"
        ? `COMPLETE · ${completed}/${total}`
        : hasCsv
          ? "READY"
          : "IDLE";

  return (
    <header className="sticky top-0 z-50 bg-cream/95 backdrop-blur border-b border-ink/15">
      <div className="flex items-center gap-6 px-5 h-14">
        <div className="flex items-baseline gap-3">
          <Link
            href="/"
            className="display text-xl tracking-tight hover:text-red transition-colors"
            title="Home — artist roster"
          >
            Artist Manager
          </Link>
          <span className="mono text-ink/40">v0.1</span>
        </div>

        <div className="h-5 w-px bg-ink/15" />

        <div className="flex items-center gap-2 mono min-w-0">
          <span className={`inline-block w-2 h-2 rounded-full ${dotColor}`} />
          <span className="truncate">{statusText}</span>
        </div>

        {fileName && (
          <>
            <div className="h-5 w-px bg-ink/15" />
            <div className="mono text-ink/60 truncate hidden md:block">
              {fileName}
              {artistCount !== undefined && (
                <span className="text-ink/40 ml-2">
                  · {artistCount.toLocaleString()} ARTISTS
                </span>
              )}
            </div>
          </>
        )}

        {persistenceMode && persistenceMode !== "unknown" && (
          <>
            <div className="h-5 w-px bg-ink/15 hidden md:block" />
            <span
              className={`mono px-1.5 py-0.5 border hidden md:inline ${
                persistenceMode === "turso"
                  ? "border-lime/70 text-ink bg-lime/15"
                  : "border-ink/25 text-ink/55"
              }`}
              title={
                persistenceMode === "turso"
                  ? "Reports persist to Turso (multi-device, durable). Local cache also written."
                  : "Reports persist to browser localStorage only. Set TURSO_URL + TURSO_TOKEN in .env.local for durable storage."
              }
            >
              {persistenceMode === "turso" ? "● TURSO" : "● LOCAL"}
            </span>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {state === "done" && (
            <button
              onClick={onReset}
              className="mono px-3 h-8 border border-ink/30 hover:bg-ink hover:text-cream transition-colors"
            >
              CLEAR
            </button>
          )}
          <button
            onClick={onImport}
            disabled={state === "scouting"}
            className="mono px-3 h-8 border border-ink/30 hover:bg-ink hover:text-cream transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {hasCsv ? "REPLACE CSV" : "IMPORT CSV"}
          </button>
          <button
            onClick={onRun}
            disabled={!canRun || state === "scouting"}
            className="mono px-3 h-8 bg-ink text-cream hover:bg-red transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {state === "scouting" ? "RUNNING…" : "RUN ANALYSIS →"}
          </button>
        </div>
      </div>
    </header>
  );
}
