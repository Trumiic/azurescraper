/**
 * Site-independent extractors, reusable by every extension.
 */
import * as cheerio from "cheerio";

export type Doc = cheerio.CheerioAPI;
export const loadHtml = (html: string): Doc => cheerio.load(html);
export const clean = (s?: string | null) => (s ?? "").replace(/\s+/g, " ").trim();

/* ---------- schema.org JSON-LD ---------- */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** All JSON-LD objects on the page, flattening arrays and @graph. */
export function jsonLd($: Doc): Obj[] {
  const out: Obj[] = [];
  const add = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(add);
    else if (isObj(v)) { out.push(v); if (Array.isArray(v["@graph"])) add(v["@graph"]); }
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try { add(JSON.parse($(el).contents().text())); } catch { /* ignore broken blocks */ }
  });
  return out;
}

export interface LdProduct {
  name?: string;
  sku?: string;
  gtin?: string;
  brand?: string;
  image?: string;
  description?: string;
  price?: number;
  url?: string;
}

/** The schema.org Product on the page, normalized. */
export function ldProduct($: Doc): LdProduct | null {
  const p = jsonLd($).find((o) => {
    const t = o["@type"];
    return t === "Product" || (Array.isArray(t) && t.includes("Product"));
  });
  if (!p) return null;
  const brand = isObj(p.brand) ? (p.brand.name as string) : (p.brand as string | undefined);
  const image = Array.isArray(p.image) ? (p.image[0] as string) : isObj(p.image) ? (p.image.url as string) : (p.image as string);
  const offers = Array.isArray(p.offers) ? p.offers : p.offers ? [p.offers] : [];
  const price = offers.map((o) => (isObj(o) ? Number(o.price ?? o.lowPrice) : NaN)).find((n) => Number.isFinite(n));
  const gtin = (p.gtin13 ?? p.gtin12 ?? p.gtin ?? p.gtin14) as string | undefined;
  return {
    name: clean(p.name as string),
    sku: p.sku ? String(p.sku) : undefined,
    gtin,
    brand,
    image,
    description: p.description ? clean(p.description as string) : undefined,
    price,
    url: p.url as string | undefined,
  };
}

/* ---------- amounts like "8g", "35mg", "<1g", "2.5 mcg" ---------- */

export function parseAmount(text: string): { amount?: number; unit?: string } {
  const m = clean(text).replace(",", "").match(/^(?:less than|<)?\s*([\d.]+)\s*([a-zA-Zµ%]*)/i);
  if (!m) return {};
  return { amount: Number(m[1]), unit: m[2] ? m[2].toLowerCase().replace("µg", "mcg") : undefined };
}

/* ---------- block / challenge pages ---------- */

const BLOCK_PATTERNS: [RegExp, string][] = [
  [/access denied/i, "Access Denied page"],
  [/pardon our interruption/i, "\"Pardon Our Interruption\" challenge"],
  [/request unsuccessful|incapsula incident/i, "bot-protection error page"],
  [/(verify|prove) (that )?you are (a )?human|are you a robot/i, "human-verification challenge"],
  [/<title>\s*(just a moment|attention required)/i, "browser challenge page"],
  [/errors\.edgesuite\.net|akamai[^"]{0,40}reference/i, "Akamai error page"],
];

/** Returns a reason if the page is a block/challenge page, else null. */
export function detectBlock(status: number, html: string): string | null {
  if (status === 403) return "HTTP 403 Forbidden";
  if (status === 429) return "HTTP 429 Too Many Requests";
  if (status === 503 && html.length < 20_000) return "HTTP 503 (likely a challenge)";
  // Only look at the start of large pages: real product pages may mention these words in scripts.
  const head = html.length > 200_000 ? html.slice(0, 60_000) : html;
  for (const [re, why] of BLOCK_PATTERNS) if (re.test(head)) return why;
  return null;
}
