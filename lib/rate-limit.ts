/**
 * Creates a shared rate limiter for a single API host.
 *
 * Two modes:
 * - Sliding window: at most `maxCalls` in any `windowMs` (good for "X per Y" limits)
 * - Min-interval: guaranteed `minIntervalMs` between successive calls (no bursts)
 *
 * Pattern: chained promise = serial scheduler. Each caller awaits the chain,
 * then either passes immediately or sleeps until a slot opens, then records
 * its own timestamp before releasing the next.
 */
export function createRateLimiter(
  maxCalls: number,
  windowMs: number,
  options: { minIntervalMs?: number } = {},
) {
  let recent: number[] = [];
  let lastCall = 0;
  let chain: Promise<void> = Promise.resolve();

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  return function waitForSlot(): Promise<void> {
    chain = chain.then(async () => {
      // Min-interval check: enforce minimum spacing between successive calls
      if (options.minIntervalMs) {
        const since = Date.now() - lastCall;
        if (since < options.minIntervalMs) {
          await sleep(options.minIntervalMs - since);
        }
      }

      // Sliding window check
      while (true) {
        const now = Date.now();
        recent = recent.filter((t) => now - t < windowMs);
        if (recent.length < maxCalls) {
          recent.push(Date.now());
          lastCall = Date.now();
          return;
        }
        const waitMs = windowMs - (now - recent[0]) + 50;
        await sleep(waitMs);
      }
    });
    return chain;
  };
}
