/**
 * Meijer website extension.
 *
 * meijer.com product pages (Next.js) embed a full product record in their page
 * data: name, UPC, prices (regular / current / sale end), store, stock, aisle,
 * images, category, ingredients and nutrition label fields. We read that record
 * instead of on-screen text: it's exact, and it doesn't need accordions opened.
 *
 * Meijer has no public API, so this scraper is Meijer's price source
 * (ownsPrices). Prices are only saved when the record's store matches the
 * configured Meijer store (Settings -> Connections -> Meijer), if one is set.
 */
import type { Nutrient, NutritionFacts } from "../../../core/types.js";
import { registerProvider, resolveValues } from "../../../core/connections.js";
import { clean, loadHtml } from "../../../scraper/extract.js";
import { decodeNextFlight, findObjects, jsonish } from "../../../scraper/nextdata.js";
import type { ExtractResult, FetchedPage, ScraperExtension } from "../../../scraper/types.js";
import { isValidGtin } from "../nutrition/upc.js";

registerProvider({
  id: "meijer",
  name: "Meijer",
  category: "Groceries",
  description: "Meijer website scraper settings (no API key needed).",
  fields: [
    { key: "storeId", label: "Store ID", type: "text", placeholder: "220",
      help: "Prices are only saved from pages priced for this store. Leave empty to accept whichever store meijer.com picks (recorded per price)." },
  ],
});

/* ---------- raw record shapes (only what we use) ---------- */

interface LabelEntry { i?: number; n?: string; v?: string | number; u?: string; p?: string | number }
interface ProductStore {
  isOnSale?: boolean; basePrice?: number; customerPrice?: number; clearancePrice?: number | null;
  priceEndDate?: string; savingsDescription?: string | null; isPriceDisplayable?: boolean; priceText?: string;
}
interface StoreDetails {
  storeId?: number | string; storeInfo?: { name?: string };
  productStore?: ProductStore;
  productStoreInventory?: { stockStatus?: string; ilcPrimary?: string };
  promotions?: unknown[];
}
export interface MeijerRecord {
  upc: string;
  productId?: string;
  productName?: string;
  brandDescription?: string;
  brandName?: string;
  productDetails?: string;
  descriptiveFeatures?: string;
  ingredients?: string | null;
  nutritionLabelHeader?: unknown;
  nutritionLabelMain?: unknown;
  nutritionLabelMicroNutrients?: unknown;
  nutritionLabelVitamin?: unknown;
  nutritionLabelMineral?: unknown;
  storeSpecificProductDetails?: unknown;
  taxonomy?: unknown;
  thumbnailImage?: unknown;
  productMedia?: unknown;
  isFoodStampEligible?: boolean;
  isPriceByWeight?: boolean;
  soldByUnit?: string;
}

/* ---------- nutrition ---------- */

const NAME_MAP: Record<string, string> = {
  "sugar": "Total Sugars", "sugars": "Total Sugars", "total sugar": "Total Sugars",
  "added sugar": "Added Sugars", "added sugars": "Added Sugars", "includes added sugars": "Added Sugars",
  "total carbohydrates": "Total Carbohydrate", "fiber": "Dietary Fiber",
};
const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s);
const normName = (n: string) => NAME_MAP[n.trim().toLowerCase()] ?? titleCase(n.trim());

/** FDA daily values, to catch unit typos (e.g. "Calcium 210mcg 15%" really means mg). */
const DV: Record<string, [number, string]> = {
  "total fat": [78, "g"], "saturated fat": [20, "g"], "cholesterol": [300, "mg"], "sodium": [2300, "mg"],
  "total carbohydrate": [275, "g"], "dietary fiber": [28, "g"], "added sugars": [50, "g"], "protein": [50, "g"],
  "vitamin d": [20, "mcg"], "calcium": [1300, "mg"], "iron": [18, "mg"], "potassium": [4700, "mg"],
};
const TO_BASE: Record<string, number> = { g: 1, mg: 1e-3, mcg: 1e-6 };

/** If amount+unit disagrees with %DV by exactly 1000x, fix the unit. Returns a note when it did. */
function fixUnit(n: Nutrient): string | undefined {
  const ref = DV[n.name.toLowerCase()];
  if (!ref || n.amount === undefined || !n.dailyValue || !n.unit || !(n.unit in TO_BASE)) return;
  const [dvAmount, dvUnit] = ref;
  const pct = (unitAmount: number, unit: string) => (unitAmount * TO_BASE[unit]) / (dvAmount * TO_BASE[dvUnit]) * 100;
  const close = (a: number) => Math.abs(a - n.dailyValue!) <= Math.max(2, n.dailyValue! * 0.2);
  if (close(pct(n.amount, n.unit))) return;
  for (const u of ["g", "mg", "mcg"]) {
    if (u !== n.unit && close(pct(n.amount, u))) {
      const note = `${n.name}: unit corrected ${n.unit} → ${u} (matches ${n.dailyValue}% DV)`;
      n.unit = u;
      return note;
    }
  }
}

