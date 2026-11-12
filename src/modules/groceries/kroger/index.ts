import type { Nutrient, NutritionFacts, Product, ProductDetails, ScraperModule, StoreLocation } from "../../../core/types.js";
import { registerProvider } from "../../../core/connections.js";
import { fetchToken, krogerConfigured, krogerCreds, krogerGet } from "./client.js";

/* ---------- Connection definition (shows up in Settings -> Connections) ---------- */

registerProvider({
  id: "kroger",
  name: "Kroger",
  category: "Groceries",
  description: "Kroger Public API: product search, prices and store locations.",
  docsUrl: "https://developer.kroger.com",
  fields: [
    { key: "clientId", label: "Client ID", type: "text", required: true, env: "KROGER_CLIENT_ID" },
    { key: "clientSecret", label: "Client Secret", type: "secret", required: true, env: "KROGER_CLIENT_SECRET" },
    {
      key: "locationId",
      label: "Default store ID",
      type: "text",
      placeholder: "e.g. 01400943",
      help: "Optional. Used when no store is picked on the Kroger page.",
      env: "KROGER_LOCATION_ID",
    },
  ],
  async test(values) {
    await fetchToken({ clientId: values.clientId, clientSecret: values.clientSecret });
    return "Authenticated with Kroger";
  },
});

/* ---------- Raw shapes from the Kroger API (only the fields we use) ---------- */

interface KrogerImageSize { size: string; url: string }
interface KrogerImage { perspective: string; featured?: boolean; sizes: KrogerImageSize[] }
interface KrogerItem {
  itemId: string;
  size?: string;
  price?: { regular?: number; promo?: number };
  inventory?: { stockLevel?: string };
}
export interface KrogerProduct {
  productId: string;
  upc?: string;
  brand?: string;
  description: string;
  categories?: string[];
  images?: KrogerImage[];
  items?: KrogerItem[];
  aisleLocations?: { description?: string; number?: string }[];
  productPageURI?: string;
  // Present on some responses; shape is parsed defensively below.
  nutritionInformation?: unknown;
  ingredientStatement?: string;
  [key: string]: unknown;
}
interface KrogerLocation {
  locationId: string;
  chain?: string;
  name: string;
  address?: { addressLine1?: string; city?: string; state?: string; zipCode?: string };
}

/* ---------- Normalizers: raw Kroger JSON -> our shared Product type ---------- */

const SIZE_ORDER = ["xlarge", "large", "medium", "small", "thumbnail"];

function pickImage(images: KrogerImage[] = []): string | undefined {
  const img =
    images.find((i) => i.featured) ?? images.find((i) => i.perspective === "front") ?? images[0];
  if (!img?.sizes?.length) return undefined;
  for (const s of SIZE_ORDER) {
    const hit = img.sizes.find((x) => x.size === s);
    if (hit) return hit.url;
  }
  return img.sizes[0].url;
}

export function normalizeKrogerProduct(p: KrogerProduct, scrapedAt = new Date()): Product {
  const item = p.items?.[0];
  const promo = item?.price?.promo;
  const aisle = p.aisleLocations?.[0];
  return {
    store: "kroger",
    productId: p.productId,
    upc: p.upc,
    name: p.description,
    brand: p.brand,
    size: item?.size,
    price: item?.price?.regular || undefined,
    // Kroger returns promo: 0 when there is no sale
    promoPrice: promo && promo > 0 ? promo : undefined,
    stockLevel: item?.inventory?.stockLevel,
    imageUrl: pickImage(p.images),
    url: p.productPageURI
      ? `https://www.kroger.com${p.productPageURI}`
      : `https://www.kroger.com/p/product/${p.productId}`,
    categories: p.categories,
    aisle: aisle?.description ?? aisle?.number,
    scrapedAt: scrapedAt.toISOString(),
  };
}

