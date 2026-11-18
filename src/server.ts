import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { categories, findCategory, findModule } from "./core/registry.js";
import type { Category, ScraperModule } from "./core/types.js";
import {
  deleteConnection,
  envOnlyProviders,
  getProvider,
  getSaved,
  HttpError,
  listProviders,
  listSaved,
  loadConnections,
  publicView,
  upsertConnection,
} from "./core/connections.js";
import { currentTable, dbConfigured } from "./core/db.js";
import { countStoreItems, createTableSql, historyTableName, savedIds, saveItems } from "./core/items.js";
import { allJobs, cancelJob, jobsFor } from "./core/jobs.js";
import { getCrawlSettings, setCrawlSettings, startCrawl, startPriceUpdate } from "./core/grocery-jobs.js";
import { scheduleFor } from "./core/schedule.js";
import {
  applyLookup, clearNutrition, listNutritionItems, lookupItem, NUTRITION_SCOPE, nutritionCounts, startNutritionFill,
} from "./modules/groceries/nutrition/index.js";
import { usdaConfigured } from "./modules/groceries/nutrition/usda.js";
import { getExtension, listExtensions, runners } from "./scraper/engine.js";
import { clearCooldown, pacerStatus } from "./scraper/pacer.js";
import {
  clearQueue, enqueueFill, enqueueManual, getPreview, runQueue, scrapeCounts, workerStatus,
} from "./scraper/grocery-worker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

loadConnections();

await app.register(fastifyStatic, {
  root: path.join(__dirname, "..", "public"),
  // Always revalidate, so the browser picks up a new app.js right after a deploy.
  cacheControl: false,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
});

/* ---------- Serializers (modules contain functions, so send plain data) ---------- */

const moduleInfo = (m: ScraperModule) => ({
  id: m.id,
  name: m.name,
  description: m.description,
  method: m.method,
  status: m.status(),
  canFindLocations: Boolean(m.findLocations),
  canSearch: Boolean(m.searchProducts),
  canSave: Boolean(m.getProductDetails),
  kind: m.kind ?? "store",
  webExtension: m.webExtension ?? null,
});

const categoryInfo = (c: Category) => ({
  id: c.id,
  name: c.name,
  description: c.description,
  icon: c.icon,
  moduleCount: c.modules.length,
  readyCount: c.modules.filter((m) => m.status() === "ready").length,
});

/* ---------- API ---------- */

app.get("/api/health", async () => ({ ok: true }));

app.get("/api/categories", async () => categories.map(categoryInfo));

app.get<{ Params: { cat: string } }>("/api/categories/:cat", async (req, reply) => {
  const c = findCategory(req.params.cat);
  if (!c) return reply.code(404).send({ error: "Category not found" });
  return { ...categoryInfo(c), modules: c.modules.map(moduleInfo) };
});

app.get<{ Params: { cat: string; mod: string } }>(
  "/api/categories/:cat/modules/:mod",
  async (req, reply) => {
    const m = findModule(req.params.cat, req.params.mod);
    if (!m) return reply.code(404).send({ error: "Module not found" });
    return moduleInfo(m);
  },
);

app.get<{ Params: { cat: string; mod: string }; Querystring: { zip?: string } }>(
  "/api/categories/:cat/modules/:mod/locations",
  async (req, reply) => {
    const m = findModule(req.params.cat, req.params.mod);
    if (!m?.findLocations) return reply.code(404).send({ error: "Not supported" });
    if (m.status() !== "ready") return reply.code(400).send({ error: "Module is not configured" });
    const zip = (req.query.zip ?? "").trim();
    if (!/^\d{5}$/.test(zip)) return reply.code(400).send({ error: "Enter a 5-digit ZIP code" });
    return m.findLocations(zip);
  },
);

