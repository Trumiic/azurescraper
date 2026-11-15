/**
 * "USDA FoodData / Open Food Facts" module inside Groceries.
 *
 * Not a store: it enriches items already in the database with nutrition facts
 * and ingredients, looked up by barcode. Manual (per item, side-by-side preview)
 * or as a background "fill missing" job. The job is what the Redis scheduler
 * will run weekly once Redis is set up.
 */
import { dbConfigured, getPool, currentTable, quoteIdent } from "../../../core/db.js";
import { ensureTable } from "../../../core/items.js";
import { startJob } from "../../../core/jobs.js";
import type { ScraperModule } from "../../../core/types.js";
import type { NutritionMatch } from "./facts.js";
import { offLookup } from "./off.js";
import { barcodeCandidates } from "./upc.js";
import { usdaConfigured, usdaLookup } from "./usda.js";

export const NUTRITION_SCOPE = "groceries/nutrition";
const RETRY_DAYS = 30; // don't re-ask the sources about a not-found item for this long

export const nutrition: ScraperModule = {
  id: "nutrition",
  name: "USDA FoodData / Open Food Facts",
  description: "Adds nutrition facts and ingredients to items already in the database, by barcode.",
  method: "Nutrition by barcode (UPC)",
  kind: "enricher",
  status: () => (dbConfigured() ? "ready" : "needs-config"),
};

/* ---------- Database helpers ---------- */

const T = () => quoteIdent(currentTable());

export interface NutritionItem {
  id: string;
  store: string;
  productId: string;
  name: string;
  upc: string | null;
  image: string | null;
  hasNutrition: boolean;
  hasIngredients: boolean;
  source: { source: string; name: string; at: string } | null;
  lastLookup: { at: string; result: string } | null;
}

