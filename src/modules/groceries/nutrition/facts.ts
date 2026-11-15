/**
 * Shared nutrition-label vocabulary so USDA and Open Food Facts results
 * end up in the same item_nf shape: {servingSize, servingsPerPackage, nutrients:[{name, amount, unit, dailyValue}]}
 */
import type { Nutrient, NutritionFacts } from "../../../core/types.js";

/** Label order, unit, and FDA daily value (for %DV) of the standard US nutrition label. */
export const LABEL: { key: string; name: string; unit: string; dv?: number }[] = [
  { key: "calories", name: "Calories", unit: "kcal" },
  { key: "fat", name: "Total Fat", unit: "g", dv: 78 },
  { key: "saturatedFat", name: "Saturated Fat", unit: "g", dv: 20 },
  { key: "transFat", name: "Trans Fat", unit: "g" },
  { key: "cholesterol", name: "Cholesterol", unit: "mg", dv: 300 },
  { key: "sodium", name: "Sodium", unit: "mg", dv: 2300 },
  { key: "carbohydrates", name: "Total Carbohydrate", unit: "g", dv: 275 },
  { key: "fiber", name: "Dietary Fiber", unit: "g", dv: 28 },
  { key: "sugars", name: "Total Sugars", unit: "g" },
  { key: "addedSugar", name: "Added Sugars", unit: "g", dv: 50 },
  { key: "protein", name: "Protein", unit: "g", dv: 50 },
  { key: "vitaminD", name: "Vitamin D", unit: "mcg", dv: 20 },
  { key: "calcium", name: "Calcium", unit: "mg", dv: 1300 },
  { key: "iron", name: "Iron", unit: "mg", dv: 18 },
  { key: "potassium", name: "Potassium", unit: "mg", dv: 4700 },
];

const round = (v: number, unit: string) =>
  unit === "kcal" || unit === "mg" ? Math.round(v) : Math.round(v * 10) / 10;

/** Build a NutritionFacts object from {labelKey: amountInLabelUnit}. */
export function buildFacts(
  values: Record<string, number | undefined>,
  servingSize: string | undefined,
  withDailyValues: boolean,
): NutritionFacts | undefined {
  const nutrients: Nutrient[] = [];
  for (const l of LABEL) {
    const v = values[l.key];
    if (v === undefined || !Number.isFinite(v)) continue;
    const amount = round(v, l.unit);
    nutrients.push({
      name: l.name,
      amount,
      unit: l.unit,
      dailyValue: withDailyValues && l.dv ? Math.round((v / l.dv) * 100) : undefined,
    });
  }
  return nutrients.length ? { servingSize, nutrients } : undefined;
}

/** One candidate result from a nutrition source, shown side by side in the UI. */
export interface NutritionMatch {
  source: "usda" | "off";
  sourceName: string;
  sourceId: string;          // fdcId or OFF barcode
  barcode: string;           // barcode that matched
  matchedName: string;
  brand?: string;
  basis: "serving" | "100g"; // what the amounts are per
  nutrition?: NutritionFacts;
  ingredients?: string;
  url: string;               // page on the source's site
}