function labelRows(v: unknown): LabelEntry[] {
  const arr = jsonish<LabelEntry[] | { items?: LabelEntry[] }>(v);
  if (Array.isArray(arr)) return arr;
  if (arr && Array.isArray((arr as { items?: LabelEntry[] }).items)) return (arr as { items: LabelEntry[] }).items;
  return [];
}
const num = (v: unknown) => {
  const m = String(v ?? "").replace(",", "").match(/-?[\d.]+/);
  return m ? Number(m[0]) : undefined;
};

export function parseMeijerNutrition(r: MeijerRecord): { nutrition?: NutritionFacts; notes: string[] } {
  const notes: string[] = [];
  const header = labelRows(r.nutritionLabelHeader);
  const sections = [r.nutritionLabelMain, r.nutritionLabelMicroNutrients, r.nutritionLabelVitamin, r.nutritionLabelMineral];
  const nutrients: Nutrient[] = [];
  let servingSize: string | undefined;
  let servingsPerPackage: string | undefined;

  // Header: serving size, servings per container, calories (names vary, so match loosely)
  for (const h of header) {
    const name = clean(String(h.n ?? ""));
    const value = clean(`${h.v ?? ""}${h.u ? ` ${h.u}` : ""}`);
    if (/serving size/i.test(name)) servingSize = value || undefined;
    else if (/servings? per/i.test(name)) servingsPerPackage = value || undefined;
    else if (/calorie/i.test(name)) {
      const a = num(h.v);
      if (a !== undefined) nutrients.push({ name: "Calories", amount: a, unit: "kcal" });
    } else if (name && value) {
      // unknown header line: keep it as text-ish nutrient so nothing is lost
      nutrients.push({ name: normName(name), amount: num(h.v), unit: h.u || undefined });
    }
  }
  for (const section of sections) {
    for (const row of labelRows(section).sort((a, b) => (a.i ?? 0) - (b.i ?? 0))) {
      const name = clean(String(row.n ?? ""));
      if (!name) continue;
      if (/calorie/i.test(name) && nutrients.some((n) => n.name === "Calories")) continue;
      const n: Nutrient = {
        name: /calorie/i.test(name) ? "Calories" : normName(name),
        amount: num(row.v),
        unit: (row.u ? String(row.u) : undefined)?.toLowerCase().replace("µg", "mcg") || (/calorie/i.test(name) ? "kcal" : undefined),
        dailyValue: num(row.p),
      };
      const note = fixUnit(n);
      if (note) notes.push(note);
      nutrients.push(n);
    }
  }
  return {
    nutrition: nutrients.length ? { servingSize, servingsPerPackage, nutrients } : undefined,
    notes,
  };
}

/* ---------- record -> our product ---------- */

/** Meijer product ids = UPC without check digit, leading zeros dropped (milk: 4125010200). */
export function toMeijerId(input: string): string | null {
  const d = input.replace(/\D/g, "");
  if (!d) return null;
  if (/^00\d{11}$/.test(d)) return d.slice(2).replace(/^0+/, "");                              // Kroger-style id
  if (/^\d{12}$/.test(d) && isValidGtin(d)) return d.slice(0, 11).replace(/^0+/, "");          // UPC-A
  if (/^0\d{12}$/.test(d) && isValidGtin(d)) return d.slice(1, 12).replace(/^0+/, "");         // EAN-13 of a US UPC
  if (d.length <= 11) return d.replace(/^0+/, "") || null;                                     // Meijer id
  return null;
}

