"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary.
 *
 * Primary job: auto-recover from STALE-CHUNK errors. The app lazy-loads the
 * tour map + the 1MB city dataset as deferred chunks (keeps the main bundle
 * lean). After a deploy, chunk hashes change; an already-open tab still holds
 * the old filenames, so the first time it tries to load a deferred chunk
 * (e.g. when a customer CSV is dropped) the request 404s → React throws here.
 * The fix is simply to reload once and pick up the current hashes.
 *
 * A timestamp guard makes the reload safe: if the SAME error recurs within
 * 10s of a reload (i.e. it's a real bug, not a stale chunk), we stop reloading
 * and show the error instead — no infinite loop. A fresh chunk error from a
 * later deploy (>10s) still auto-recovers.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isChunkError =
    /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|Importing a module script failed/i.test(
      `${error?.name ?? ""} ${error?.message ?? ""}`,
    );

  useEffect(() => {
    if (!isChunkError) return;
    try {
      const KEY = "am:chunk-reload-ts";
      const last = Number(sessionStorage.getItem(KEY) || "0");
      if (Date.now() - last < 10_000) return; // just tried — don't loop
      sessionStorage.setItem(KEY, String(Date.now()));
      window.location.reload();
    } catch {
      // sessionStorage blocked (rare) — fall back to a plain reload once.
      window.location.reload();
    }
  }, [isChunkError]);

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-md">
        <div className="display text-4xl mb-3">
          {isChunkError ? "REFRESHING…" : "SOMETHING BROKE"}
        </div>
        <p className="serif-italic text-ink/70 mb-5">
          {isChunkError
            ? "A new version shipped — reloading to pick it up. One sec."
            : error?.message || "An unexpected error occurred."}
        </p>
        {!isChunkError && (
          <div className="flex gap-2">
            <button
              onClick={reset}
              className="mono px-3 h-9 bg-ink text-cream hover:bg-red transition-colors"
            >
              TRY AGAIN
            </button>
            <button
              onClick={() => window.location.reload()}
              className="mono px-3 h-9 border border-ink/30 hover:border-ink/60 transition-colors"
            >
              RELOAD
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
