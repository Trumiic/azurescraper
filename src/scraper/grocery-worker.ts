/**
 * Grocery scrape worker: one queue + one background job per site extension.
 *
 * - Manual adds go to the front of the queue; "fill" batches go to the back.
 * - Everything goes through engine.visit(), so the 50/hour pacing, random gaps,
 *   one browser session, and stop-at-first-interruption rules always apply.
 * - Saves nutrition facts + ingredients (+ allergens, name, image) through
 *   saveItems(). Never writes prices: the API owns prices.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { currentTable, dbConfigured, getPool, quoteIdent } from "../core/db.js";
import { ensureTable, markRemoved, saveItems } from "../core/items.js";
import { startJob, runningJob, type JobContext } from "../core/jobs.js";
import type { ProductDetails, ScraperModule } from "../core/types.js";
import { closeExtensionSession, RunnerUnavailableError, visit } from "./engine.js";
import { CooldownError, pacerStatus } from "./pacer.js";
import { InterruptionError, type ExtractResult, type ScraperExtension } from "./types.js";

const RETRY_DAYS = 30; // don't revisit a page that had no label (or wasn't found) for this long

interface QueueItem {
  productId: string;
  url: string;
  name?: string;
  kind: "manual" | "fill";
  dryRun?: boolean;
  addedAt: number;
}

export interface ScrapeResult {
  at: string;
  productId: string;
  name?: string;
  url: string;
  kind: "manual" | "fill";
  result: "saved" | "preview" | "nolabel" | "notfound" | "interrupted" | "error";
  nutrients?: number;
  ingredients?: boolean;
  allergens?: boolean;
  price?: number;
  promoPrice?: number;
  message?: string;
}

const queues = new Map<string, QueueItem[]>();
const queueFile = (id: string) => path.join(config.dataDir, "scraper", `queue-${id}.json`);
const previews = new Map<string, { at: number; data: ExtractResult; url: string }>();
const scope = (ext: ScraperExtension) => `groceries/${ext.id}`;
/** The queue survives restarts/redeploys: it's saved to DATA_DIR/scraper/queue-<ext>.json. */
const queueOf = (ext: ScraperExtension) => {
  if (!queues.has(ext.id)) {
    let saved: QueueItem[] = [];
    try { saved = JSON.parse(fs.readFileSync(queueFile(ext.id), "utf8")); } catch { /* none yet */ }
    queues.set(ext.id, saved);
  }
  return queues.get(ext.id)!;
};
function persistQueue(ext: ScraperExtension) {
  fs.mkdirSync(path.join(config.dataDir, "scraper"), { recursive: true });
  fs.writeFileSync(queueFile(ext.id), JSON.stringify(queueOf(ext)));
}

/* ---------- recent results (persisted, last 40) ---------- */

const resultsFile = (ext: ScraperExtension) => path.join(config.dataDir, "scraper", `results-${ext.id}.json`);
function readResults(ext: ScraperExtension): ScrapeResult[] {
  try { return JSON.parse(fs.readFileSync(resultsFile(ext), "utf8")); } catch { return []; }
}
function pushResult(ext: ScraperExtension, r: ScrapeResult) {
  const list = [r, ...readResults(ext)].slice(0, 40);
  fs.mkdirSync(path.dirname(resultsFile(ext)), { recursive: true });
  fs.writeFileSync(resultsFile(ext), JSON.stringify(list, null, 1));
}

/* ---------- database helpers ---------- */

const T = () => quoteIdent(currentTable());

async function findItem(store: string, productId: string) {
  if (!dbConfigured()) return null;
  await ensureTable();
  const r = await getPool().query<{ id: string; item_name: string; item_url: string | null }>(
    `SELECT id::text, item_name, item_url FROM ${T()} WHERE store = $1 AND store_product_id = $2`, [store, productId]);
  return r.rows[0] ?? null;
}

async function recordLookup(store: string, productId: string, result: string) {
  await getPool().query(
    `UPDATE ${T()} SET item_detail = COALESCE(item_detail, '{}'::jsonb) || $3::jsonb
     WHERE store = $1 AND store_product_id = $2`,
    [store, productId, JSON.stringify({ scrapeLookup: { at: new Date().toISOString(), result } })],
  );
}

