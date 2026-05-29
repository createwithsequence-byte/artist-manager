"use client";

import { useRef, useState } from "react";
import type { ChatMessage, ProposedStop } from "@/lib/tourChat";

const STARTERS = [
  "Driving only — keep legs under 450mi.",
  "Avoid August, he's in the studio.",
  "Focus the Southeast.",
  "Fill the biggest gap to maximize fans.",
];

export function TourChat({
  context,
  onApplyStops,
}: {
  context: string;
  onApplyStops: (stops: ProposedStop[]) => { placed: number; dropped: number };
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Proposed stops keyed to the assistant message index that produced them.
  const [proposals, setProposals] = useState<Record<number, ProposedStop[]>>(
    {},
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const send = async (text: string) => {
    const userMessage = text.trim();
    if (!userMessage || loading) return;
    setError(null);
    setInput("");
    const nextMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: userMessage },
    ];
    setMessages(nextMessages);
    setLoading(true);
    try {
      const res = await fetch("/api/tour-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context, messages, userMessage }),
        signal: AbortSignal.timeout(65000),
      });
      // Read text first — a non-JSON 5xx (gateway/timeout HTML) would make
      // res.json() throw and mask the real failure as a parser error.
      const rawText = await res.text();
      let data: {
        reply?: string;
        proposedStops?: ProposedStop[];
        error?: string;
      };
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(
          `Agent unavailable (HTTP ${res.status}). Try again in a moment.`,
        );
      }
      if (!res.ok)
        throw new Error(data.error || `Agent error (HTTP ${res.status}).`);
      const assistantIdx = nextMessages.length; // index of the assistant msg
      setMessages([
        ...nextMessages,
        { role: "assistant", content: data.reply ?? "(no reply)" },
      ]);
      if (Array.isArray(data.proposedStops) && data.proposedStops.length > 0) {
        setProposals((p) => ({ ...p, [assistantIdx]: data.proposedStops! }));
      }
    } catch (err) {
      const msg =
        err instanceof Error && err.name === "TimeoutError"
          ? "The agent timed out — try again, or simplify the ask."
          : err instanceof Error
            ? err.message
            : String(err);
      setError(msg);
    } finally {
      setLoading(false);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    }
  };

  return (
    <div className="mt-5 border-t border-ink/15 pt-3">
      <button
        onClick={() => setOpen(!open)}
        className="mono text-ink/55 hover:text-ink flex items-center gap-2"
      >
        {open ? "▾" : "▸"} ✦ TOUR AGENT
        <span className="text-ink/35">
          (give context — drive/fly, blackout dates, region — it revises the
          run)
        </span>
      </button>

      {open && (
        <div className="mt-3 border border-ink/15">
          {/* transcript */}
          <div
            ref={scrollRef}
            className="max-h-72 overflow-y-auto px-3 py-3 space-y-3"
          >
            {messages.length === 0 && (
              <div className="serif-italic text-ink/55 text-sm">
                Tell the agent how this tour really works — &quot;he&apos;s
                driving, no flights,&quot; &quot;skip August,&quot; &quot;keep
                it east of the Mississippi&quot; — and it&apos;ll propose where
                to slot shows between the booked dates, then apply them.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i}>
                <div
                  className={`mono text-[0.65rem] mb-0.5 ${
                    m.role === "user" ? "text-ink/45" : "text-blue"
                  }`}
                >
                  {m.role === "user" ? "YOU" : "✦ AGENT"}
                </div>
                <div className="text-sm whitespace-pre-wrap leading-snug">
                  {m.content}
                </div>
                {proposals[i] && (
                  <ProposalBlock
                    stops={proposals[i]}
                    onApply={() => onApplyStops(proposals[i])}
                  />
                )}
              </div>
            ))}
            {loading && (
              <div className="mono text-ink/45 text-xs flex items-center gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue pulse-dot" />
                AGENT THINKING…
              </div>
            )}
            {error && <div className="mono text-red text-xs">{error}</div>}
          </div>

          {/* starters (only before first message) */}
          {messages.length === 0 && (
            <div className="px-3 pb-2 flex flex-wrap gap-1.5">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="mono text-[0.65rem] border border-ink/25 hover:border-ink/60 px-2 py-1 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex border-t border-ink/15"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. driving only, skip the first week of July, push west…"
              className="flex-1 bg-transparent px-3 h-11 focus:outline-none placeholder:text-ink/35 text-sm"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="mono px-4 bg-ink text-cream hover:bg-blue transition-colors disabled:opacity-30"
            >
              SEND →
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function ProposalBlock({
  stops,
  onApply,
}: {
  stops: ProposedStop[];
  onApply: () => { placed: number; dropped: number };
}) {
  const [applied, setApplied] = useState<{
    placed: number;
    dropped: number;
  } | null>(null);
  return (
    <div className="mt-2 border-l-2 border-blue/40 pl-3 space-y-1">
      <div className="mono text-blue text-[0.65rem]">
        PROPOSED · {stops.length} STOP{stops.length === 1 ? "" : "S"}
      </div>
      {stops.map((s, i) => (
        <div key={i} className="text-sm">
          <span className="mono text-ink/55">{s.date}</span>{" "}
          <span className="font-medium">
            {s.city}, {s.state}
          </span>
          {s.reason && (
            <span className="serif-italic text-ink/60"> — {s.reason}</span>
          )}
        </div>
      ))}
      <button
        onClick={() => setApplied(onApply())}
        disabled={!!applied}
        className="mono text-xs mt-1 px-3 h-8 bg-blue text-cream hover:bg-ink transition-colors disabled:opacity-40"
      >
        {applied
          ? applied.dropped > 0
            ? `✓ APPLIED ${applied.placed} OF ${stops.length} — ${applied.dropped} NOT FOUND`
            : `✓ APPLIED ${applied.placed} TO TOUR`
          : `APPLY ${stops.length} TO TOUR →`}
      </button>
    </div>
  );
}
