/**
 * Connections = saved API keys / credentials for any service.
 *
 * - Built-in providers (Kroger, ...) declare their fields in `providers` below;
 *   the Settings UI renders a form from that list, so adding a provider here is
 *   all it takes to make it show up in the dropdown.
 * - "Custom" connections let the user store any name + key/value pairs for
 *   future modules that don't have a provider entry yet.
 *
 * Stored in DATA_DIR/connections.json (file mode 600). Secret values are never
 * sent back to the browser, only a masked preview.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export type FieldType = "text" | "secret";

export interface ProviderField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  /** Environment variable used as a fallback when nothing is saved. */
  env?: string;
}

export interface Provider {
  id: string;
  name: string;
  category: string;
  description: string;
  docsUrl?: string;
  fields: ProviderField[];
  /** Optional live check: throws with a readable message on failure. */
  test?: (values: Record<string, string>) => Promise<string>;
}

export interface SavedConnection {
  id: string;          // provider id, or "custom-<slug>"
  providerId: string;  // provider id, or "custom"
  name: string;
  enabled: boolean;
  values: Record<string, string>;
  updatedAt: string;
}

/* ---------- Provider registry ---------- */

const providers = new Map<string, Provider>();

export function registerProvider(p: Provider) {
  providers.set(p.id, p);
}
export function listProviders(): Provider[] {
  return [...providers.values()];
}
export function getProvider(id: string) {
  return providers.get(id);
}

/* ---------- Storage ---------- */

const file = () => path.join(config.dataDir, "connections.json");
let saved: Record<string, SavedConnection> = {};

export function loadConnections() {
  try {
    saved = JSON.parse(fs.readFileSync(file(), "utf8")).connections ?? {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    saved = {};
  }
}

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ connections: saved }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file()); // atomic replace
}

export function listSaved(): SavedConnection[] {
  return Object.values(saved).sort((a, b) => a.name.localeCompare(b.name));
}
export function getSaved(id: string) {
  return saved[id];
}

export function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/**
 * Create or update. Blank secret values mean "keep the existing value",
 * so the UI can save without ever knowing the real secret.
 */
export function upsertConnection(input: {
  id?: string;
  providerId: string;
  name?: string;
  enabled?: boolean;
  values: Record<string, string>;
}): SavedConnection {
  const provider = getProvider(input.providerId);
  const isCustom = input.providerId === "custom";
  if (!provider && !isCustom) throw new HttpError(400, "Unknown provider");

  let id: string;
  if (isCustom) {
    const name = (input.name ?? "").trim();
    if (!name) throw new HttpError(400, "Name is required");
    id = input.id && saved[input.id] ? input.id : `custom-${slugify(name)}`;
    if (!input.id && saved[id]) throw new HttpError(409, "A connection with that name already exists");
  } else {
    id = provider!.id;
  }

  const prev = saved[id];
  const values: Record<string, string> = {};

  if (isCustom) {
    for (const [rawKey, rawVal] of Object.entries(input.values)) {
      const key = rawKey.trim();
      if (!key) continue;
      const val = String(rawVal ?? "");
      values[key] = val === "" && prev?.values[key] !== undefined ? prev.values[key] : val;
    }
  } else {
    for (const f of provider!.fields) {
      const incoming = String(input.values[f.key] ?? "").trim();
      const keep = f.type === "secret" && incoming === "" && prev?.values[f.key];
      values[f.key] = keep ? prev!.values[f.key] : incoming;
      if (f.required && !values[f.key]) throw new HttpError(400, `${f.label} is required`);
    }
  }

  const conn: SavedConnection = {
    id,
    providerId: input.providerId,
    name: isCustom ? input.name!.trim() : provider!.name,
    enabled: input.enabled ?? prev?.enabled ?? true,
    values,
    updatedAt: new Date().toISOString(),
  };
  saved[id] = conn;
  persist();
  return conn;
}

export function deleteConnection(id: string) {
  if (!saved[id]) throw new HttpError(404, "Connection not found");
  delete saved[id];
  persist();
}

/**
 * What modules call to get their credentials:
 * saved + enabled connection first, then environment variables.
 */
export function resolveValues(providerId: string): Record<string, string> {
  const provider = getProvider(providerId);
  const conn = saved[providerId];
  const out: Record<string, string> = {};
  for (const f of provider?.fields ?? []) {
    const fromSaved = conn?.enabled ? conn.values[f.key] : "";
    out[f.key] = fromSaved || (f.env ? process.env[f.env] ?? "" : "");
  }
  return out;
}

/* ---------- Safe view for the browser ---------- */

const mask = (v: string) => (v.length > 8 ? `••••${v.slice(-4)}` : "••••");

export function publicView(c: SavedConnection) {
  const provider = getProvider(c.providerId);
  const fields = provider
    ? provider.fields.map((f) => ({
        key: f.key,
        isSet: Boolean(c.values[f.key]),
        value: f.type === "secret" ? "" : c.values[f.key] ?? "",
        preview: f.type === "secret" && c.values[f.key] ? mask(c.values[f.key]) : undefined,
      }))
    : Object.entries(c.values).map(([key, v]) => ({
        key,
        isSet: Boolean(v),
        value: "",
        preview: v ? mask(v) : undefined,
      }));
  return {
    id: c.id,
    providerId: c.providerId,
    providerName: provider?.name ?? "Custom API",
    name: c.name,
    enabled: c.enabled,
    updatedAt: c.updatedAt,
    canTest: Boolean(provider?.test),
    fields,
  };
}

/** Providers configured only through env vars (shown as read-only in the UI). */
export function envOnlyProviders() {
  return listProviders()
    .filter((p) => !saved[p.id] && p.fields.some((f) => f.required && f.env && process.env[f.env]))
    .map((p) => ({ id: p.id, name: p.name }));
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}
