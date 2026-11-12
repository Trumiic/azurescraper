/**
 * Core contracts shared by every category and scraper module.
 * Every store module converts its own raw data into these shapes,
 * so the UI (and later the database) only ever deals with one format.
 */

export type ModuleStatus = "ready" | "needs-config" | "planned";

/** A normalized product, the same for every grocery store. */
export interface Product {
  store: string;            // module id, e.g. "kroger"
  productId: string;        // store's own product id
  upc?: string;
  name: string;
  brand?: string;
  size?: string;
  price?: number;           // regular price
  promoPrice?: number;      // sale price, if any
  stockLevel?: string;      // e.g. HIGH / LOW / TEMPORARILY_OUT_OF_STOCK
  imageUrl?: string;
  url?: string;             // link to the product on the store's site
  categories?: string[];
  aisle?: string;
  scrapedAt: string;        // ISO timestamp
}

/** A physical store / location the user can pick (prices are per-store). */
export interface StoreLocation {
  locationId: string;
  name: string;
  chain?: string;
  address?: string;
}

export interface SearchOptions {
  term: string;
  locationId?: string;
  limit?: number;
  start?: number;
}

/** What every scraper module (Kroger, Walmart, ...) implements. */
export interface ScraperModule {
  id: string;
  name: string;
  description: string;
  /** Short note on how this module gets its data (API, HTML, embedded JSON...). */
  method: string;
  status(): ModuleStatus;
  /** Optional: stores near a ZIP code. */
  findLocations?(zip: string): Promise<StoreLocation[]>;
  /** Optional until the module is implemented. */
  searchProducts?(opts: SearchOptions): Promise<Product[]>;
}

/** A tile on the home page (Groceries, ...), holding its modules. */
export interface Category {
  id: string;
  name: string;
  description: string;
  icon: string;             // emoji for now; swap for SVG later
  modules: ScraperModule[];
}
