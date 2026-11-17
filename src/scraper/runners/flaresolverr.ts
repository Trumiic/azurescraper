/**
 * FlareSolverr runner: pages are loaded by a real Chrome inside the user's
 * FlareSolverr container, so JavaScript-rendered content (and bot checks) work.
 *
 * Uses a persistent FlareSolverr session per extension: one browser with its
 * cookies kept across visits, which looks like one shopper rather than a new
 * device on every page.
 */
import { registerProvider, resolveValues } from "../../core/connections.js";
import type { FetchedPage, Runner } from "../types.js";

registerProvider({
  id: "flaresolverr",
  name: "FlareSolverr",
  category: "Scraping",
  description: "Real-browser page loading for the web scrapers (your FlareSolverr container).",
  docsUrl: "https://github.com/FlareSolverr/FlareSolverr",
  fields: [
    { key: "url", label: "FlareSolverr URL", type: "text", required: true, placeholder: "http://192.168.1.76:8191/v1",
      env: "FLARESOLVERR_URL", help: "The /v1 endpoint of your FlareSolverr container." },
    { key: "timeoutMs", label: "Page timeout (ms)", type: "text", placeholder: "60000" },
  ],
  async test(values) {
    const r = await call(values.url, { cmd: "sessions.list" }, 15_000);
    return `FlareSolverr reachable (${(r.sessions as string[] | undefined)?.length ?? 0} open sessions)`;
  },
});

interface FsResponse {
  status: "ok" | "error";
  message?: string;
  sessions?: string[];
  solution?: { url: string; status: number; response: string };
}

export class RunnerUnavailableError extends Error {}

async function call(url: string, body: Record<string, unknown>, timeoutMs: number): Promise<FsResponse> {
  if (!url) throw new RunnerUnavailableError("FlareSolverr is not set up (Settings → Connections)");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs + 15_000),
    });
  } catch (e) {
    throw new RunnerUnavailableError(`Can't reach FlareSolverr at ${url}: ${(e as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as FsResponse;
  if (json.status !== "ok") {
    const err = new Error(json.message || `FlareSolverr error (HTTP ${res.status})`);
    (err as Error & { fsMessage?: string }).fsMessage = json.message ?? "";
    throw err;
  }
  return json;
}

const settings = () => {
  const v = resolveValues("flaresolverr");
  return { url: v.url, timeoutMs: Number(v.timeoutMs) || 60_000 };
};

const openSessions = new Set<string>();

async function ensureSession(session: string) {
  if (openSessions.has(session)) return;
  const { url } = settings();
  try {
    await call(url, { cmd: "sessions.create", session }, 30_000);
  } catch (e) {
    // "already exists" is fine (e.g. after an AzureScraper restart)
    if (!/exist/i.test((e as Error).message)) throw e;
  }
  openSessions.add(session);
}

export const flaresolverrRunner: Runner = {
  id: "flaresolverr",
  name: "FlareSolverr (real browser)",
  ready: () => Boolean(settings().url),

  async fetch(target, opts) {
    const { url, timeoutMs } = settings();
    const started = Date.now();
    const body: Record<string, unknown> = { cmd: "request.get", url: target, maxTimeout: opts.timeoutMs ?? timeoutMs };
    if (opts.session) {
      await ensureSession(opts.session);
      body.session = opts.session;
    }
    let r: FsResponse;
    try {
      r = await call(url, body, timeoutMs);
    } catch (e) {
      // FlareSolverr restarted and forgot the session: recreate once and retry.
      if (opts.session && /session.*(not|doesn)/i.test((e as Error).message)) {
        openSessions.delete(opts.session);
        await ensureSession(opts.session);
        r = await call(url, body, timeoutMs);
      } else {
        throw e;
      }
    }
    const s = r.solution!;
    return { url: target, finalUrl: s.url, status: s.status, html: s.response ?? "", runner: "flaresolverr", ms: Date.now() - started };
  },

  async closeSession(session) {
    if (!openSessions.has(session)) return;
    openSessions.delete(session);
    await call(settings().url, { cmd: "sessions.destroy", session }, 15_000).catch(() => {});
  },
};
