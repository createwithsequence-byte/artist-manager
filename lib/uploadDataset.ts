import type { CityAggregate, Customer } from "./customerCrossover";

/**
 * Persist a customer dataset (aggregate + raw rows) without tripping Vercel's
 * 4.5MB request-body cap. Large rosters (10-20k+ rows) used to ship the whole
 * raw array in one POST and silently 413 in production. Here the raw rows are
 * byte-chunked under the cap and streamed (replace, then append); the aggregate
 * — the globe's data — is written LAST as a commit marker, so a mid-stream
 * failure can never leave the globe showing new data joined against stale raw.
 *
 * Throws on any failure so the caller surfaces it (no more silent .catch).
 */

// ~2.5MB serialized per request — comfortably under the 4.5MB platform limit
// even with the JSON envelope.
const CHUNK_BYTES = 2_500_000;

async function postCustomers(body: unknown): Promise<{ rowCount?: number }> {
  const r = await fetch("/api/customers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let d: { error?: string; rowCount?: number } = {};
  try {
    d = await r.json();
  } catch {
    // Non-JSON (e.g. a raw 413 HTML page) — treat as failure.
  }
  if (!r.ok || d.error) {
    throw new Error(d.error || `Upload failed (HTTP ${r.status})`);
  }
  return d;
}

export async function uploadCustomerDataset(args: {
  id: string;
  name: string;
  aggregate: CityAggregate[];
  customerCount: number;
  customers: Customer[];
}): Promise<void> {
  const { id, name, aggregate, customerCount, customers } = args;

  // Byte-chunk the raw rows by their serialized size (accurate, vs row count).
  const chunks: Customer[][] = [];
  let cur: Customer[] = [];
  let bytes = 0;
  for (const c of customers) {
    const sz = JSON.stringify(c).length + 2;
    if (bytes + sz > CHUNK_BYTES && cur.length) {
      chunks.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(c);
    bytes += sz;
  }
  if (cur.length) chunks.push(cur);

  if (chunks.length <= 1) {
    // Small dataset: one shot, aggregate + raw together (atomic enough).
    await postCustomers({ id, name, aggregate, customerCount, raw: customers });
    return;
  }

  // Large dataset: stream raw under the cap, then commit the aggregate last.
  for (let i = 0; i < chunks.length; i++) {
    await postCustomers({
      id,
      rawChunk: chunks[i],
      rawMode: i === 0 ? "replace" : "append",
    });
  }
  // Commit marker — aggregate written only after every raw chunk landed.
  await postCustomers({ id, name, aggregate, customerCount });
}
