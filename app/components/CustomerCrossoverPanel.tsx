"use client";

import { useRef, useState } from "react";
import Papa from "papaparse";
import {
  crossover,
  parseCustomers,
  type Customer,
  type CustomerCrossover,
} from "@/lib/customerCrossover";
import type { Event as ArtistEvent } from "@/lib/types";

type Props = {
  events: ArtistEvent[];
  artistName: string;
};

type Stage =
  | { kind: "idle" }
  | { kind: "parsing"; fileName: string }
  | {
      kind: "ready";
      fileName: string;
      customerCount: number;
      result: CustomerCrossover;
    }
  | { kind: "error"; message: string };

export function CustomerCrossoverPanel({ events, artistName }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const inputId = `crossover-csv-${artistName.replace(/\W+/g, "-")}`;
  const fileInput = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    setStage({ kind: "parsing", fileName: file.name });
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        try {
          const customers: Customer[] = parseCustomers(result.data);
          const analysis = crossover(customers, events);
          setStage({
            kind: "ready",
            fileName: file.name,
            customerCount: customers.length,
            result: analysis,
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

  // No upcoming events → no point in customer crossover
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
          fileName={stage.fileName}
          customerCount={stage.customerCount}
          result={stage.result}
          artistName={artistName}
          onReset={() => setStage({ kind: "idle" })}
        />
      )}
    </div>
  );
}

function CrossoverResult({
  fileName,
  customerCount,
  result,
  artistName,
  onReset,
}: {
  fileName: string;
  customerCount: number;
  result: CustomerCrossover;
  artistName: string;
  onReset: () => void;
}) {
  // Sort tour stops by impact (most customers nearby first)
  const sortedEvents = [...result.perEvent].sort(
    (a, b) => b.sameStateCount - a.sameStateCount,
  );
  const totalNearbyAcrossTour = result.perEvent.reduce(
    (sum, e) => sum + e.sameStateCount,
    0,
  );

  return (
    <div>
      <div className="mono text-ink/55 mb-3 flex flex-wrap gap-x-4 gap-y-1">
        <span>
          ✓ {customerCount.toLocaleString()} CUSTOMERS · {result.uniqueStates}{" "}
          STATES
        </span>
        <span className="text-ink/40">{fileName}</span>
        <button
          onClick={onReset}
          className="mono text-ink/50 underline ml-auto hover:text-red"
        >
          REPLACE
        </button>
      </div>

      <div className="grid md:grid-cols-2 gap-x-10 gap-y-6">
        <div>
          <div className="mono mb-3 pb-2 border-b border-ink/15">
            01 — TOUR STOPS · CUSTOMER OVERLAP
          </div>
          {sortedEvents.length === 0 ? (
            <div className="serif-italic text-ink/55">No events.</div>
          ) : (
            <div className="space-y-3">
              {sortedEvents.map((e, i) => (
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
                      <div className="display text-2xl">{e.sameStateCount}</div>
                      <div className="mono text-ink/40">
                        IN {e.stateCode ?? "?"}
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
              ))}
              <div className="pt-3 border-t border-ink/10 mono text-ink/60">
                TOTAL {artistName.toUpperCase()} CUSTOMERS ACROSS TOUR STATES:{" "}
                <span className="text-ink display text-xl ml-2">
                  {totalNearbyAcrossTour.toLocaleString()}
                </span>
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="mono mb-3 pb-2 border-b border-ink/15">
            02 — TOP CUSTOMER STATES
          </div>
          <div className="space-y-1.5">
            {result.topStates.map((s, i) => (
              <div key={s.stateCode} className="flex items-baseline gap-3">
                <span className="mono text-ink/40 w-5">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="font-medium w-32">{s.stateName}</span>
                <span className="text-ink/50 mono">{s.stateCode}</span>
                <span className="display text-lg ml-auto">{s.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 serif-italic text-ink/45 text-xs">
        State-level match only. Geographic radius (e.g. &quot;within 90 miles of
        Cohasset&quot;) is a future enhancement — needs geocoding.
      </div>
    </div>
  );
}
