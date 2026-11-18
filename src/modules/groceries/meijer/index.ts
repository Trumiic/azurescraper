/**
 * Meijer: no public API, so the module is scraper-only (Scraper tab).
 * Product data, prices and nutrition all come from the Meijer website extension.
 */
import type { ScraperModule } from "../../../core/types.js";
import { flaresolverrRunner } from "../../../scraper/runners/flaresolverr.js";

export const meijer: ScraperModule = {
  id: "meijer",
  name: "Meijer",
  description: "Meijer products, prices, sales, nutrition and ingredients from meijer.com",
  method: "Website scraper (FlareSolverr)",
  status: () => (flaresolverrRunner.ready() ? "ready" : "needs-config"),
  webExtension: "meijer-web",
};
