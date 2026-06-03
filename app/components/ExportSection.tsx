"use client";

import { useState } from "react";
import type { ArtistReport } from "@/lib/types";

type Callout = { name: string; body: string };
type BriefingPreview = {
  headline: string;
  summary: string;
  stats: {
    total: number;
    activeTouring: number;
    recentRelease: number;
    industryWriter: number;
    betweenCycles: number;
    quiet: number;
    newArtist: number;
  };
  touringCallouts: Callout[];
  releaseCallouts: Callout[];
  closer?: string;
};

type Props = {
  reports: ArtistReport[];
  totalArtists: number;
};

type State =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "preview-ready"; briefing: BriefingPreview }
  | { kind: "posting"; briefing: BriefingPreview }
  | { kind: "posted"; briefing: BriefingPreview; at: string }
  | { kind: "error"; message: string };

export function ExportSection({ reports, totalArtists }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [diveSlackState, setDiveSlackState] = useState<
    | { kind: "idle" }
    | { kind: "posting" }
    | { kind: "posted"; at: string; count: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const reportsWithDive = reports.filter(
    (r) => r.deepDive && (r.deepDive.facts?.length ?? 0) > 0,
  );

  const postDiveBriefing = async () => {
    if (reportsWithDive.length === 0) return;
    setDiveSlackState({ kind: "posting" });
    try {
      const res = await fetch("/api/export/slack-dives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reports: reportsWithDive, previewOnly: false }),
      });
      const json = await res.json();
      if (!res.ok || !json.posted) {
        throw new Error(json.error ?? "Post failed");
      }
      setDiveSlackState({
        kind: "posted",
        at: new Date().toLocaleTimeString(),
        count: reportsWithDive.length,
      });
    } catch (err) {
      setDiveSlackState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const preview = async () => {
    setState({ kind: "previewing" });
    try {
      const res = await fetch("/api/export/slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reports, totalArtists, previewOnly: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setState({ kind: "preview-ready", briefing: json.briefing });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const post = async () => {
    if (state.kind !== "preview-ready") return;
    const briefing = state.briefing;
    setState({ kind: "posting", briefing });
    try {
      const res = await fetch("/api/export/slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reports, totalArtists, previewOnly: false }),
      });
      const json = await res.json();
      if (!res.ok || !json.posted) {
        throw new Error(json.error ?? "Post failed");
      }
      setState({
        kind: "posted",
        briefing: json.briefing ?? briefing,
        at: new Date().toLocaleTimeString(),
      });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (reports.length === 0) return null;

  return (
    <section className="border-b border-ink/10 px-5 py-6">
      <div className="flex items-baseline justify-between mb-3">
        <div className="mono text-ink/50">EXPORT</div>
        <div className="mono text-ink/40">
          BRIEFING FROM {reports.length} REPORTS
        </div>
      </div>

      {state.kind === "idle" && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={preview}
            className="mono px-3 h-9 border border-ink/30 hover:bg-ink hover:text-cream transition-colors"
          >
            PREVIEW ROSTER BRIEFING
          </button>
          {reportsWithDive.length > 0 && diveSlackState.kind === "idle" && (
            <button
              onClick={postDiveBriefing}
              className="mono px-3 h-9 border border-red text-red hover:bg-red hover:text-cream transition-colors"
              title="Send interview-prep digest to Slack from existing deep dives"
            >
              ★ POST DIVE PREP TO SLACK · {reportsWithDive.length}
            </button>
          )}
          {diveSlackState.kind === "posting" && (
            <span className="mono text-ink/60 flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-red pulse-dot" />
              POSTING DIVE PREP…
            </span>
          )}
          {diveSlackState.kind === "posted" && (
            <span className="mono text-lime-ink">
              ✓ DIVE PREP POSTED · {diveSlackState.count} ARTISTS ·{" "}
              {diveSlackState.at}
            </span>
          )}
          {diveSlackState.kind === "error" && (
            <span className="mono text-red">
              FAILED · {diveSlackState.message}
            </span>
          )}
          <span className="serif-italic text-ink/55 text-sm w-full mt-1">
            Roster briefing = editorial digest of all reports. Dive prep =
            Nardwuar-style interview questions from completed deep dives.
          </span>
        </div>
      )}

      {state.kind === "previewing" && (
        <div className="mono flex items-center gap-2 text-ink/60">
          <span className="inline-block w-2 h-2 rounded-full bg-red pulse-dot" />
          GENERATING BRIEFING…
        </div>
      )}

      {state.kind === "preview-ready" && (
        <PreviewCard
          briefing={state.briefing}
          totalArtists={totalArtists}
          scoutedCount={reports.length}
          onPost={post}
          onCancel={() => setState({ kind: "idle" })}
          posting={false}
        />
      )}

      {state.kind === "posting" && (
        <PreviewCard
          briefing={state.briefing}
          totalArtists={totalArtists}
          scoutedCount={reports.length}
          onPost={() => {}}
          onCancel={() => {}}
          posting
        />
      )}

      {state.kind === "posted" && (
        <div className="border border-lime/60 bg-lime/10 p-4">
          <div className="mono mb-2 flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-lime" />
            POSTED TO SLACK · {state.at}
          </div>
          <BriefingPreviewBody briefing={state.briefing} />
          <div className="mt-4">
            <button
              onClick={() => setState({ kind: "idle" })}
              className="mono underline text-ink/60 hover:text-ink"
            >
              POST AGAIN →
            </button>
          </div>
        </div>
      )}

      {state.kind === "error" && (
        <div className="border border-red/40 bg-red/5 p-4">
          <div className="mono text-red mb-2">EXPORT FAILED</div>
          <div className="serif-italic text-sm text-ink/80">
            {state.message}
          </div>
          <button
            onClick={() => setState({ kind: "idle" })}
            className="mono mt-3 underline text-ink/60 hover:text-ink"
          >
            DISMISS
          </button>
        </div>
      )}
    </section>
  );
}

function PreviewCard({
  briefing,
  totalArtists,
  scoutedCount,
  onPost,
  onCancel,
  posting,
}: {
  briefing: BriefingPreview;
  totalArtists: number;
  scoutedCount: number;
  onPost: () => void;
  onCancel: () => void;
  posting: boolean;
}) {
  return (
    <div className="border border-ink/15 p-5">
      <div className="mono text-ink/50 mb-3">
        PREVIEW · {scoutedCount}/{totalArtists} SCOUTED
      </div>
      <BriefingPreviewBody briefing={briefing} />
      <div className="mt-5 flex flex-wrap gap-3">
        <button
          onClick={onPost}
          disabled={posting}
          className="mono px-3 h-9 bg-ink text-cream hover:bg-red transition-colors disabled:opacity-40"
        >
          {posting ? "POSTING…" : "POST TO SLACK →"}
        </button>
        <button
          onClick={onCancel}
          disabled={posting}
          className="mono px-3 h-9 border border-ink/30 hover:bg-ink/5 disabled:opacity-40"
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}

function BriefingPreviewBody({ briefing }: { briefing: BriefingPreview }) {
  const s = briefing.stats;
  const chips: { label: string; n: number; color: string }[] = [
    { label: "TOURING", n: s.activeTouring, color: "border-red/60 text-red" },
    {
      label: "RELEASES",
      n: s.recentRelease,
      color: "border-blue/60 text-blue",
    },
    {
      label: "WRITERS",
      n: s.industryWriter,
      color: "border-lime/70 text-ink bg-lime/10",
    },
    {
      label: "BETWEEN",
      n: s.betweenCycles,
      color: "border-ink/30 text-ink/70",
    },
    { label: "QUIET", n: s.quiet, color: "border-ink/30 text-ink/60" },
  ].filter((c) => c.n > 0);

  return (
    <div>
      <div className="display text-2xl md:text-3xl mb-2">
        {briefing.headline}
      </div>
      <div className="serif-italic text-ink/75 mb-3">{briefing.summary}</div>
      <div className="flex flex-wrap gap-2 mb-5">
        {chips.map((c) => (
          <span key={c.label} className={`mono border px-2 py-0.5 ${c.color}`}>
            {c.label} · {c.n}
          </span>
        ))}
      </div>
      {briefing.touringCallouts.length > 0 && (
        <div className="mb-5">
          <div className="mono mb-3 pb-2 border-b border-ink/15">
            🎤 ACTIVE TOURING — {briefing.touringCallouts.length}
          </div>
          <div className="space-y-3">
            {briefing.touringCallouts.map((c, i) => (
              <div key={i}>
                <div className="font-medium">{c.name}</div>
                <div className="serif-italic text-ink/75 text-sm">{c.body}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {briefing.releaseCallouts.length > 0 && (
        <div className="mb-5">
          <div className="mono mb-3 pb-2 border-b border-ink/15">
            🎵 RECENT RELEASES — {briefing.releaseCallouts.length}
          </div>
          <div className="space-y-3">
            {briefing.releaseCallouts.map((c, i) => (
              <div key={i}>
                <div className="font-medium">{c.name}</div>
                <div className="serif-italic text-ink/75 text-sm">{c.body}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {briefing.closer && (
        <div className="serif-italic text-ink/60 text-sm mt-4 pt-3 border-t border-ink/10">
          {briefing.closer}
        </div>
      )}
    </div>
  );
}