app.get<{
  Params: { cat: string; mod: string };
  Querystring: { q?: string; locationId?: string; limit?: string; start?: string };
}>("/api/categories/:cat/modules/:mod/search", async (req, reply) => {
  const m = findModule(req.params.cat, req.params.mod);
  if (!m?.searchProducts) return reply.code(404).send({ error: "Not supported" });
  if (m.status() !== "ready") return reply.code(400).send({ error: "Module is not configured" });
  const term = (req.query.q ?? "").trim();
  if (term.length < 2) return reply.code(400).send({ error: "Search term is too short" });
  return m.searchProducts({
    term,
    locationId: req.query.locationId,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    start: req.query.start ? Number(req.query.start) : undefined,
  });
});

/* ---------- Database: save scraped items ---------- */

app.get("/api/db/status", async () => {
  if (!dbConfigured()) return { configured: false };
  const table = currentTable();
  return { configured: true, table, historyTable: historyTableName(table), createSql: createTableSql(table).trim() };
});

/** Run async work over a list with limited parallelism (be polite to store APIs). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

type SaveBody = { productIds?: string[]; locationId?: string };

app.post<{ Params: { cat: string; mod: string }; Body: SaveBody }>(
  "/api/categories/:cat/modules/:mod/save",
  async (req) => {
    const m = findModule(req.params.cat, req.params.mod);
    if (!m?.getProductDetails) throw new HttpError(404, "This module can't save items yet");
    if (m.status() !== "ready") throw new HttpError(400, "Module is not configured");
    if (!dbConfigured()) throw new HttpError(400, "PostgreSQL is not configured. Add it in Settings → Connections.");

    const ids = [...new Set((req.body?.productIds ?? []).map(String).filter(Boolean))];
    if (!ids.length) throw new HttpError(400, "No products selected");
    if (ids.length > 50) throw new HttpError(400, "Save at most 50 products at a time");

    // Fetch full details per product (nutrition, ingredients...), then write in one transaction.
    const results = await mapLimit(ids, 4, async (id) => {
      try {
        return { id, item: await m.getProductDetails!(id, req.body.locationId) };
      } catch (e) {
        return { id, error: (e as Error).message };
      }
    });
    const ok = results.filter((r) => r.item).map((r) => r.item!);
    const saved = await saveItems(ok);
    return {
      saved: ok.map((p) => p.productId),
      withNutrition: ok.filter((p) => p.nutrition?.nutrients.length).length,
      withIngredients: ok.filter((p) => p.ingredients).length,
      pricePoints: saved.pricePoints,
      failed: results.filter((r) => r.error).map((r) => ({ productId: r.id, error: r.error })),
    };
  },
);

app.post<{ Params: { cat: string; mod: string }; Body: { productIds?: string[] } }>(
  "/api/categories/:cat/modules/:mod/saved",
  async (req) => {
    if (!dbConfigured()) return { configured: false, saved: [] };
    try {
      return { configured: true, saved: await savedIds(req.params.mod, (req.body?.productIds ?? []).map(String)) };
    } catch (e) {
      return { configured: true, saved: [], error: (e as Error).message };
    }
  },
);

// Untouched store response for one product: handy for seeing which fields exist.
app.get<{ Params: { cat: string; mod: string; id: string }; Querystring: { locationId?: string } }>(
  "/api/categories/:cat/modules/:mod/raw/:id",
  async (req) => {
    const m = findModule(req.params.cat, req.params.mod);
    if (!m?.getRawProduct) throw new HttpError(404, "Not supported");
    if (m.status() !== "ready") throw new HttpError(400, "Module is not configured");
    return m.getRawProduct(req.params.id, req.query.locationId);
  },
);

/* ---------- Bulk jobs: crawl + price update ---------- */

type ModParams = { cat: string; mod: string };

function requireReadyModule(p: ModParams) {
  const m = findModule(p.cat, p.mod);
  if (!m) throw new HttpError(404, "Module not found");
  if (m.status() !== "ready") throw new HttpError(400, "Module is not configured");
  return m;
}