export async function scrapeCounts(store: string) {
  if (!dbConfigured()) return null;
  await ensureTable();
  const r = await getPool().query(
    `SELECT count(*)::int total,
       count(*) FILTER (WHERE item_nf IS NULL)::int missing_nf,
       count(*) FILTER (WHERE item_ingredients IS NULL)::int missing_ingredients,
       count(*) FILTER (WHERE item_detail->'nutritionSource'->>'source' IN ('usda','off'))::int from_other,
       count(*) FILTER (WHERE item_detail->'nutritionSource'->>'source' = 'kroger-web')::int from_site,
       count(*) FILTER (WHERE item_detail->'scrapeLookup'->>'result' = 'nolabel')::int no_label,
       count(*) FILTER (WHERE last_seen_at IS NULL OR last_seen_at < now() - interval '20 hours')::int stale
     FROM ${T()} WHERE store = $1 AND removed_at IS NULL`, [store]);
  return r.rows[0];
}

/* ---------- queueing ---------- */

export interface AddOptions {
  dryRun?: boolean;
  /** Kroger API module: create the item with price/url first when it's not in the database yet. */
  apiModule?: ScraperModule;
  locationId?: string;
}

export async function enqueueManual(ext: ScraperExtension, input: string, opts: AddOptions) {
  const resolved = ext.resolveInput(input);
  if (!resolved) {
    throw Object.assign(new Error(`Not a ${ext.name} product URL, product ID, or UPC`), { statusCode: 400 });
  }
  if (!opts.dryRun && !dbConfigured()) {
    throw Object.assign(new Error("PostgreSQL is not configured (Settings → Connections)"), { statusCode: 400 });
  }
  const { productId } = resolved;
  let existing = opts.dryRun ? null : await findItem(ext.store, productId);
  let url = resolved.url;
  let note: string | undefined;

  // New item: let the API create it (name, price at the chosen store, real URL) before scraping.
  if (!opts.dryRun && !existing && opts.apiModule?.getProductDetails && opts.apiModule.status() === "ready") {
    try {
      const details = await opts.apiModule.getProductDetails(productId, opts.locationId);
      await saveItems([details]);
      existing = await findItem(ext.store, productId);
      note = "Added from the API first (name, price, link), then queued for the scraper";
    } catch (e) {
      note = `API lookup failed (${(e as Error).message.slice(0, 80)}); the scraper will create the item without a price`;
    }
  }
  url ??= ext.productUrl(productId, existing?.item_url);

  const q = queueOf(ext);
  const already = q.findIndex((x) => x.productId === productId);
  if (already >= 0) q.splice(already, 1);
  // manual items go ahead of fill items, behind earlier manual items
  const firstFill = q.findIndex((x) => x.kind === "fill");
  const item: QueueItem = { productId, url, name: existing?.item_name, kind: "manual", dryRun: opts.dryRun, addedAt: Date.now() };
  q.splice(firstFill < 0 ? q.length : firstFill, 0, item);
  persistQueue(ext);
  const job = ensureWorker(ext);
  return { queued: true, productId, url, position: q.indexOf(item) + 1, jobId: job?.id, note };
}

export async function enqueueFill(
  ext: ScraperExtension,
  opts: { limit: number; replaceOther: boolean; mode?: "missing" | "refresh" },
) {
  if (!dbConfigured()) throw Object.assign(new Error("PostgreSQL is not configured (Settings → Connections)"), { statusCode: 400 });
  await ensureTable();
  const q = queueOf(ext);
  const queuedIds = q.map((x) => x.productId);
  const limit = Math.min(Math.max(1, Math.round(opts.limit)), 500);
  if (opts.mode === "refresh") {
    // Price refresh (stores whose prices come from this scraper): revisit saved items,
    // least recently seen first, skipping anything seen in the last 20 hours.
    if (!ext.ownsPrices) throw Object.assign(new Error(`${ext.name} doesn't own prices; use the API price update`), { statusCode: 400 });
    const r = await getPool().query<{ store_product_id: string; item_name: string; item_url: string | null }>(
      `SELECT store_product_id, item_name, item_url FROM ${T()}
       WHERE store = $1 AND removed_at IS NULL AND NOT (store_product_id = ANY($2))
         AND (last_seen_at IS NULL OR last_seen_at < now() - interval '20 hours')
       ORDER BY last_seen_at NULLS FIRST
       LIMIT $3`, [ext.store, queuedIds, limit]);
    for (const row of r.rows) {
      q.push({ productId: row.store_product_id, url: ext.productUrl(row.store_product_id, row.item_url),
               name: row.item_name, kind: "fill", addedAt: Date.now() });
    }
    persistQueue(ext);
    const job = r.rows.length ? ensureWorker(ext) : null;
    return { added: r.rows.length, queueLength: q.length, jobId: job?.id };
  }
  const r = await getPool().query<{ store_product_id: string; item_name: string; item_url: string | null }>(
    `SELECT store_product_id, item_name, item_url FROM ${T()}
     WHERE store = $1 AND removed_at IS NULL
       AND NOT (store_product_id = ANY($2))
       AND (item_nf IS NULL OR item_ingredients IS NULL
            ${opts.replaceOther ? `OR item_detail->'nutritionSource'->>'source' IN ('usda','off')` : ""})
       AND (item_detail->'nutritionSource'->>'source' IS DISTINCT FROM 'kroger-web' OR item_nf IS NULL)
       AND (item_detail->'scrapeLookup'->>'at' IS NULL
            OR item_detail->'scrapeLookup'->>'result' = 'error'
            OR (item_detail->'scrapeLookup'->>'at')::timestamptz < now() - make_interval(days => $3))
     ORDER BY (item_nf IS NULL) DESC, updated_at DESC
     LIMIT $4`,
    [ext.store, queuedIds, RETRY_DAYS, limit],
  );
  for (const row of r.rows) {
    q.push({ productId: row.store_product_id, url: ext.productUrl(row.store_product_id, row.item_url),
             name: row.item_name, kind: "fill", addedAt: Date.now() });
  }
  persistQueue(ext);
  const job = r.rows.length ? ensureWorker(ext) : null;
  return { added: r.rows.length, queueLength: q.length, jobId: job?.id };
}

