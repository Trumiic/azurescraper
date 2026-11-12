/**
 * The grocery items table: the hand-off point between AzureScraper and the grocery app.
 *
 * Columns requested: item_name, item_price, item_upc, item_url, item_detail,
 * item_nf, item_ingredients, item_image. Plus bookkeeping columns:
 * id, store + store_product_id (so re-saving updates instead of duplicating),
 * created_at / updated_at.
 *
 * saveItems() is the single write path: the Save buttons use it now, and the
 * Redis job worker will call the same function later.
 */
import { currentTable, getPool, quoteIdent } from "./db.js";
import type { ProductDetails } from "./types.js";

export function createTableSql(table: string) {
  const t = quoteIdent(table);
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
CREATE INDEX IF NOT EXISTS ${quoteIdent(`${table}_upc_idx`)} ON ${t} (item_upc);`;
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

/** Insert or update (matched on store + store_product_id). */
export async function saveItems(items: ProductDetails[]): Promise<number> {
  if (!items.length) return 0;
  const table = currentTable();
  await ensureTable(table);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const p of items) {
      const r = toRow(p);
      await client.query(
        `INSERT INTO ${quoteIdent(table)}
           (store, store_product_id, item_name, item_price, item_upc, item_url,
            item_detail, item_nf, item_ingredients, item_image)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (store, store_product_id) DO UPDATE SET
           item_name = EXCLUDED.item_name,
           -- Kroger only returns prices for a specific store; don't wipe a known price
           item_price = COALESCE(EXCLUDED.item_price, ${quoteIdent(table)}.item_price),
           item_upc = EXCLUDED.item_upc,
           item_url = EXCLUDED.item_url,
           -- merge, so keys missing from this scrape (e.g. locationId) are kept
           item_detail = COALESCE(${quoteIdent(table)}.item_detail, '{}'::jsonb) || EXCLUDED.item_detail,
           item_nf = COALESCE(EXCLUDED.item_nf, ${quoteIdent(table)}.item_nf),
           item_ingredients = COALESCE(EXCLUDED.item_ingredients, ${quoteIdent(table)}.item_ingredients),
           item_image = COALESCE(EXCLUDED.item_image, ${quoteIdent(table)}.item_image),
           updated_at = now()`,
        [
          r.store, r.store_product_id, r.item_name, r.item_price, r.item_upc, r.item_url,
          JSON.stringify(r.item_detail), r.item_nf === null ? null : JSON.stringify(r.item_nf),
          r.item_ingredients, r.item_image,
        ],
      );
    }
    await client.query("COMMIT");
    return items.length;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