app.get<{ Params: ModParams }>("/api/categories/:cat/modules/:mod/jobs", async (req) => {
  const m = findModule(req.params.cat, req.params.mod);
  if (!m) throw new HttpError(404, "Module not found");
  const scope = `${req.params.cat}/${req.params.mod}`;
  let savedCount: number | null = null;
  if (dbConfigured()) savedCount = await countStoreItems(m.id).catch(() => null);
  return {
    ...jobsFor(scope),
    canCrawl: Boolean(m.crawl && m.searchProducts),
    canUpdatePrices: Boolean(m.refreshPrices),
    usage: m.crawl?.dailyCalls() ?? null,
    crawl: m.crawl ? { ...getCrawlSettings(scope), pageSize: m.crawl.pageSize, maxPages: m.crawl.maxPages } : null,
    dbConfigured: dbConfigured(),
    savedCount,
    schedule: scheduleFor(scope),
  };
});

app.put<{ Params: ModParams; Body: { terms?: string[]; pagesPerTerm?: number } }>(
  "/api/categories/:cat/modules/:mod/crawl-settings",
  async (req) => {
    const m = findModule(req.params.cat, req.params.mod);
    if (!m?.crawl) throw new HttpError(404, "Not supported");
    return setCrawlSettings(
      `${req.params.cat}/${req.params.mod}`,
      { terms: req.body?.terms ?? [], pagesPerTerm: Number(req.body?.pagesPerTerm ?? 1) },
      m.crawl.maxPages,
    );
  },
);

app.post<{ Params: ModParams; Body: { locationId?: string } }>(
  "/api/categories/:cat/modules/:mod/jobs/crawl",
  async (req, reply) => {
    const m = requireReadyModule(req.params);
    if (!dbConfigured()) throw new HttpError(400, "PostgreSQL is not configured. Add it in Settings → Connections.");
    const job = startCrawl(`${req.params.cat}/${req.params.mod}`, m, req.body?.locationId || "");
    return reply.code(202).send(job);
  },
);

app.post<{ Params: ModParams; Body: { locationId?: string } }>(
  "/api/categories/:cat/modules/:mod/jobs/prices",
  async (req, reply) => {
    const m = requireReadyModule(req.params);
    if (!dbConfigured()) throw new HttpError(400, "PostgreSQL is not configured. Add it in Settings → Connections.");
    const job = startPriceUpdate(`${req.params.cat}/${req.params.mod}`, m, m.id, req.body?.locationId || undefined);
    return reply.code(202).send(job);
  },
);

app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (req) => {
  cancelJob(req.params.id);
  return { ok: true };
});

/* ---------- Nutrition (USDA FoodData / Open Food Facts) ---------- */

function requireDb() {
  if (!dbConfigured()) throw new HttpError(400, "PostgreSQL is not configured. Add it in Settings → Connections.");
}

app.get("/api/nutrition/status", async () => {
  if (!dbConfigured()) return { dbConfigured: false, usdaConfigured: usdaConfigured() };
  return {
    dbConfigured: true,
    usdaConfigured: usdaConfigured(),
    counts: await nutritionCounts(),
    ...jobsFor(NUTRITION_SCOPE),
    schedule: scheduleFor(NUTRITION_SCOPE),
  };
});

app.get<{ Querystring: { filter?: "missing" | "has" | "all"; store?: string; q?: string; page?: string } }>(
  "/api/nutrition/items",
  async (req) => {
    requireDb();
    return listNutritionItems({
      filter: req.query.filter ?? "missing",
      store: req.query.store || undefined,
      q: req.query.q?.trim() || undefined,
      page: Number(req.query.page ?? 1),
    });
  },
);

app.post<{ Params: { id: string } }>("/api/nutrition/items/:id/lookup", async (req) => {
  requireDb();
  return lookupItem(req.params.id);
});

app.post<{ Params: { id: string }; Body: { source?: "usda" | "off" } }>("/api/nutrition/items/:id/apply", async (req) => {
  requireDb();
  if (req.body?.source !== "usda" && req.body?.source !== "off") throw new HttpError(400, "source must be usda or off");
  return applyLookup(req.params.id, req.body.source);
});

app.post<{ Params: { id: string } }>("/api/nutrition/items/:id/clear", async (req) => {
  requireDb();
  await clearNutrition(req.params.id);
  return { ok: true };
});

