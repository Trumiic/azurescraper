/**
 * PostgreSQL access. Credentials come from Settings -> Connections -> PostgreSQL
 * (env vars PGHOST, PGPORT, ... as fallback). The pool is rebuilt automatically
 * when the saved connection changes.
 */
import pg from "pg";
import { registerProvider, resolveValues } from "./connections.js";

registerProvider({
  id: "postgres",
  name: "PostgreSQL",
  category: "Databases",
  description: "Database that scraped grocery items are saved to (shared with the grocery app).",
  fields: [
    { key: "host", label: "Host", type: "text", required: true, placeholder: "e.g. 192.168.1.76", env: "PGHOST" },
    { key: "port", label: "Port", type: "text", placeholder: "5432", env: "PGPORT" },
    { key: "database", label: "Database", type: "text", required: true, placeholder: "e.g. grocery", env: "PGDATABASE" },
    { key: "user", label: "User", type: "text", required: true, env: "PGUSER" },
    { key: "password", label: "Password", type: "secret", required: true, env: "PGPASSWORD" },
    {
      key: "table",
      label: "Items table",
      type: "text",
      placeholder: "grocery_items",
      help: "Created automatically on first save if it doesn't exist.",
    },
    { key: "ssl", label: "SSL", type: "text", placeholder: "off", help: "\"on\" to require SSL. Usually off on a LAN." },
  ],
  async test(values) {
    const pool = makePool(values);
    try {
      const v = await pool.query<{ v: string }>("select current_setting('server_version') as v");
      const table = tableName(values.table);
      const t = await pool.query<{ n: string | null }>("select to_regclass($1) as n", [table]);
      let tableMsg = `table "${table}" will be created on first save`;
      if (t.rows[0].n) {
        const c = await pool.query<{ c: string }>(`select count(*)::text as c from ${quoteIdent(table)}`);
        tableMsg = `table "${table}" has ${c.rows[0].c} items`;
      }
      return `Connected to PostgreSQL ${v.rows[0].v}; ${tableMsg}`;
    } finally {
      await pool.end();
    }
  },
});

/* ---------- Helpers ---------- */

export function tableName(raw?: string) {
  const t = (raw || "grocery_items").trim();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(t)) {
    throw new Error("Items table name may only contain lowercase letters, numbers and _");
  }
  return t;
}
export const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

function makePool(v: Record<string, string>) {
  return new pg.Pool({
    host: v.host,
    port: Number(v.port || 5432),
    database: v.database,
    user: v.user,
    password: v.password,
    ssl: /^(on|true|require|yes)$/i.test(v.ssl ?? "") ? { rejectUnauthorized: false } : undefined,
    max: 5,
    connectionTimeoutMillis: 5000,
  });
}

let current: { key: string; pool: pg.Pool } | null = null;

export function dbConfigured(): boolean {
  const v = resolveValues("postgres");
  return Boolean(v.host && v.database && v.user);
}

/** Pool for the currently saved connection (recreated if it changed). */
export function getPool(): pg.Pool {
  const v = resolveValues("postgres");
  if (!dbConfigured()) throw Object.assign(new Error("PostgreSQL is not configured. Add it in Settings → Connections."), { statusCode: 400 });
  const key = JSON.stringify(v);
  if (current?.key !== key) {
    current?.pool.end().catch(() => {});
    current = { key, pool: makePool(v) };
  }
  return current.pool;
}

export function currentTable() {
  return tableName(resolveValues("postgres").table);
}
