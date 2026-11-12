import type { Product, ScraperModule, StoreLocation } from "../../../core/types.js";
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
    url: `https://www.kroger.com/p/product/${p.productId}`,
    categories: p.categories,
    aisle: aisle?.description ?? aisle?.number,
    scrapedAt: scrapedAt.toISOString(),
  };
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
};
