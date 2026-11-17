/**
 * The engine: one call = one paced, checked page visit for an extension.
 *
 *   acquire pacing slot -> runner.fetch -> detect block -> extension.extract
 *   -> validate -> snapshot
 *
 * Any sign of an interruption (block/challenge page, 403/429, an unexpected
 * page, a browser-challenge failure) trips the extension's cooldown and throws
 * InterruptionError, so jobs stop immediately.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { acquire, tripCooldown } from "./pacer.js";
import { detectBlock } from "./extract.js";
import { flaresolverrRunner, RunnerUnavailableError } from "./runners/flaresolverr.js";
import { httpRunner } from "./runners/http.js";
import { InterruptionError, type ExtractResult, type FetchedPage, type Runner, type ScraperExtension } from "./types.js";

export const runners: Record<string, Runner> = {
  [flaresolverrRunner.id]: flaresolverrRunner,
  [httpRunner.id]: httpRunner,
};

const extensions = new Map<string, ScraperExtension>();
export const registerExtension = (e: ScraperExtension) => extensions.set(e.id, e);
export const getExtension = (id: string) => extensions.get(id);
export const listExtensions = () => [...extensions.values()];

export { RunnerUnavailableError };

/* ---------- raw page snapshots (for debugging selectors) ---------- */

function snapshot(ext: string, kind: "ok" | "interruption", label: string, html: string): string {
  const d = path.join(config.dataDir, "snapshots", ext, kind);
  fs.mkdirSync(d, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}_${label.replace(/[^\w-]/g, "").slice(0, 40)}.html`;
  fs.writeFileSync(path.join(d, name), html);
  // keep the newest 20 normal pages and 10 interruption pages
  const keep = kind === "ok" ? 20 : 10;
  const files = fs.readdirSync(d).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(d, f), { force: true });
  return path.join("snapshots", ext, kind, name);
}

export interface VisitResult {
  page: FetchedPage;
  data: ExtractResult;
  notFound?: boolean;   // the product page doesn't exist (404)
}

/**
 * Visit one URL for an extension. Never call the runner directly: this keeps
 * pacing and the interruption rule in one place.
 */
export async function visit(
  ext: ScraperExtension,
  url: string,
  opts: { label: string; cancelled?: () => boolean; onWait?: (ms: number, why: string) => void },
): Promise<VisitResult> {
  const runner = runners[ext.runner];
  if (!runner?.ready()) throw new RunnerUnavailableError(`${runner?.name ?? ext.runner} is not set up (Settings → Connections)`);

  await acquire(ext.id, ext.pacing, opts.cancelled, opts.onWait);

  let page: FetchedPage;
  try {
    page = await runner.fetch(url, { session: `azurescraper-${ext.id}` });
  } catch (e) {
    if (e instanceof RunnerUnavailableError) throw e;
    // The browser couldn't load the page (challenge not solved, timeout...): treat as an interruption.
    const why = `Page load failed: ${(e as Error).message}`;
    tripCooldown(ext.id, ext.pacing, why);
    throw new InterruptionError(why);
  }

  const blocked = detectBlock(page.status, page.html);
  if (blocked) {
    const snap = snapshot(ext.id, "interruption", opts.label, page.html);
    tripCooldown(ext.id, ext.pacing, blocked);
    throw new InterruptionError(blocked, snap);
  }
  if (page.status === 404 || page.status === 410) {
    return { page, data: { isProductPage: false }, notFound: true };
  }

  const data = ext.extract(page);
  if (!data.isProductPage) {
    // Not a block page we recognise, but not a product page either: back off to be safe.
    const why = `Unexpected page (HTTP ${page.status}, no product data)`;
    const snap = snapshot(ext.id, "interruption", opts.label, page.html);
    tripCooldown(ext.id, ext.pacing, why);
    throw new InterruptionError(why, snap);
  }
  snapshot(ext.id, "ok", opts.label, page.html);
  return { page, data };
}

export async function closeExtensionSession(ext: ScraperExtension) {
  await runners[ext.runner]?.closeSession?.(`azurescraper-${ext.id}`);
}