/* ---------- Nutrition facts + ingredients ----------
 * Kroger's docs don't spell out these fields, so this reads them defensively:
 * it accepts an object or array under nutritionInformation and common key names.
 * Use the "raw" endpoint (/api/.../kroger/raw/<productId>) to see the real shape.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? undefined : Number(v));
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function unitText(u: unknown): string | undefined {
  if (typeof u === "string") return u;
  if (isObj(u)) return str(u.abbreviation) ?? str(u.name) ?? str(u.code);
  return undefined;
}

function sizeText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (isObj(v)) {
    const desc = str(v.description);
    if (desc) return desc;
    const q = num(v.quantity ?? v.value);
    const u = unitText(v.unitOfMeasure ?? v.unit);
    if (q !== undefined) return u ? `${q} ${u}` : String(q);
  }
  if (typeof v === "number") return String(v);
  return undefined;
}

export function parseKrogerNutrition(p: KrogerProduct): { nutrition?: NutritionFacts; ingredients?: string } {
  const raw = p.nutritionInformation;
  const info: Obj | undefined = Array.isArray(raw) ? raw.find(isObj) : isObj(raw) ? raw : undefined;

  const ingredients =
    str(info?.ingredientStatement) ?? str(info?.ingredients) ?? str(p.ingredientStatement) ?? str(p.ingredients);

  if (!info) return { ingredients };

  const nutrients: Nutrient[] = [];
  const list = Array.isArray(info.nutrients) ? info.nutrients : [];
  for (const n of list) {
    if (!isObj(n)) continue;
    const name = str(n.displayName) ?? str(n.description) ?? str(n.name) ?? str(n.code);
    if (!name) continue;
    nutrients.push({
      name,
      amount: num(n.quantity ?? n.amount ?? n.value),
      unit: unitText(n.unitOfMeasure ?? n.unit),
      dailyValue: num(n.percentDailyIntake ?? n.percentDailyValue ?? n.dailyValue),
    });
  }

  return {
    ingredients,
    nutrition: {
      servingSize: sizeText(info.servingSize),
      servingsPerPackage: sizeText(info.servingsPerPackage),
      nutrients,
    },
  };
}

export function toKrogerDetails(p: KrogerProduct, locationId?: string): ProductDetails {
  const { nutrition, ingredients } = parseKrogerNutrition(p);
  const extra: Record<string, unknown> = {};
  for (const k of ["countryOrigin", "temperature", "itemInformation", "allergens", "allergensDescription"]) {
    if (p[k] !== undefined) extra[k] = p[k];
  }
  return { ...normalizeKrogerProduct(p), locationId, nutrition, ingredients, extra };
}

/* ---------- The module ---------- */

export const kroger: ScraperModule = {
  id: "kroger",
  name: "Kroger",
  description: "Kroger family of stores (Kroger, Ralphs, Fred Meyer, King Soopers, ...)",
  method: "Official Kroger Public API (OAuth2, JSON)",

  status: () => (krogerConfigured() ? "ready" : "needs-config"),

  async findLocations(zip: string): Promise<StoreLocation[]> {
    const res = await krogerGet<{ data: KrogerLocation[] }>("/locations", {
      "filter.zipCode.near": zip,
      "filter.radiusInMiles": 25,
      "filter.limit": 15,
    });
    return res.data.map((l) => ({
      locationId: l.locationId,
      name: l.name,
      chain: l.chain,
      address: l.address
        ? `${l.address.addressLine1 ?? ""}, ${l.address.city ?? ""}, ${l.address.state ?? ""} ${l.address.zipCode ?? ""}`.trim()
        : undefined,
    }));
  },

  async searchProducts({ term, locationId, limit = 24, start }) {
    const res = await krogerGet<{ data: KrogerProduct[] }>("/products", {
      "filter.term": term,
      "filter.locationId": locationId || krogerCreds().locationId,
      "filter.limit": Math.min(limit, 50), // API max is 50 per page
      "filter.start": start,
    });
    const now = new Date();
    return res.data.map((p) => normalizeKrogerProduct(p, now));
  },

  async getRawProduct(productId, locationId) {
    return krogerGet<unknown>(`/products/${encodeURIComponent(productId)}`, {
      "filter.locationId": locationId || krogerCreds().locationId,
    });
  },

  async getProductDetails(productId, locationId) {
    const loc = locationId || krogerCreds().locationId;
    const res = await krogerGet<{ data: KrogerProduct }>(`/products/${encodeURIComponent(productId)}`, {
      "filter.locationId": loc,
    });
    return toKrogerDetails(res.data, loc || undefined);
  },
};
