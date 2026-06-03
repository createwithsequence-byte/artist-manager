/**
 * Outreach ledger types + display helpers. Pure module (no DB import) so the
 * scout/routing UI can use it client-side. Persistence lives in lib/customers.ts.
 */

export type OutreachChannel = "email-stop" | "broadcast";

export type OutreachEntry = {
  id: string;
  artistKey: string;
  channel: OutreachChannel;
  /** Stop identity ("date|city") for a per-stop email, or the announcement
   *  label for a broadcast — so the panel can match it back to a row. */
  target: string;
  recipientCount: number;
  note?: string;
  createdAt: string; // ISO
};

/** Compact relative label ("today" / "3d ago" / "2mo ago"). nowMs is passed in
 *  so the function stays pure. */
export function daysAgoLabel(iso: string, nowMs: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const days = Math.floor((nowMs - t) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const mo = Math.floor(days / 30);
  return mo <= 1 ? "1mo ago" : `${mo}mo ago`;
}

/** Most-recent createdAt per target — what the per-stop / per-announcement
 *  "last reached out" chips read. */
export function lastContactByTarget(
  entries: OutreachEntry[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entries) {
    const prev = m.get(e.target);
    if (!prev || e.createdAt > prev) m.set(e.target, e.createdAt);
  }
  return m;
}