export async function listNutritionItems(opts: {
  filter?: "missing" | "has" | "all";
  store?: string;
  q?: string;
  page?: number;
}): Promise<{ total: number; page: number; pageSize: number; items: NutritionItem[] }> {
  await ensureTable();
  const pageSize = 50;
  const page = Math.max(1, opts.page ?? 1);
  const where: string[] = ["removed_at IS NULL"];
  const args: unknown[] = [];
  if (opts.filter === "missing") where.push("item_nf IS NULL");
  if (opts.filter === "has") where.push("item_nf IS NOT NULL");
  if (opts.store) { args.push(opts.store); where.push(`store = $${args.length}`); }
  if (opts.q) {
    args.push(`%${opts.q}%`);
    where.push(`(item_name ILIKE $${args.length} OR item_upc ILIKE $${args.length})`);
  }
  const w = `WHERE ${where.join(" AND ")}`;
  const total = await getPool().query<{ c: string }>(`SELECT count(*)::text c FROM ${T()} ${w}`, args);
  const rows = await getPool().query(
    `SELECT id::text, store, store_product_id, item_name, item_upc, item_image,
            item_nf IS NOT NULL AS has_nf, item_ingredients IS NOT NULL AS has_ing,
            item_detail->'nutritionSource' AS src, item_detail->'nutritionLookup' AS lookup
     FROM ${T()} ${w} ORDER BY item_name LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    args,
  );
  return {
    total: Number(total.rows[0].c),
    page,
    pageSize,
    items: rows.rows.map((r) => ({
      id: r.id,
      store: r.store,
      productId: r.store_product_id,
      name: r.item_name,
      upc: r.item_upc,
      image: r.item_image,
      hasNutrition: r.has_nf,
      hasIngredients: r.has_ing,
      source: r.src,
      lastLookup: r.lookup,
    })),
  };
}

export async function nutritionCounts() {
  await ensureTable();
  const r = await getPool().query<{ total: string; has: string; missing: string; stores: string[] }>(
    `SELECT count(*)::text total,
            count(*) FILTER (WHERE item_nf IS NOT NULL)::text has,
            count(*) FILTER (WHERE item_nf IS NULL)::text missing,
            coalesce(array_agg(DISTINCT store), '{}') stores
     FROM ${T()} WHERE removed_at IS NULL`,
  );
  const x = r.rows[0];
  return { total: Number(x.total), has: Number(x.has), missing: Number(x.missing), stores: x.stores };
}

async function getItem(id: string) {
  const r = await getPool().query<{ id: string; store: string; item_upc: string | null; item_name: string }>(
    `SELECT id::text, store, item_upc, item_name FROM ${T()} WHERE id = $1`, [id]);
  if (!r.rows[0]) throw Object.assign(new Error("Item not found"), { statusCode: 404 });
  return r.rows[0];
}

async function applyMatch(id: string, m: NutritionMatch) {
  const meta = {
    nutritionSource: { source: m.source, name: m.sourceName, id: m.sourceId, matchedName: m.matchedName,
                       basis: m.basis, url: m.url, at: new Date().toISOString() },
    nutritionLookup: { at: new Date().toISOString(), result: "found" },
  };
  await getPool().query(
    `UPDATE ${T()} SET
       item_nf = $2::jsonb,
       item_ingredients = COALESCE($3, item_ingredients),
       item_detail = COALESCE(item_detail, '{}'::jsonb) || $4::jsonb,
       updated_at = now()
     WHERE id = $1`,
    [id, m.nutrition ? JSON.stringify(m.nutrition) : null, m.ingredients ?? null, JSON.stringify(meta)],
  );
}

async function recordLookup(id: string, result: "notfound" | "nobarcode") {
  await getPool().query(
    `UPDATE ${T()} SET item_detail = COALESCE(item_detail, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [id, JSON.stringify({ nutritionLookup: { at: new Date().toISOString(), result } })],
  );
}

export async function clearNutrition(id: string) {
  await getItem(id);
  await getPool().query(
    `UPDATE ${T()} SET item_nf = NULL, item_ingredients = NULL,
       item_detail = COALESCE(item_detail, '{}'::jsonb) - 'nutritionSource' - 'nutritionLookup',
       updated_at = now()
     WHERE id = $1`, [id]);
}

/* ---------- Manual lookup (side by side) ---------- */

export interface LookupResult {
  itemId: string;
  name: string;
  barcodes: string[];
  usda: NutritionMatch | null;
  off: NutritionMatch | null;
  usdaEnabled: boolean;
  errors: { usda?: string; off?: string };
  note?: string;
}

// Results are kept briefly so "Use this" saves exactly what was previewed.
const cache = new Map<string, { at: number; result: LookupResult }>();

export async function lookupItem(id: string): Promise<LookupResult> {
  const item = await getItem(id);
  const barcodes = barcodeCandidates(item.item_upc, item.store);
  const result: LookupResult = {
    itemId: id, name: item.item_name, barcodes, usda: null, off: null,
    usdaEnabled: usdaConfigured(), errors: {},
  };
  if (!barcodes.length) {
    result.note = "No retail barcode for this item (e.g. produce or meat sold by weight).";
    await recordLookup(id, "nobarcode");
  } else {
    await Promise.all([
      result.usdaEnabled
        ? usdaLookup(barcodes).then((m) => { result.usda = m; }, (e: Error) => { result.errors.usda = e.message; })
        : Promise.resolve(),
      offLookup(barcodes).then((m) => { result.off = m; }, (e: Error) => { result.errors.off = e.message; }),
    ]);
    if (!result.usda && !result.off && !result.errors.usda && !result.errors.off) {
      await recordLookup(id, "notfound");
    } else if (result.usda || result.off) {
      // A source has it now: drop any old "not found" marker so the fill job will pick it up.
      await getPool().query(
        `UPDATE ${T()} SET item_detail = item_detail - 'nutritionLookup'
         WHERE id = $1 AND item_detail->'nutritionLookup'->>'result' <> 'found'`, [id]);
    }
  }
  cache.set(id, { at: Date.now(), result });
  return result;
}

export async function applyLookup(id: string, source: "usda" | "off") {
  const hit = cache.get(id);
  if (!hit || Date.now() - hit.at > 15 * 60 * 1000) {
    throw Object.assign(new Error("Lookup expired; look it up again"), { statusCode: 409 });
  }
  const m = hit.result[source];
  if (!m) throw Object.assign(new Error("Nothing to save from that source"), { statusCode: 400 });
  await applyMatch(id, m);
  return { saved: true, source: m.sourceName };
}

/* ---------- Fill job: every item missing nutrition ---------- */

export function startNutritionFill(store?: string) {
  return startJob(NUTRITION_SCOPE, "fill", async (ctx) => {
    await ensureTable();
    const args: unknown[] = [RETRY_DAYS];
    let storeFilter = "";
    if (store) { args.push(store); storeFilter = `AND store = $2`; }
    const r = await getPool().query<{ id: string; store: string; item_upc: string | null; item_name: string }>(
      `SELECT id::text, store, item_upc, item_name FROM ${T()}
       WHERE item_nf IS NULL AND removed_at IS NULL ${storeFilter}
         AND (item_detail->'nutritionLookup'->>'at' IS NULL
              OR (item_detail->'nutritionLookup'->>'at')::timestamptz < now() - make_interval(days => $1))
       ORDER BY id`,
      args,
    );
    const items = r.rows;
    const useUsda = usdaConfigured();
    ctx.setTotal(items.length);
    ctx.log(`${items.length} items need nutrition facts${useUsda ? "" : " (USDA key not set: Open Food Facts only)"}`);
    if (useUsda && items.length > 475) {
      ctx.log("USDA allows 1,000 requests/hour (~475 items): the job paces itself and may take a while");
    }

    let consecutiveErrors = 0;
    for (const it of items) {
      if (ctx.cancelled) break;
      const barcodes = barcodeCandidates(it.item_upc, it.store);
      if (!barcodes.length) {
        await recordLookup(it.id, "nobarcode");
        ctx.stat("noBarcode");
        ctx.tick();
        continue;
      }
      try {
        let match: NutritionMatch | null = null;
        if (useUsda) match = await usdaLookup(barcodes, () => ctx.cancelled);
        if (!match?.nutrition) match = (await offLookup(barcodes, () => ctx.cancelled)) ?? match;
        if (match) {
          await applyMatch(it.id, match);
          ctx.stat(match.source === "usda" ? "fromUsda" : "fromOff");
        } else {
          await recordLookup(it.id, "notfound");
          ctx.stat("notFound");
        }
        consecutiveErrors = 0;
      } catch (e) {
        if (ctx.cancelled) break;
        ctx.stat("errors");
        ctx.log(`${it.item_name}: ${(e as Error).message}`);
        if (++consecutiveErrors >= 5) throw new Error("Stopped after 5 errors in a row; check your connections");
      }
      ctx.tick();
    }
    return ctx.cancelled ? "Nutrition fill cancelled" : "Nutrition fill finished";
  });
}