export function mapMeijerRecord(r: MeijerRecord, url: string) {
  const store = jsonish<StoreDetails>(r.storeSpecificProductDetails) ?? {};
  const ps = store.productStore ?? {};
  const base = typeof ps.basePrice === "number" ? ps.basePrice : undefined;
  const current = typeof ps.customerPrice === "number" ? ps.customerPrice : undefined;
  const onSale = Boolean(ps.isOnSale) && current !== undefined && base !== undefined && current < base;
  const clearance = typeof ps.clearancePrice === "number" ? ps.clearancePrice : undefined;
  const promo = onSale ? current : clearance !== undefined && base !== undefined && clearance < base ? clearance : undefined;

  const thumb = jsonish<{ url?: string }>(r.thumbnailImage);
  const media = jsonish<{ url?: string; width?: number; isDefault?: boolean }[]>(r.productMedia) ?? [];
  const bigDefault = media.filter((m) => m.url && m.isDefault !== false).sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  const taxonomy = jsonish<{ name?: string }[]>(r.taxonomy) ?? [];
  const { nutrition, notes } = parseMeijerNutrition(r);
  const ingredients = clean(r.ingredients ?? "") || undefined;

  return {
    product: {
      store: "meijer",
      productId: r.upc,
      upc: r.upc,
      name: clean(r.productName ?? "") || undefined,
      brand: r.brandDescription || r.brandName || undefined,
      imageUrl: bigDefault?.url ?? thumb?.url,
      url: url.split("?")[0],
      price: ps.isPriceDisplayable === false ? undefined : base,
      promoPrice: ps.isPriceDisplayable === false ? undefined : promo,
      stockLevel: store.productStoreInventory?.stockStatus,
      aisle: store.productStoreInventory?.ilcPrimary,
      categories: taxonomy.map((t) => t.name).filter((x): x is string => Boolean(x)),
      nutrition,
      ingredients,
      extra: {
        ...(onSale && ps.priceEndDate ? { promoEnds: ps.priceEndDate } : {}),
        ...(ps.savingsDescription ? { savings: ps.savingsDescription } : {}),
        ...(clearance !== undefined ? { clearancePrice: clearance } : {}),
        ...(r.productDetails ? { description: clean(r.productDetails) } : {}),
        ...(r.descriptiveFeatures ? { features: clean(r.descriptiveFeatures) } : {}),
        ...(r.isFoodStampEligible !== undefined ? { snapEligible: r.isFoodStampEligible } : {}),
        ...(r.isPriceByWeight ? { priceByWeight: true } : {}),
        ...(store.storeInfo?.name ? { storeName: store.storeInfo.name } : {}),
        ...(notes.length ? { nutritionNotes: notes } : {}),
      },
    },
    storeId: store.storeId !== undefined ? String(store.storeId) : undefined,
    storeName: store.storeInfo?.name,
    notes,
  };
}

export function parseMeijerPage(html: string, productId?: string, url = ""): ExtractResult {
  const flight = decodeNextFlight(html);
  const want = productId ? toMeijerId(productId) : null;
  const records = findObjects<MeijerRecord>(
    flight,
    '"nutritionLabelMain"',
    (o) => typeof o.upc === "string" && typeof o.productName === "string",
    30,
  );
  const record = (want && records.find((r) => r.upc.replace(/^0+/, "") === want)) || (!want ? records[0] : undefined);

  if (!record) {
    // A real product page always has an <h1>; without the record we can't trust anything else.
    const h1 = clean(loadHtml(html)("h1").first().text());
    if (!h1) return { isProductPage: false };
    return {
      isProductPage: true, noLabel: true,
      product: { store: "meijer", productId: want ?? undefined, name: h1 },
      warnings: ["Product page loaded but its data record wasn't found: Meijer may have changed its page format"],
    };
  }
  const m = mapMeijerRecord(record, url);
  return {
    isProductPage: true,
    product: m.product,
    noLabel: !m.product.nutrition && !m.product.ingredients,
    storeId: m.storeId,
    storeName: m.storeName,
    warnings: m.notes.length ? [`Nutrition label fixes: ${m.notes.join("; ")}`] : [],
  };
}

export const meijerWeb: ScraperExtension = {
  id: "meijer-web",
  name: "Meijer website",
  store: "meijer",
  domains: ["meijer.com", "www.meijer.com"],
  runner: "flaresolverr",
  pacing: { maxPerHour: 50, minGapMs: 40_000, maxGapMs: 104_000, cooldownHours: 6 },
  ownsPrices: true,
  priceStore: () => resolveValues("meijer").storeId?.trim() || undefined,

  resolveInput(input) {
    const raw = input.trim();
    if (/^https?:\/\//i.test(raw) || /^(www\.)?meijer\.com\//i.test(raw)) {
      const u = new URL(/^https?:/i.test(raw) ? raw : `https://${raw}`);
      if (!/(^|\.)meijer\.com$/i.test(u.hostname)) return null;
      const id = u.pathname.match(/\/shopping\/product\/[^/]+\/(\d{3,14})/)?.[1];
      const meijerId = id ? toMeijerId(id) : null;
      return meijerId ? { productId: meijerId, url: `https://www.meijer.com${u.pathname}` } : null;
    }
    const meijerId = toMeijerId(raw);
    return meijerId ? { productId: meijerId } : null;
  },

  productUrl(productId, savedUrl) {
    if (savedUrl && /meijer\.com\/shopping\/product\//.test(savedUrl)) return savedUrl.split("?")[0];
    return `https://www.meijer.com/shopping/product/item/${productId}`;
  },

  extract(page: FetchedPage, productId?: string) {
    return parseMeijerPage(page.html, productId, page.finalUrl || page.url);
  },
};
