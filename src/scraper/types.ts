/**
 * AzureScraper Engine: the universal scraping core.
 *
 * - Runners fetch pages (plain HTTP, or a real browser through FlareSolverr).
 * - Extensions are small per-site plug-ins: which runner, how fast, how to
 *   build a product URL, and how to turn a page into our data shapes.
 * - The engine handles pacing, block detection (stop at the first
 *   interruption), raw-page snapshots, and errors, the same way for every site.
 */
import type { ProductDetails } from "../core/types.js";

export interface FetchedPage {
  url: string;          // requested URL
  finalUrl: string;     // after redirects
  status: number;       // HTTP status of the page
  html: string;
  runner: string;
  ms: number;           // time taken
}

export interface Runner {
  id: string;
  name: string;
  ready(): boolean;
  /** `session` keeps one browser (cookies) across requests when the runner supports it. */
  fetch(url: string, opts: { session?: string; timeoutMs?: number }): Promise<FetchedPage>;
  closeSession?(session: string): Promise<void>;
}

/** Pace limits for one site. Requests are spaced with a random gap between min and max. */
export interface Pacing {
  maxPerHour: number;
  minGapMs: number;
  maxGapMs: number;
  cooldownHours: number; // pause after an interruption
}

/** What a site extension pulls out of one product page. */
export interface ExtractResult {
  /** Did the page look like a real product page? If false the engine treats it as an interruption. */
  isProductPage: boolean;
  product?: Partial<ProductDetails>;
  allergens?: string;
  /** Page is a product but has no nutrition label (e.g. paper towels). */
  noLabel?: boolean;
  /** Store the page's prices belong to (for sites whose prices are store-specific). */
  storeId?: string;
  storeName?: string;
  warnings?: string[];
}

export interface ScraperExtension {
  id: string;            // e.g. "kroger-web"
  name: string;
  store: string;         // grocery_items.store this extension enriches
  domains: string[];
  runner: string;        // runner id
  pacing: Pacing;
  /** Turn user input (URL / id / UPC) into a product id + URL, or null if not understood. */
  resolveInput(input: string): { productId: string; url?: string } | null;
  productUrl(productId: string, savedUrl?: string | null): string;
  extract(page: FetchedPage, productId?: string): ExtractResult;
  /**
   * Price ownership: true when this scraper is the store's only price source
   * (no API). Then it writes prices + price history, and a confirmed 404 soft-
   * removes the item. When false (e.g. Kroger, whose API owns prices) it never
   * touches prices.
   */
  ownsPrices?: boolean;
  /** The store prices must come from (if set, pages priced for another store are not saved). */
  priceStore?(): string | undefined;
}

/** The site stopped serving normal pages: block page, challenge, 403/429, or an unexpected page. */
export class InterruptionError extends Error {
  constructor(message: string, public snapshot?: string) {
    super(message);
  }
}
