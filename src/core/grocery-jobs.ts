/**
 * Grocery bulk jobs, usable by any store module:
 *  - crawl:  search a list of terms page by page and save everything found
 *  - prices: refresh the price of every item already saved for that store
 *
 * Both are started manually today (buttons). The Redis scheduler will call
 * startCrawl / startPriceUpdate on a timetable later (e.g. crawl weekly, prices daily).
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { startJob, type JobContext } from "./jobs.js";
import { listStoreItems, saveItems } from "./items.js";
import type { ProductDetails, ScraperModule } from "./types.js";
import { BudgetExceededError } from "./usage.js";

/* ---------- Crawl settings (per store, editable in the UI) ---------- */

export const DEFAULT_TERMS = [
  // dairy & eggs
  "milk", "eggs", "butter", "cheese", "yogurt", "sour cream", "cream cheese", "coffee creamer",
  // bakery & breakfast
  "bread", "bagels", "tortillas", "cereal", "oatmeal", "pancake mix", "syrup",
  // meat & seafood
  "chicken breast", "ground beef", "bacon", "sausage", "ham", "turkey", "pork chops", "steak", "salmon", "shrimp", "hot dogs", "deli meat",
  // produce
  "apples", "bananas", "oranges", "grapes", "strawberries", "potatoes", "onions", "tomatoes", "lettuce", "carrots", "broccoli", "avocado",
  // pantry
  "rice", "pasta", "pasta sauce", "canned beans", "canned vegetables", "soup", "peanut butter", "jelly", "flour", "sugar",
  "cooking oil", "spices", "ketchup", "mustard", "mayonnaise", "salad dressing", "broth",
  // snacks & drinks
  "chips", "crackers", "cookies", "popcorn", "nuts", "granola bars", "coffee", "tea", "soda", "juice", "water", "sports drink",
  // frozen
  "frozen pizza", "frozen vegetables", "ice cream", "frozen meals", "frozen chicken",
  // household & personal
  "paper towels", "toilet paper", "dish soap", "laundry detergent", "trash bags", "shampoo", "toothpaste",
];

export interface CrawlSettings {
  terms: string[];
  pagesPerTerm: number;
}

const settingsFile = () => path.join(config.dataDir, "crawl.json");

function readAll(): Record<string, CrawlSettings> {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}

export function getCrawlSettings(scope: string): CrawlSettings {
  return readAll()[scope] ?? { terms: DEFAULT_TERMS, pagesPerTerm: 1 };
}

export function setCrawlSettings(scope: string, s: CrawlSettings, maxPages: number): CrawlSettings {
  const terms = [...new Set(s.terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2))].slice(0, 1000);
  if (!terms.length) throw Object.assign(new Error("Add at least one search term"), { statusCode: 400 });
  const clean = { terms, pagesPerTerm: Math.min(Math.max(1, Math.round(s.pagesPerTerm || 1)), maxPages) };
  const all = readAll();
  all[scope] = clean;
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(all, null, 2));
  return clean;
}

/* ---------- Crawl ---------- */

export function startCrawl(scope: string, mod: ScraperModule, locationId: string) {
  if (!mod.searchProducts || !mod.crawl) throw Object.assign(new Error("This store can't crawl yet"), { statusCode: 400 });
  if (!locationId) throw Object.assign(new Error("Pick a store first: prices are per store"), { statusCode: 400 });
  const { terms, pagesPerTerm } = getCrawlSettings(scope);
  const { pageSize } = mod.crawl;

  return startJob(scope, "crawl", async (ctx) => {
    ctx.setTotal(terms.length);
    ctx.log(`Crawling ${terms.length} terms × up to ${pagesPerTerm} page(s) at store ${locationId}`);
    const seen = new Set<string>();

    for (const term of terms) {
      if (ctx.cancelled) break;
      for (let page = 0; page < pagesPerTerm; page++) {
        if (ctx.cancelled) break;
        let results;
        try {
          results = await mod.searchProducts!({ term, locationId, limit: pageSize, start: page * pageSize });
          ctx.stat("calls");
        } catch (e) {
          if (e instanceof BudgetExceededError) throw e;
          ctx.stat("errors");
          ctx.log(`"${term}" page ${page + 1}: ${(e as Error).message.slice(0, 160)}`);
          break; // move on to the next term
        }
        const fresh = results.filter((p) => !seen.has(p.productId));
        fresh.forEach((p) => seen.add(p.productId));
        ctx.stat("found", fresh.length);
        if (fresh.length) await saveBatch(ctx, fresh.map((p) => ({ ...p, locationId })));
        if (results.length < pageSize) break; // last page for this term
      }
      ctx.tick();
    }
    return ctx.cancelled ? "Crawl cancelled" : "Crawl finished";
  });
}

/* ---------- Price update ---------- */

export function startPriceUpdate(scope: string, mod: ScraperModule, store: string, locationOverride?: string) {
  if (!mod.refreshPrices) throw Object.assign(new Error("This store can't update prices yet"), { statusCode: 400 });

  return startJob(scope, "prices", async (ctx) => {
    const items = await listStoreItems(store);
    ctx.log(`${items.length} saved ${mod.name} items`);

    // Group by store location (each item remembers the store it was saved from).
    const groups = new Map<string, string[]>();
    let skipped = 0;
    for (const it of items) {
      const loc = locationOverride || it.locationId;
      if (!loc) { skipped++; continue; }
      if (!groups.has(loc)) groups.set(loc, []);
      groups.get(loc)!.push(it.productId);
    }
    if (skipped) ctx.log(`${skipped} items have no store saved and were skipped (pick a store and re-save them)`);
    ctx.setTotal(items.length - skipped);

    for (const [loc, ids] of groups) {
      for (let i = 0; i < ids.length; i += 50) {
        if (ctx.cancelled) break;
        const chunk = ids.slice(i, i + 50);
        try {
          const { products, calls } = await mod.refreshPrices!(chunk, loc);
          ctx.stat("calls", calls);
          ctx.stat("priced", products.length);
          ctx.stat("unpriced", chunk.length - products.length);
          if (products.length) await saveBatch(ctx, products);
        } catch (e) {
          if (e instanceof BudgetExceededError) throw e;
          ctx.stat("errors");
          ctx.log(`Batch at store ${loc}: ${(e as Error).message.slice(0, 160)}`);
        }
        ctx.tick(chunk.length);
      }
    }
    return ctx.cancelled ? "Price update cancelled" : "Price update finished";
  });
}

/* ---------- helpers ---------- */

async function saveBatch(ctx: JobContext, products: ProductDetails[]) {
  const r = await saveItems(products);
  ctx.stat("new", r.inserted);
  ctx.stat("updated", r.updated);
  ctx.stat("pricePoints", r.pricePoints);
}