export function clearQueue(ext: ScraperExtension, kind?: "fill" | "manual") {
  const q = queueOf(ext);
  const keep = kind ? q.filter((x) => x.kind !== kind) : [];
  const removed = q.length - keep.length;
  q.splice(0, q.length, ...keep); // in place: a running job holds this same array
  persistQueue(ext);
  return { removed };
}

/** Start the worker for whatever is queued (e.g. after a pause ended). */
export function runQueue(ext: ScraperExtension) {
  if (!queueOf(ext).length) throw Object.assign(new Error("The queue is empty"), { statusCode: 400 });
  return ensureWorker(ext);
}

export function getPreview(ext: ScraperExtension, productId: string) {
  return previews.get(`${ext.id}:${productId}`) ?? null;
}

/* ---------- the worker job ---------- */

function ensureWorker(ext: ScraperExtension) {
  const running = runningJob(scope(ext));
  if (running) return running;
  return startJob(scope(ext), "scrape", (ctx) => work(ext, ctx));
}

async function work(ext: ScraperExtension, ctx: JobContext): Promise<string> {
  const q = queueOf(ext);
  let consecutiveErrors = 0;
  let processed = 0;
  ctx.log(`Scraper started: ${q.length} queued. Pace: max ${ext.pacing.maxPerHour}/hour with random gaps.`);
  try {
    while (q.length && !ctx.cancelled) {
      ctx.setTotal(processed + q.length);
      const item = q[0];
      let waitedNote = false;
      try {
        const { data, notFound, page } = await visit(ext, item.url, {
          label: item.productId,
          productId: item.productId,
          cancelled: () => ctx.cancelled,
          onWait: (ms, why) => {
            if (!waitedNote && ms > 5000) {
              ctx.log(`Next page in ${Math.round(ms / 1000)} s (${why === "hourly" ? "hourly limit" : "random gap"})`);
              waitedNote = true;
            }
          },
        });
        q.shift();
        persistQueue(ext);
        processed++;
        consecutiveErrors = 0;
        await handle(ext, ctx, item, data, Boolean(notFound), page.finalUrl);
      } catch (e) {
        if (ctx.cancelled) break;
        if (e instanceof InterruptionError || e instanceof CooldownError) {
          // Back off at the first interruption: stop the whole job. The queue is kept for later.
          ctx.stat("interruptions");
          pushResult(ext, { at: new Date().toISOString(), productId: item.productId, name: item.name, url: item.url,
                            kind: item.kind, result: "interrupted", message: e.message });
          const until = pacerStatus(ext.id, ext.pacing).cooldownUntil;
          const msg = e instanceof CooldownError
            ? `${e.message}; ${q.length} items still queued.`
            : `${e.message}. Paused${until ? ` until ${new Date(until).toLocaleString()}` : ""}; ${q.length} items still queued.`;
          throw Object.assign(new Error(msg), { statusCode: 429 });
        }
        if (e instanceof RunnerUnavailableError) throw e;
        q.shift();
        persistQueue(ext);
        processed++;
        ctx.stat("errors");
        ctx.log(`${item.name ?? item.productId}: ${(e as Error).message.slice(0, 200)}`);
        pushResult(ext, { at: new Date().toISOString(), productId: item.productId, name: item.name, url: item.url,
                          kind: item.kind, result: "error", message: (e as Error).message.slice(0, 200) });
        if (dbConfigured() && !item.dryRun) await recordLookup(ext.store, item.productId, "error").catch(() => {});
        if (++consecutiveErrors >= 3) throw new Error("Stopped after 3 errors in a row");
      }
      ctx.tick();
    }
  } finally {
    // One browser session per run; closing it frees Chrome's memory in FlareSolverr.
    await closeExtensionSession(ext);
  }
  return ctx.cancelled ? `Cancelled (${q.length} still queued)` : `Done: ${processed} page(s) visited`;
}

