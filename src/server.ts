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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

loadConnections();

await app.register(fastifyStatic, { root: path.join(__dirname, "..", "public") });

/* ---------- Serializers (modules contain functions, so send plain data) ---------- */

const moduleInfo = (m: ScraperModule) => ({
  id: m.id,
  name: m.name,
  description: m.description,
  method: m.method,
  status: m.status(),
  canFindLocations: Boolean(m.findLocations),
  canSearch: Boolean(m.searchProducts),
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
