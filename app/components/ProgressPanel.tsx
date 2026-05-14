"use client";

type Props = {
  scoutedCount: number;
  failedCount: number;
  queuedCount: number;
  totalArtists: number;
  sampleSize: number;
  setSampleSize: (n: number) => void;
  sliderMax: number;
  isScouting: boolean;
  withSocials: boolean;
  setWithSocials: (v: boolean) => void;
  inProgressLabel?: string;
  inProgressCount: number;
  onRun: () => void;
  onStop: () => void;
  estSecondsPerArtist: number;
};

export function ProgressPanel({
  scoutedCount,
  failedCount,
  queuedCount,
  totalArtists,
  sampleSize,
  setSampleSize,
  sliderMax,
  isScouting,
  withSocials,
  setWithSocials,
  inProgressLabel,
  inProgressCount,
  onRun,
  onStop,
  estSecondsPerArtist,
}: Props) {
  const nextBatch = Math.min(queuedCount + failedCount, sampleSize);
  const etaSec = Math.ceil((nextBatch * estSecondsPerArtist) / 2);
  const etaText =
    etaSec >= 60 ? `~${Math.ceil(etaSec / 60)} min` : `~${etaSec}s`;

  return (
    <section className="border-b border-ink/10">
      <div className="px-5 pt-6 pb-5">
        <div className="flex items-baseline justify-between mb-4">
          <div className="mono text-ink/50">ROSTER PROGRESS</div>
          <div className="mono text-ink/40">
            {scoutedCount.toLocaleString()} / {totalArtists.toLocaleString()}{" "}
            COMPLETE
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 border border-ink/15 divide-x divide-ink/10 md:divide-x md:divide-y-0 divide-y">
          <Cell
            dot="bg-lime"
            label="SCOUTED"
            value={scoutedCount.toLocaleString()}
            hint="Reports saved · persists across refresh"
          />
          <Cell
            dot={isScouting ? "bg-red pulse-dot" : "bg-ink/20"}
            label={isScouting ? "IN PROGRESS" : "IDLE"}
            value={
              isScouting
                ? inProgressCount > 0
                  ? `${inProgressCount}`
                  : "—"
                : "0"
            }
            hint={
              isScouting
                ? (inProgressLabel ?? "warming up")
                : "Click RUN to start"
            }
          />
          <Cell
            dot={failedCount > 0 ? "bg-red" : "bg-ink/20"}
            label="FAILED"
            value={failedCount.toLocaleString()}
            hint={
              failedCount > 0 ? "Auto-retry on next run" : "No failures yet"
            }
          />
          <Cell
            dot="bg-blue"
            label="QUEUED"
            value={queuedCount.toLocaleString()}
            hint={`Not yet scouted · ${queuedCount === 0 ? "all done" : "next run picks from here"}`}
          />
        </div>
      </div>

      {!isScouting && queuedCount + failedCount > 0 && (
        <div className="px-5 pb-5 pt-1 flex flex-wrap items-end gap-x-8 gap-y-4">
          <div>
            <div className="mono text-ink/50 mb-2">NEXT BATCH SIZE</div>
            <div className="flex items-center gap-4">
              <input
                type="range"
                min={1}
                max={Math.min(sliderMax, queuedCount + failedCount)}
                value={Math.min(sampleSize, queuedCount + failedCount)}
                onChange={(e) => setSampleSize(parseInt(e.target.value, 10))}
                className="w-56 accent-red"
              />
              <span className="display text-3xl">{nextBatch}</span>
              <span className="mono text-ink/40">
                OF {(queuedCount + failedCount).toLocaleString()}
              </span>
            </div>
            <div className="serif-italic text-ink/55 text-sm mt-1">
              ETA {etaText} · 2 in parallel · ~{estSecondsPerArtist}s per artist
            </div>
          </div>

          <label className="mono flex items-center gap-2 cursor-pointer select-none">
            <span
              className={`w-8 h-4 rounded-full relative transition-colors ${
                withSocials ? "bg-ink" : "bg-ink/15"
              }`}
            >
              <span
                className={`absolute top-0.5 w-3 h-3 rounded-full bg-cream transition-transform ${
                  withSocials ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </span>
            <input
              type="checkbox"
              className="sr-only"
              checked={withSocials}
              onChange={(e) => setWithSocials(e.target.checked)}
            />
            INCLUDE SOCIALS (TIKTOK)
          </label>

          <button
            onClick={onRun}
            disabled={nextBatch === 0}
            className="bg-ink text-cream display text-2xl px-6 py-3 hover:bg-red transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Run Next {nextBatch} →
          </button>
        </div>
      )}

      {isScouting && (
        <div className="px-5 pb-5 flex flex-wrap items-center gap-4 border-t border-ink/10 pt-4">
          <div className="mono flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-red pulse-dot" />
            {inProgressLabel ?? "WORKING…"}
          </div>
          <button
            onClick={onStop}
            className="mono ml-auto px-3 h-8 border border-ink/30 hover:bg-red hover:text-cream hover:border-red transition-colors"
          >
            PAUSE
          </button>
        </div>
      )}

      {!isScouting && queuedCount + failedCount === 0 && scoutedCount > 0 && (
        <div className="px-5 pb-5 pt-1 flex items-center gap-3">
          <span className="inline-block w-2 h-2 rounded-full bg-lime" />
          <span className="mono">
            ROSTER COMPLETE — {scoutedCount.toLocaleString()} ARTISTS SCOUTED
          </span>
        </div>
      )}
    </section>
  );
}

function Cell({
  dot,
  label,
  value,
  hint,
}: {
  dot: string;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="p-4 md:p-5">
      <div className="flex items-center gap-2 mb-2">
        <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
        <span className="mono">{label}</span>
      </div>
      <div className="display text-4xl md:text-5xl mb-1">{value}</div>
      {hint && <div className="serif-italic text-ink/55 text-xs">{hint}</div>}
    </div>
  );
}
