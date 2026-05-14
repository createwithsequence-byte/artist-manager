"use client";

type Props = {
  state: "idle" | "scouting" | "done";
  current?: string;
  completed: number;
  total: number;
};

export function StatusTicker({ state, current, completed, total }: Props) {
  const label =
    state === "idle"
      ? "READY"
      : state === "done"
        ? `COMPLETE — ${completed}/${total}`
        : `SCOUTING — ${completed}/${total} — ${current ?? ""}`;

  return (
    <div className="w-full border-b border-ink/20 bg-cream sticky top-0 z-50">
      <div className="flex items-center justify-between px-6 py-3">
        <div className="mono flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              state === "scouting"
                ? "bg-red pulse-dot"
                : state === "done"
                  ? "bg-lime"
                  : "bg-ink/40"
            }`}
          />
          <span>01 ● ARTIST SCOUT</span>
        </div>
        <div className="mono">{label}</div>
      </div>
    </div>
  );
}
