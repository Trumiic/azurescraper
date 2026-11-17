/**
 * Plain HTTP runner: fast and light, for sites without bot protection or
 * JavaScript-rendered content. (Kroger needs FlareSolverr instead.)
 */
import type { Runner } from "../types.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export const httpRunner: Runner = {
  id: "http",
  name: "Plain HTTP",
  ready: () => true,
  async fetch(url, opts) {
    const started = Date.now();
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    return { url, finalUrl: res.url, status: res.status, html: await res.text(), runner: "http", ms: Date.now() - started };
  },
};
