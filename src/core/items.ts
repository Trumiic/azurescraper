/**
 * The grocery items table: the hand-off point between AzureScraper and the grocery app.
 *
 * Columns requested: item_name, item_price, item_upc, item_url, item_detail,
 * item_nf, item_ingredients, item_image. Plus bookkeeping columns:
 * id, store + store_product_id (so re-saving updates instead of duplicating),
 * created_at / updated_at.
 *
 * Every save that has a price also records a point in the price history table
 * (<table>_prices, e.g. grocery_item_prices): one row per item, per store, per day,
 * so the grocery app can chart prices over time.
 *
 * saveItems() is the single write path: Save buttons, the crawl, the price update
 * and (later) the Redis scheduler all use it.
 */
import { currentTable, getPool, quoteIdent } from "./db.js";
import type { ProductDetails } from "./types.js";

/** grocery_items -> grocery_item_prices; anything else -> <table>_prices */
export function historyTableName(table: string) {
  return table.endsWith("_items") ? `${table.slice(0, -"_items".length)}_item_prices` : `${table}_prices`;
}

export function createTableSql(table: string) {
  const t = quoteIdent(table);
  const h = historyTableName(table);
  return `
CREATE TABLE IF NOT EXISTS ${t} (
  id                BIGSERIAL PRIMARY KEY,
  store             TEXT NOT NULL,
  store_product_id  TEXT NOT NULL,
  item_name         TEXT NOT NULL,
  item_price        NUMERIC(10,2),
  item_upc          TEXT,
  item_url          TEXT,
  item_detail       JSONB,
  item_nf           JSONB,
  item_ingredients  TEXT,
  item_image        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store, store_product_id)
);
CREATE INDEX IF NOT EXISTS ${quoteIdent(`${table}_upc_idx`)} ON ${t} (item_upc);

CREATE TABLE IF NOT EXISTS ${quoteIdent(h)} (
  id           BIGSERIAL PRIMARY KEY,
  item_id      BIGINT NOT NULL REFERENCES ${t}(id) ON DELETE CASCADE,
  location_id  TEXT NOT NULL DEFAULT '',   -- store the price came from ('' = unknown)
  price        NUMERIC(10,2),              -- regular price
  promo_price  NUMERIC(10,2),              -- sale price, if any
  recorded_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, location_id, recorded_on)
);
CREATE INDEX IF NOT EXISTS ${quoteIdent(`${h}_item_idx`)} ON ${quoteIdent(h)} (item_id, recorded_on);`;
}

const ensured = new Set<string>();

async function ensureTable(table: string) {
  if (ensured.has(table)) return;
  await getPool().query(createTableSql(table));
  ensured.add(table);
}

export interface ItemRow {
  store: string;
  store_product_id: string;
  item_name: string;
  item_price: number | null;
  item_upc: string | null;
  item_url: string | null;
  item_detail: Record<string, unknown>;
  item_nf: unknown;
  item_ingredients: string | null;
  item_image: string | null;
}

/** ProductDetails (any store) -> table row. */
export function toRow(p: ProductDetails): ItemRow {
  const detail: Record<string, unknown> = {
    brand: p.brand,
    size: p.size,
    promoPrice: p.promoPrice,
    stockLevel: p.stockLevel,
    aisle: p.aisle,
    categories: p.categories,
    locationId: p.locationId,
    scrapedAt: p.scrapedAt,
    ...p.extra,
  };
  // promoPrice is kept as null (sale ended) when we know the price; other unknowns are dropped
  if (p.price !== undefined && detail.promoPrice === undefined) detail.promoPrice = null;
  for (const k of Object.keys(detail)) if (detail[k] === undefined) delete detail[k];

  return {
    store: p.store,
    store_product_id: p.productId,
    item_name: p.name,
    item_price: p.price ?? null,
    item_upc: p.upc ?? null,
    item_url: p.url ?? null,
    item_detail: detail,
    item_nf: p.nutrition && p.nutrition.nutrients.length ? p.nutrition : null,
    item_ingredients: p.ingredients ?? null,
    item_image: p.imageUrl ?? null,
  };
}

export interface SaveResult {
  saved: number;
  inserted: number;     // new rows
  updated: number;      // existing rows refreshed
  pricePoints: number;  // rows written to the price history table
}

