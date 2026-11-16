/**
 * Rate limiting for free APIs (USDA, Open Food Facts).
 *
 * Two rules per API, both enforced by waiting (never by failing):
 *  - a cap per window (e.g. 950 per hour)
 *  - a minimum gap between calls, so requests are spread out evenly instead of
 *    bursting (servers often enforce "100/min" as roughly one call every 0.6 s).
 *
 * If an API still answers 429, callers throw RateLimitError; slowDown() then
 * widens the gap for the rest of the run.
 */
export class RateLimitError extends Error {
  constructor(message: string, public retryAfterMs: number) {
    super(message);
  }
}

interface Limit { max: number; windowMs: number; gapMs: number; maxGapMs: number }

const limits = new Map<string, Limit>();
const calls = new Map<string, number[]>();
const lastCall = new Map<string, number>();

export function defineLimit(name: string, l: { max: number; windowMs: number; gapMs: number; maxGapMs?: number }) {
  if (!limits.has(name)) limits.set(name, { maxGapMs: l.gapMs * 8, ...l });
}

/** After a 429: double the gap between calls (up to maxGapMs). */
export function slowDown(name: string) {
  const l = limits.get(name);
  if (l) l.gapMs = Math.min(l.gapMs * 2, l.maxGapMs);
  return l?.gapMs ?? 0;
}

export function sleep(ms: number, cancelled?: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const tick = () => {
      if (cancelled?.()) return reject(new Error("Cancelled"));
      const left = end - Date.now();
      if (left <= 0) return resolve();
      setTimeout(tick, Math.min(left, 1000));
    };
    tick();
  });
}

/** Wait until a call to `name` is allowed, then record it. */
export async function rateLimit(name: string, cancelled?: () => boolean) {
  const l = limits.get(name);
  if (!l) return;
  for (;;) {
    if (cancelled?.()) throw new Error("Cancelled");
    const now = Date.now();
    const recent = (calls.get(name) ?? []).filter((t) => now - t < l.windowMs);
    const gapWait = (lastCall.get(name) ?? 0) + l.gapMs - now;
    const windowWait = recent.length >= l.max ? l.windowMs - (now - recent[0]) + 50 : 0;
    const wait = Math.max(gapWait, windowWait);
    if (wait <= 0) {
      recent.push(now);
      calls.set(name, recent);
      lastCall.set(name, now);
      return;
    }
    await sleep(Math.min(wait, 5000), cancelled);
  }
}

/** Parse a Retry-After header (seconds or HTTP date) into ms, with a default. */
export function retryAfterMs(header: string | null, fallbackMs: number): number {
  if (!header) return fallbackMs;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(1000, secs * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(1000, at - Date.now()) : fallbackMs;
}