async function handle(ext: ScraperExtension, ctx: JobContext, item: QueueItem, data: ExtractResult, notFound: boolean, finalUrl: string) {
  const base = { at: new Date().toISOString(), productId: item.productId, url: item.url, kind: item.kind } as const;
  const p = data.product ?? {};
  // Existing items keep their name (the API owns names); only new items take the page's name.
  const name = item.name || p.name;
  for (const w of data.warnings ?? []) ctx.log(`Warning: ${w}`);

  if (item.dryRun) {
    previews.set(`${ext.id}:${item.productId}`, { at: Date.now(), data, url: finalUrl });
    ctx.stat("previews");
    ctx.log(`Preview ready: ${name ?? item.productId}`);
    pushResult(ext, { ...base, name, result: "preview", nutrients: p.nutrition?.nutrients.length ?? 0,
                      ingredients: Boolean(p.ingredients), allergens: Boolean(data.allergens) });
    return;
  }
  if (notFound) {
    ctx.stat("notFound");
    ctx.log(`Not found on ${ext.name}: ${name ?? item.productId}`);
    await recordLookup(ext.store, item.productId, "notfound");
    // Removal rule: the page for this exact product id is gone. When the scraper is
    // the store's only source, that's the store's confirmation -> soft-remove.
    if (ext.ownsPrices) {
      const removed = await markRemoved(ext.store, [item.productId]);
      if (removed.length) { ctx.stat("removed"); ctx.log(`Removed (no longer at ${ext.name}): ${removed[0]}`); }
    }
    pushResult(ext, { ...base, name, result: "notfound" });
    return;
  }

  const now = new Date().toISOString();

  // Prices: only for stores whose prices come from this scraper, and only from the right store.
  let price: number | undefined;
  let promoPrice: number | undefined;
  let priceNote: string | undefined;
  if (ext.ownsPrices && p.price !== undefined) {
    const want = ext.priceStore?.();
    if (want && data.storeId && data.storeId !== want) {
      priceNote = `price skipped: page was priced for store ${data.storeId}${data.storeName ? ` (${data.storeName})` : ""}, not ${want}`;
      ctx.log(`${name ?? item.productId}: ${priceNote}`);
    } else {
      price = p.price;
      promoPrice = p.promoPrice;
    }
  }
  const details: ProductDetails = {
    store: ext.store,
    productId: p.productId === item.productId ? p.productId : item.productId,
    name: name || item.productId,
    brand: p.brand,
    imageUrl: p.imageUrl,
    upc: p.upc ?? item.productId,
    url: finalUrl.split("?")[0],
    nutrition: p.nutrition,
    ingredients: p.ingredients,
    price,
    promoPrice,
    locationId: price !== undefined ? data.storeId : undefined,
    stockLevel: price !== undefined ? p.stockLevel : undefined,
    aisle: p.aisle,
    categories: p.categories,
    scrapedAt: now,
    extra: {
      ...(p.extra ?? {}),
      ...(data.allergens ? { allergens: data.allergens } : {}),
      ...(p.nutrition || p.ingredients
        ? { nutritionSource: { source: ext.id, name: ext.name, url: finalUrl.split("?")[0], basis: "serving", at: now } }
        : {}),
      scrapeLookup: { at: now, result: data.noLabel ? "nolabel" : "found" },
    },
    // price stays undefined unless this scraper owns the store's prices (see above)
  };
  await saveItems([details]);

  if (data.noLabel) {
    ctx.stat("noLabel");
    if (price !== undefined) ctx.stat("pricePoints");
    ctx.log(`No nutrition label on the page: ${details.name}`);
    pushResult(ext, { ...base, name: details.name, result: "nolabel", price, promoPrice, message: priceNote });
  } else {
    ctx.stat("saved");
    if (price !== undefined) ctx.stat("pricePoints");
    pushResult(ext, { ...base, name: details.name, result: "saved", nutrients: p.nutrition?.nutrients.length ?? 0,
                      ingredients: Boolean(p.ingredients), allergens: Boolean(data.allergens),
                      price, promoPrice, message: priceNote });
  }
}

export function workerStatus(ext: ScraperExtension) {
  const q = queueOf(ext);
  return {
    queue: q.slice(0, 50).map((x) => ({ productId: x.productId, name: x.name, kind: x.kind, dryRun: Boolean(x.dryRun) })),
    queueLength: q.length,
    queuedManual: q.filter((x) => x.kind === "manual").length,
    recent: readResults(ext).slice(0, 25),
  };
}