/** Insert or update (matched on store + store_product_id), plus a price history point. */
export async function saveItems(items: ProductDetails[]): Promise<SaveResult> {
  const result: SaveResult = { saved: 0, inserted: 0, updated: 0, pricePoints: 0 };
  if (!items.length) return result;
  const table = currentTable();
  const t = quoteIdent(table);
  const h = quoteIdent(historyTableName(table));
  await ensureTable(table);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const p of items) {
      const r = toRow(p);
      const res = await client.query<{ id: string; inserted: boolean }>(
        `INSERT INTO ${t}
           (store, store_product_id, item_name, item_price, item_upc, item_url,
            item_detail, item_nf, item_ingredients, item_image)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (store, store_product_id) DO UPDATE SET
           item_name = EXCLUDED.item_name,
           -- Kroger only returns prices for a specific store; don't wipe a known price
           item_price = COALESCE(EXCLUDED.item_price, ${t}.item_price),
           item_upc = COALESCE(EXCLUDED.item_upc, ${t}.item_upc),
           item_url = COALESCE(EXCLUDED.item_url, ${t}.item_url),
           -- merge, so keys missing from this scrape (e.g. locationId) are kept
           item_detail = COALESCE(${t}.item_detail, '{}'::jsonb) || EXCLUDED.item_detail,
           item_nf = COALESCE(EXCLUDED.item_nf, ${t}.item_nf),
           item_ingredients = COALESCE(EXCLUDED.item_ingredients, ${t}.item_ingredients),
           item_image = COALESCE(EXCLUDED.item_image, ${t}.item_image),
           updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [
          r.store, r.store_product_id, r.item_name, r.item_price, r.item_upc, r.item_url,
          JSON.stringify(r.item_detail), r.item_nf === null ? null : JSON.stringify(r.item_nf),
          r.item_ingredients, r.item_image,
        ],
      );
      result.saved++;
      if (res.rows[0].inserted) result.inserted++;
      else result.updated++;

      if (p.price !== undefined) {
        // One point per item / store / day: saving again the same day updates that point.
        await client.query(
          `INSERT INTO ${h} (item_id, location_id, price, promo_price)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (item_id, location_id, recorded_on) DO UPDATE SET
             price = EXCLUDED.price, promo_price = EXCLUDED.promo_price, recorded_at = now()`,
          [res.rows[0].id, p.locationId ?? "", p.price, p.promoPrice ?? null],
        );
        result.pricePoints++;
      }
    }
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** All saved items for one store (used by the price update job). */
export async function listStoreItems(store: string): Promise<{ productId: string; locationId?: string }[]> {
  const table = currentTable();
  const exists = await getPool().query<{ n: string | null }>("select to_regclass($1) as n", [table]);
  if (!exists.rows[0].n) return [];
  const res = await getPool().query<{ id: string; loc: string | null }>(
    `SELECT store_product_id AS id, item_detail->>'locationId' AS loc
     FROM ${quoteIdent(table)} WHERE store = $1 ORDER BY updated_at`,
    [store],
  );
  return res.rows.map((r) => ({ productId: r.id, locationId: r.loc ?? undefined }));
}

export async function countStoreItems(store: string): Promise<number> {
  const table = currentTable();
  const exists = await getPool().query<{ n: string | null }>("select to_regclass($1) as n", [table]);
  if (!exists.rows[0].n) return 0;
  const res = await getPool().query<{ c: string }>(
    `SELECT count(*)::text AS c FROM ${quoteIdent(table)} WHERE store = $1`, [store]);
  return Number(res.rows[0].c);
}

/** Which of these product ids are already in the table (for "In database" badges). */
export async function savedIds(store: string, productIds: string[]): Promise<string[]> {
  if (!productIds.length) return [];
  const table = currentTable();
  const exists = await getPool().query<{ n: string | null }>("select to_regclass($1) as n", [table]);
  if (!exists.rows[0].n) return [];
  const res = await getPool().query<{ id: string }>(
    `SELECT store_product_id AS id FROM ${quoteIdent(table)} WHERE store = $1 AND store_product_id = ANY($2)`,
    [store, productIds],
  );
  return res.rows.map((r) => r.id);
}
