/**
 * Kroger web extension: reads nutrition facts, ingredients and allergens from
 * kroger.com product pages (rendered by FlareSolverr's real browser).
 *
 * Selectors use Kroger's component class names (NutrientDetail-Title, ...) and
 * the "Ingredients" heading, not positions, so small layout changes don't break it.
 * If they ever change, pages come back with isProductPage=true but no label,
 * and the saved snapshots in /data/snapshots/kroger-web show the new markup.
 *
 * Prices are deliberately NOT taken from the page: a scraped price belongs to
 * whatever store the browser session has, so prices stay the API's job.
 */
import type { Nutrient, NutritionFacts } from "../../../core/types.js";
import { clean, ldProduct, loadHtml, parseAmount } from "../../../scraper/extract.js";
import type { ExtractResult, FetchedPage, ScraperExtension } from "../../../scraper/types.js";
import { isValidGtin } from "../nutrition/upc.js";

/* Kroger label names -> the names USDA / Open Food Facts results use, so the grocery app sees one vocabulary. */
const NAME_MAP: Record<string, string> = {
  "sugar": "Total Sugars",
  "sugars": "Total Sugars",
  "total sugar": "Total Sugars",
  "added sugar": "Added Sugars",
  "includes added sugars": "Added Sugars",
  "total carbohydrates": "Total Carbohydrate",
  "fiber": "Dietary Fiber",
};
const normName = (n: string) => NAME_MAP[n.toLowerCase()] ?? n;

export function parseKrogerPage(html: string): ExtractResult {
  const $ = loadHtml(html);
  const ld = ldProduct($);
  const pageName = clean($('[data-testid="product-details-name"]').first().text());
  const upcText = clean($('[data-testid="product-details-upc"]').first().text()).replace(/^UPC:\s*/i, "");
  const productId = ld?.sku || (/^\d{13}$/.test(upcText) ? upcText : undefined);

  if (!ld && !pageName) return { isProductPage: false };

  const warnings: string[] = [];

  /* ----- nutrition label ----- */
  let nutrition: NutritionFacts | undefined;
  const label = $(".NutritionLabel").first();
  if (label.length) {
    const nutrients: Nutrient[] = [];
    const calories = label.find(".NutritionLabel-Calories span").last().text();
    if (calories) {
      const { amount } = parseAmount(calories);
      if (amount !== undefined) nutrients.push({ name: "Calories", amount, unit: "kcal" });
    }
    // Every nutrient (macros, sub-nutrients, vitamins/minerals) uses the same component.
    label.find(".NutrientDetail").each((_, el) => {
      const row = $(el);
      const title = clean(row.find(".NutrientDetail-Title").first().text());
      if (!title) return;
      const amountText = row.find(".NutrientDetail-Amount").first().text();
      const dvText = clean(row.find(".NutrientDetail-DailyValue").first().text());
      const { amount, unit } = parseAmount(amountText);
      const dv = dvText ? parseAmount(dvText).amount : undefined;
      nutrients.push({ name: normName(title), amount, unit, dailyValue: dv });
    });
    const servingSize = clean(label.find(".NutritionLabel-ServingSize span").last().text()) || undefined;
    const servingsText = clean(label.find(".NutritionLabel-ServingsPerContainer").text());
    const servings = servingsText.match(/([\d.,]+)\s*servings/i)?.[1];
    if (nutrients.length) {
      nutrition = {
        servingSize,
        servingsPerPackage: servings ? String(Number(servings.replace(",", ""))) : undefined,
        nutrients,
      };
    } else {
      warnings.push("Nutrition label found but no nutrient rows: Kroger may have changed its page layout");
    }
  }

  /* ----- ingredients + allergens: <h3>Heading</h3><p>text</p> ----- */
  const section = (heading: RegExp) => {
    let text: string | undefined;
    $("h2, h3, h4").each((_, el) => {
      if (text || !heading.test(clean($(el).text()))) return;
      const p = $(el).nextAll("p").first();
      const t = clean(p.text());
      if (t) text = t;
    });
    return text;
  };
  const ingredients = section(/^ingredients$/i);
  const allergens = section(/^allergen/i);

  return {
    isProductPage: true,
    product: {
      store: "kroger",
      productId,
      name: ld?.name || pageName,
      brand: ld?.brand,
      imageUrl: ld?.image,
      upc: productId,
      nutrition,
      ingredients,
    },
    allergens,
    noLabel: !nutrition && !ingredients,
    warnings,
  };
}

/**
 * Kroger ids are 13 digits: "00" + the first 11 digits of the UPC-A (no check digit).
 * Accepts that id as-is (what kroger.com shows as "UPC: ..."), a 12-digit UPC-A,
 * or an EAN-13 barcode of a US product.
 */
function toKrogerId(digits: string): string | null {
  if (/^00\d{11}$/.test(digits)) return digits;                                    // Kroger id
  if (/^\d{12}$/.test(digits) && isValidGtin(digits)) return `00${digits.slice(0, 11)}`;               // UPC-A
  if (/^0[1-9]\d{11}$/.test(digits) && isValidGtin(digits)) return `00${digits.slice(1, 12)}`;       // EAN-13
  return null;
}

export const krogerWeb: ScraperExtension = {
  id: "kroger-web",
  name: "Kroger website",
  store: "kroger",
  domains: ["kroger.com", "www.kroger.com"],
  runner: "flaresolverr",
  // Agreed limits: 50 pages/hour, random 40-104 s gaps (avg 72 s), 6 h pause after any interruption.
  pacing: { maxPerHour: 50, minGapMs: 40_000, maxGapMs: 104_000, cooldownHours: 6 },

  resolveInput(input) {
    const raw = input.trim();
    if (/^https?:\/\//i.test(raw) || /^(www\.)?kroger\.com\//i.test(raw)) {
      const u = new URL(/^https?:/i.test(raw) ? raw : `https://${raw}`);
      if (!/(^|\.)kroger\.com$/i.test(u.hostname)) return null;
      const id = u.pathname.match(/\/p\/[^/]+\/(\d{11,14})/)?.[1];
      if (!id) return null;
      const krogerId = toKrogerId(id);
      return krogerId ? { productId: krogerId, url: `https://www.kroger.com${u.pathname}` } : null;
    }
    const digits = raw.replace(/\D/g, "");
    const krogerId = toKrogerId(digits);
    return krogerId ? { productId: krogerId } : null;
  },

  productUrl(productId, savedUrl) {
    if (savedUrl && /kroger\.com\/p\//.test(savedUrl)) return savedUrl.split("?")[0];
    return `https://www.kroger.com/p/product/${productId}`;
  },

  extract(page: FetchedPage) {
    return parseKrogerPage(page.html);
  },
};

