/**
 * USDA FoodData Central (Branded Foods) lookup by barcode.
 * Free API key: https://fdc.nal.usda.gov/api-key-signup (1,000 requests/hour).
 * Data is public domain (CC0).
 */
import { config } from "../../../config.js";
import { registerProvider, resolveValues } from "../../../core/connections.js";
import { rateLimit } from "../../../core/ratelimit.js";
import { buildFacts, type NutritionMatch } from "./facts.js";
import { sameBarcode } from "./upc.js";

registerProvider({
  id: "usda",
  name: "USDA FoodData Central",
  category: "Nutrition",
  description: "Nutrition facts and ingredients for branded and store-brand foods, looked up by UPC.",
  docsUrl: "https://fdc.nal.usda.gov/api-key-signup",
  fields: [
    { key: "apiKey", label: "API key", type: "secret", required: true, env: "USDA_API_KEY",
      help: "Free from api.data.gov. Allows 1,000 requests per hour." },
  ],
  async test(values) {
    await usdaGet("/foods/search", { query: "milk", dataType: "Branded", pageSize: 1 }, values.apiKey);
    return "USDA FoodData Central key works";
  },
});

export const usdaConfigured = () => Boolean(resolveValues("usda").apiKey);

async function usdaGet<T>(path: string, params: Record<string, string | number>, key?: string, cancelled?: () => boolean): Promise<T> {
  const apiKey = key ?? resolveValues("usda").apiKey;
  if (!apiKey) throw new Error("USDA API key not set (Settings → Connections)");
  await rateLimit("usda", 950, 60 * 60 * 1000, cancelled); // stay under 1,000/hour
  const qs = new URLSearchParams({ api_key: apiKey, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const res = await fetch(`${config.usda.baseUrl}${path}?${qs}`, { headers: { Accept: "application/json" } });
  if (res.status === 404) return null as T;
  if (res.status === 429) throw new Error("USDA hourly limit reached; try again later");
  if (res.status === 403) throw new Error("USDA rejected the API key (403)");
  if (!res.ok) throw new Error(`USDA ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

/* ---------- raw shapes (only what we use) ---------- */
interface SearchFood { fdcId: number; gtinUpc?: string; description: string; brandOwner?: string; brandName?: string }
interface FoodDetail {
  fdcId: number;
  description: string;
  brandOwner?: string;
  brandName?: string;
  gtinUpc?: string;
  ingredients?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  householdServingFullText?: string;
  labelNutrients?: Record<string, { value?: number }>;
  foodNutrients?: { nutrient?: { name?: string; unitName?: string }; amount?: number }[];
}

/** USDA nutrient names (per 100 g) -> label keys, used when labelNutrients is missing. */
const FDC_NAMES: Record<string, string> = {
  "Energy": "calories",
  "Total lipid (fat)": "fat",
  "Fatty acids, total saturated": "saturatedFat",
  "Fatty acids, total trans": "transFat",
  "Cholesterol": "cholesterol",
  "Sodium, Na": "sodium",
  "Carbohydrate, by difference": "carbohydrates",
  "Fiber, total dietary": "fiber",
  "Total Sugars": "sugars",
  "Sugars, total including NLEA": "sugars",
  "Sugars, added": "addedSugar",
  "Protein": "protein",
  "Vitamin D (D2 + D3)": "vitaminD",
  "Calcium, Ca": "calcium",
  "Iron, Fe": "iron",
  "Potassium, K": "potassium",
};

function unitShort(u?: string) {
  const x = (u ?? "").toLowerCase();
  if (x === "grm" || x === "g") return "g";
  if (x === "mlt" || x === "ml") return "ml";
  return x || undefined;
}

export function mapUsdaDetail(d: FoodDetail, barcode: string): NutritionMatch {
  const unit = unitShort(d.servingSizeUnit);
  const metric = d.servingSize ? `${Math.round(d.servingSize * 10) / 10}${unit ?? ""}` : undefined;
  const servingSize = d.householdServingFullText
    ? `${d.householdServingFullText.toLowerCase()}${metric ? ` (${metric})` : ""}`
    : metric;

  let values: Record<string, number | undefined> = {};
  let basis: "serving" | "100g" = "serving";
  const label = d.labelNutrients ?? {};
  if (Object.keys(label).length) {
    for (const [k, v] of Object.entries(label)) values[k] = v?.value;
  } else {
    // Fall back to per-100g nutrients, scaled to the serving when we know it in g/ml.
    const scale = d.servingSize && (unit === "g" || unit === "ml") ? d.servingSize / 100 : undefined;
    basis = scale ? "serving" : "100g";
    for (const n of d.foodNutrients ?? []) {
      const key = FDC_NAMES[n.nutrient?.name ?? ""];
      if (!key || n.amount === undefined) continue;
      if (key === "calories" && n.nutrient?.unitName?.toLowerCase() !== "kcal") continue;
      if (key === "vitaminD" && n.nutrient?.unitName?.toLowerCase() === "iu") continue;
      values[key] = n.amount * (scale ?? 1);
    }
  }
  return {
    source: "usda",
    sourceName: "USDA FoodData Central",
    sourceId: String(d.fdcId),
    barcode: d.gtinUpc ?? barcode,
    matchedName: d.description,
    brand: d.brandName ?? d.brandOwner,
    basis,
    nutrition: buildFacts(values, basis === "serving" ? servingSize : "100 g", basis === "serving"),
    ingredients: d.ingredients?.trim() || undefined,
    url: `https://fdc.nal.usda.gov/food-details/${d.fdcId}/nutrients`,
  };
}

/** Find a Branded food whose gtinUpc exactly matches one of the barcodes. */
export async function usdaLookup(barcodes: string[], cancelled?: () => boolean): Promise<NutritionMatch | null> {
  for (const code of barcodes.slice(0, 2)) {
    const res = await usdaGet<{ foods?: SearchFood[] }>(
      "/foods/search", { query: code, dataType: "Branded", pageSize: 10 }, undefined, cancelled);
    const hit = res?.foods?.find((f) => f.gtinUpc && barcodes.some((b) => sameBarcode(b, f.gtinUpc!)));
    if (!hit) continue;
    const detail = await usdaGet<FoodDetail>(`/food/${hit.fdcId}`, {}, undefined, cancelled);
    if (detail) return mapUsdaDetail(detail, code);
  }
  return null;
}
