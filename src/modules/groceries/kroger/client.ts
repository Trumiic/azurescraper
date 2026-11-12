/**
 * Minimal client for Kroger's official public API (developer.kroger.com).
 *
 * Auth: OAuth2 "client credentials" grant -> short-lived Bearer token.
 * Credentials come from Settings -> Connections (env vars as fallback).
 * Prices / stock are only returned when filter.locationId (a store) is sent.
 */
import { config } from "../../../config.js";
import { resolveValues } from "../../../core/connections.js";
import { BudgetExceededError, callsToday, countCall } from "../../../core/usage.js";

/** Kroger allows 10,000 Products API calls per day; keep some headroom by default. */
export const KROGER_DAILY_LIMIT = 10_000;
const DEFAULT_BUDGET = 8_000;
const USAGE_KEY = (path: string) => (path.startsWith("/locations") ? "kroger.locations" : "kroger.products");

export function krogerBudget(): number {
  const n = Number(resolveValues("kroger").dailyBudget);
  return n > 0 ? Math.min(n, KROGER_DAILY_LIMIT) : DEFAULT_BUDGET;
}

export function krogerUsage() {
  const used = callsToday("kroger.products");
  const budget = krogerBudget();
  return { used, budget, remaining: Math.max(0, budget - used), limit: KROGER_DAILY_LIMIT };
}

export interface KrogerCreds {
  clientId: string;
  clientSecret: string;
  locationId?: string;
}

interface TokenCache {
  credKey: string; // token is tied to these exact credentials
  token: string;
  expiresAt: number;
}

let cache: TokenCache | null = null;

export class KrogerApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export function krogerCreds(): KrogerCreds {
  const v = resolveValues("kroger");
  return { clientId: v.clientId, clientSecret: v.clientSecret, locationId: v.locationId };
}

export function krogerConfigured(): boolean {
  const c = krogerCreds();
  return Boolean(c.clientId && c.clientSecret);
}

/** Fetch a token. Pass creds explicitly to test unsaved values. */
export async function fetchToken(creds: KrogerCreds): Promise<{ token: string; expiresIn: number }> {
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  const res = await fetch(`${config.kroger.baseUrl}/connect/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "product.compact" }),
  });
  if (!res.ok) {
    throw new KrogerApiError(`Kroger auth failed (${res.status}): ${await res.text()}`, res.status);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  return { token: json.access_token, expiresIn: json.expires_in };
}

async function getToken(): Promise<string> {
  const creds = krogerCreds();
  const credKey = `${creds.clientId}:${creds.clientSecret}`;
  if (cache && cache.credKey === credKey && Date.now() < cache.expiresAt - 60_000) {
    return cache.token;
  }
  const { token, expiresIn } = await fetchToken(creds);
  cache = { credKey, token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

/** GET helper: builds the query string, adds the token, retries once on 401. */
export async function krogerGet<T>(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const url = `${config.kroger.baseUrl}${path}?${qs}`;
  const key = USAGE_KEY(path);
  if (key === "kroger.products" && callsToday(key) >= krogerBudget()) {
    throw new BudgetExceededError(
      `Daily Kroger API budget reached (${krogerBudget()} calls). It resets at midnight UTC; change it in Settings → Connections → Kroger.`,
    );
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken();
    countCall(key);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (res.status === 401 && attempt === 0) {
      cache = null; // token expired or revoked: fetch a new one and retry
      continue;
    }
    if (!res.ok) {
      throw new KrogerApiError(`Kroger API ${path} failed (${res.status}): ${await res.text()}`, res.status);
    }
    return (await res.json()) as T;
  }
  throw new KrogerApiError("Kroger API unauthorized", 401);
}
