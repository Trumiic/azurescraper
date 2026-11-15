/**
 * Open Food Facts lookup by barcode. No key needed.
 * Community data under the Open Database License (ODbL): credit Open Food Facts,
 * and share any database you publish that is derived from it under ODbL.
 */
import { config } from "../../../config.js";
import { rateLimit } from "../../../core/ratelimit.js";
import { buildFacts, type NutritionMatch } from "./facts.js";

const USER_AGENT = "AzureScraper/0.5 (self-hosted grocery app)";

/** OFF nutriment key -> [label key, multiplier from OFF's stored unit to the label unit] */
const OFF_KEYS: Record<string, [string, number]> = {
  "energy-kcal": ["calories", 1],
  fat: ["fat", 1],
  "saturated-fat": ["saturatedFat", 1],
  "trans-fat": ["transFat", 1],
  cholesterol: ["cholesterol", 1000],      // g -> mg
  sodium: ["sodium", 1000],                // g -> mg
  carbohydrates: ["carbohydrates", 1],
  fiber: ["fiber", 1],
  sugars: ["sugars", 1],
  "added-sugars": ["addedSugar", 1],
  proteins: ["protein", 1],
  "vitamin-d": ["vitaminD", 1_000_000],    // g -> mcg
  calcium: ["calcium", 1000],
  iron: ["iron", 1000],
  potassium: ["potassium", 1000],
};

interface OffProduct {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  brands?: string;
  ingredients_text?: string;
  ingredients_text_en?: string;
  serving_size?: string;
  nutriments?: Record<string, number | string>;
}

export function mapOffProduct(p: OffProduct, barcode: string): NutritionMatch {
  const n = p.nutriments ?? {};
  const hasServing = Object.keys(OFF_KEYS).some((k) => typeof n[`${k}_serving`] === "number");
  const suffix = hasServing ? "_serving" : "_100g";
  const values: Record<string, number | undefined> = {};
  for (const [k, [labelKey, mult]] of Object.entries(OFF_KEYS)) {
    const v = n[`${k}${suffix}`];
    if (typeof v === "number") values[labelKey] = v * mult;
  }
  const code = p.code ?? barcode;
  return {
    source: "off",
    sourceName: "Open Food Facts",
    sourceId: code,
    barcode: code,
    matchedName: p.product_name_en || p.product_name || "(no name)",
    brand: p.brands?.split(",")[0]?.trim() || undefined,
    basis: hasServing ? "serving" : "100g",
    nutrition: buildFacts(values, hasServing ? p.serving_size : "100 g", hasServing),
    ingredients: (p.ingredients_text_en || p.ingredients_text)?.trim() || undefined,
    url: `https://world.openfoodfacts.org/product/${code}`,
  };
}

export async function offLookup(barcodes: string[], cancelled?: () => boolean): Promise<NutritionMatch | null> {
  const fields = "code,product_name,product_name_en,brands,ingredients_text,ingredients_text_en,serving_size,nutriments";
  for (const code of barcodes.slice(0, 2)) {
    await rateLimit("off", 90, 60 * 1000, cancelled); // OFF asks for <= 100 product reads/minute
    const res = await fetch(`${config.off.baseUrl}/api/v2/product/${code}.json?fields=${fields}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (res.status === 404) continue;
    if (res.status === 429) throw new Error("Open Food Facts rate limit reached; try again shortly");
    if (!res.ok) throw new Error(`Open Food Facts failed (${res.status})`);
    const body = (await res.json()) as { status?: number; product?: OffProduct };
    if (body.status === 1 && body.product) return mapOffProduct(body.product, code);
  }
  return null;
}