app.post<{ Body: { store?: string } }>("/api/nutrition/jobs/fill", async (req, reply) => {
  requireDb();
  return reply.code(202).send(startNutritionFill(req.body?.store || undefined));
});

/* ---------- Activity: everything running right now (home page) ---------- */

/** "groceries/kroger-web" -> where it lives in the UI. */
function scopeInfo(scope: string) {
  const [catId, id] = scope.split("/");
  const cat = findCategory(catId);
  const mod = cat?.modules.find((m) => m.id === id);
  if (mod) return { label: mod.name, area: cat!.name, href: `#/c/${catId}/${mod.id}` };
  const ext = getExtension(id);
  if (ext) {
    const owner = cat?.modules.find((m) => m.webExtension === ext.id);
    return { label: `${owner?.name ?? ext.name} · Scraper`, area: cat?.name ?? "", href: `#/c/${catId}/${owner?.id ?? ""}/scraper` };
  }
  return { label: scope, area: "", href: "#/" };
}

app.get("/api/activity", async () => {
  const recentMs = 10 * 60 * 1000;
  const jobs = allJobs()
    .filter((j) => j.status === "running" || (j.finishedAt && Date.now() - Date.parse(j.finishedAt) < recentMs))
    .map((j) => {
      const ext = getExtension(j.scope.split("/")[1]);
      return {
        id: j.id, type: j.type, status: j.status, progress: j.progress, stats: j.stats,
        message: j.message, startedAt: j.startedAt, finishedAt: j.finishedAt,
        lastLog: j.log[j.log.length - 1] ?? null,
        where: scopeInfo(j.scope),
        nextPageAt: ext && j.status === "running" ? pacerStatus(ext.id, ext.pacing).nextAt : null,
      };
    });
  const paused = listExtensions()
    .map((ext) => ({ ext, p: pacerStatus(ext.id, ext.pacing), w: workerStatus(ext) }))
    .filter((x) => x.p.cooldownUntil)
    .map((x) => ({
      where: scopeInfo(`groceries/${x.ext.id}`),
      until: x.p.cooldownUntil, reason: x.p.cooldownReason, queued: x.w.queueLength,
    }));
  return { jobs, paused };
});

/* ---------- Website scraper (per extension, e.g. kroger-web) ---------- */

function requireExtension(id: string) {
  const ext = getExtension(id);
  if (!ext) throw new HttpError(404, "Scraper extension not found");
  return ext;
}
const apiModuleFor = (store: string) =>
  categories.flatMap((c) => c.modules).find((m) => m.id === store && (m.kind ?? "store") === "store");

app.get<{ Params: { ext: string } }>("/api/scraper/:ext", async (req) => {
  const ext = requireExtension(req.params.ext);
  const runner = runners[ext.runner];
  const scope = `groceries/${ext.id}`;
  return {
    id: ext.id,
    name: ext.name,
    store: ext.store,
    ownsPrices: Boolean(ext.ownsPrices),
    priceStore: ext.priceStore?.() ?? null,
    runner: { id: runner.id, name: runner.name, ready: runner.ready() },
    pacer: pacerStatus(ext.id, ext.pacing),
    counts: await scrapeCounts(ext.store).catch(() => null),
    dbConfigured: dbConfigured(),
    apiReady: apiModuleFor(ext.store)?.status() === "ready",
    ...workerStatus(ext),
    ...jobsFor(scope),
    schedule: scheduleFor(scope),
  };
});

app.post<{ Params: { ext: string }; Body: { input?: string; dryRun?: boolean; locationId?: string } }>(
  "/api/scraper/:ext/add",
  async (req, reply) => {
    const ext = requireExtension(req.params.ext);
    const input = (req.body?.input ?? "").trim();
    if (!input) throw new HttpError(400, "Enter a product URL, product ID, or UPC");
    const r = await enqueueManual(ext, input, {
      dryRun: Boolean(req.body?.dryRun),
      apiModule: apiModuleFor(ext.store),
      locationId: req.body?.locationId || undefined,
    });
    return reply.code(202).send(r);
  },
);

