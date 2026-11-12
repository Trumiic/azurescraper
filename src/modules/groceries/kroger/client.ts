/**
 * Minimal client for Kroger's official public API (developer.kroger.com).
 *
 * Auth: OAuth2 "client credentials" grant -> short-lived Bearer token.
 * Credentials come from Settings -> Connections (env vars as fallback).
 * Prices / stock are only returned when filter.locationId (a store) is sent.
 */
import { config } from "../../../config.js";
import { resolveValues } from "../../../core/connections.js";

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

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await getToken()}`, Accept: "application/json" },
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
