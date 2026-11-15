/**
 * Sliding-window rate limiter: waits (instead of failing) until a call is allowed.
 * Used for free APIs with hourly/minute limits (USDA, Open Food Facts).
 */
const windows = new Map<string, number[]>();

export async function rateLimit(name: string, max: number, windowMs: number, signal?: () => boolean) {
  for (;;) {
    const now = Date.now();
    const calls = (windows.get(name) ?? []).filter((t) => now - t < windowMs);
    if (calls.length < max) {
      calls.push(now);
      windows.set(name, calls);
      return;
    }
    if (signal?.()) throw new Error("Cancelled");
    const wait = Math.min(windowMs - (now - calls[0]) + 50, 5000);
    await new Promise((r) => setTimeout(r, wait));
  }
}