app.post<{ Params: { ext: string }; Body: { limit?: number; replaceOther?: boolean; mode?: "missing" | "refresh" } }>(
  "/api/scraper/:ext/fill",
  async (req, reply) => {
    const ext = requireExtension(req.params.ext);
    const r = await enqueueFill(ext, {
      limit: Number(req.body?.limit ?? 50),
      replaceOther: Boolean(req.body?.replaceOther),
      mode: req.body?.mode === "refresh" ? "refresh" : "missing",
    });
    return reply.code(202).send(r);
  },
);

app.post<{ Params: { ext: string }; Body: { kind?: "fill" | "manual" } }>("/api/scraper/:ext/queue/clear", async (req) => {
  return clearQueue(requireExtension(req.params.ext), req.body?.kind);
});

app.post<{ Params: { ext: string } }>("/api/scraper/:ext/run", async (req, reply) => {
  return reply.code(202).send(runQueue(requireExtension(req.params.ext)));
});

app.post<{ Params: { ext: string } }>("/api/scraper/:ext/cooldown/clear", async (req) => {
  const ext = requireExtension(req.params.ext);
  clearCooldown(ext.id);
  return { ok: true };
});

app.get<{ Params: { ext: string; id: string } }>("/api/scraper/:ext/preview/:id", async (req) => {
  const p = getPreview(requireExtension(req.params.ext), req.params.id);
  if (!p) throw new HttpError(404, "No preview for that product (run a dry run first)");
  return p;
});

/* ---------- Settings -> Connections ---------- */

// Provider definitions drive the dynamic form in the UI (no secrets here).
app.get("/api/connections/providers", async () =>
  listProviders().map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    description: p.description,
    docsUrl: p.docsUrl,
    canTest: Boolean(p.test),
    fields: p.fields.map(({ key, label, type, required, placeholder, help }) => ({
      key, label, type, required: Boolean(required), placeholder, help,
    })),
  })),
);

app.get("/api/connections", async () => ({
  connections: listSaved().map(publicView),
  envOnly: envOnlyProviders(),
}));

type ConnBody = { providerId: string; name?: string; enabled?: boolean; values?: Record<string, string> };

app.post<{ Body: ConnBody }>("/api/connections", async (req, reply) => {
  const b = req.body ?? ({} as ConnBody);
  const conn = upsertConnection({ providerId: b.providerId, name: b.name, enabled: b.enabled, values: b.values ?? {} });
  return reply.code(201).send(publicView(conn));
});

app.put<{ Params: { id: string }; Body: ConnBody }>("/api/connections/:id", async (req) => {
  const existing = getSaved(req.params.id);
  if (!existing) throw new HttpError(404, "Connection not found");
  const b = req.body ?? ({} as ConnBody);
  const conn = upsertConnection({
    id: existing.id,
    providerId: existing.providerId,
    name: b.name ?? existing.name,
    enabled: b.enabled,
    values: b.values ?? existing.values,
  });
  return publicView(conn);
});

app.delete<{ Params: { id: string } }>("/api/connections/:id", async (req, reply) => {
  deleteConnection(req.params.id);
  return reply.code(204).send();
});

// Test before or after saving: blank secret fields fall back to the saved value.
app.post<{ Body: { providerId: string; values?: Record<string, string> } }>(
  "/api/connections/test",
  async (req) => {
    const provider = getProvider(req.body?.providerId);
    if (!provider?.test) throw new HttpError(400, "This connection can't be tested");
    const saved = getSaved(provider.id);
    const values: Record<string, string> = {};
    for (const f of provider.fields) {
      values[f.key] = (req.body.values?.[f.key] ?? "").trim() || saved?.values[f.key] || "";
    }
    try {
      return { ok: true, message: await provider.test(values) };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },
);

/* Turn upstream errors into readable JSON for the UI. */
app.setErrorHandler((err: Error & { status?: number; statusCode?: number }, _req, reply) => {
  const code = err.statusCode ?? (err.status && err.status >= 400 ? 502 : 500);
  if (code < 500) app.log.warn(err.message);
  else app.log.error(err);
  reply.code(code).send({ error: err.message });
});

await app.listen({ port: config.port, host: config.host });
