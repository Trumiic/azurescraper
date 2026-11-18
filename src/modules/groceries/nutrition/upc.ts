/**
 * Barcode helpers.
 *
 * Kroger product ids are 13 digits: "00" + the first 11 digits of the UPC-A,
 * WITHOUT the check digit. Example: Kroger 0001111081533 = UPC-A 011110815330.
 * USDA and Open Food Facts need the real barcode (with check digit).
 */

/** GS1 mod-10 check digit for any payload length. */
export function gs1CheckDigit(payload: string): number {
  let sum = 0;
  // rightmost payload digit is weighted 3, then alternate 1, 3, ...
  for (let i = 0; i < payload.length; i++) {
    const d = Number(payload[payload.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidGtin(code: string): boolean {
  return /^\d{8,14}$/.test(code) && gs1CheckDigit(code.slice(0, -1)) === Number(code.slice(-1));
}

export type SkipReason = "produce" | "variable-weight" | "in-store" | "no-upc";

export const SKIP_LABEL: Record<SkipReason, string> = {
  "produce": "produce code (PLU), no retail barcode",
  "variable-weight": "packed in store by weight (meat, deli, bakery), no retail barcode",
  "in-store": "store-internal code, no retail barcode",
  "no-upc": "no barcode saved for this item",
};

/**
 * Barcodes to try for a stored item_upc (best guess first), or why there are none.
 *
 * UPC-A number system (first digit) matters:
 *   2 = variable-weight items priced in store (meat, deli, cheese counter)
 *   4 = store-internal codes (loyalty, coupons, in-store items)
 * Neither exists in USDA or Open Food Facts, so they are skipped.
 */
export function classifyBarcode(
  raw: string | null | undefined,
  store?: string,
): { barcodes: string[]; skip?: SkipReason } {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return { barcodes: [], skip: "no-upc" };
  const out: string[] = [];
  const add = (c: string) => { if (!out.includes(c)) out.push(c); };

  let upcA: string | undefined;
  if (store === "kroger" && digits.length === 13 && digits.startsWith("00")) {
    const body = digits.slice(2);                   // 11 digits, no check digit
    if (/^0{6,}/.test(body)) return { barcodes: [], skip: "produce" };
    upcA = body + gs1CheckDigit(body);              // 12-digit UPC-A
  } else if (digits.length === 12 && isValidGtin(digits)) {
    upcA = digits;
  } else if (digits.length === 13 && digits.startsWith("0") && isValidGtin(digits)) {
    upcA = digits.slice(1);
  }

  if (upcA) {
    if (upcA[0] === "2") return { barcodes: [], skip: "variable-weight" };
    if (upcA[0] === "4") return { barcodes: [], skip: "in-store" };
    add(upcA);
    add("0" + upcA);                                // same code as EAN-13
  } else if (isValidGtin(digits)) {
    add(digits);                                    // EAN-13 / GTIN-14 from outside the US
  }
  return out.length ? { barcodes: out } : { barcodes: [], skip: "no-upc" };
}

export function barcodeCandidates(raw: string | null | undefined, store?: string): string[] {
  return classifyBarcode(raw, store).barcodes;
}

/** Compare barcodes ignoring leading zeros (USDA stores 12 or 14 digit forms). */
export const sameBarcode = (a: string, b: string) => a.replace(/^0+/, "") === b.replace(/^0+/, "");

/**
 * The one standard barcode stored per item (grocery_items.item_gtin): GTIN-14
 * with the check digit computed, so the same product matches across stores
 * no matter how each store writes its UPC.
 *
 *   Kroger  "0001111040101"  ("00" + UPC-A without check digit)
 *   Meijer  "4125010200"     (UPC-A without check digit, leading zeros dropped)
 *   others  "041250102007"   (full UPC-A / EAN-13 with check digit)
 *
 * Returns null for codes that aren't real product barcodes and must never be
 * matched across stores: produce PLUs, variable-weight items packed in store
 * (UPC starting with 2) and store-internal codes (starting with 4).
 */
export function toGtin14(store: string | undefined, raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  if (!d) return null;
  let upcA: string | undefined;

  if (store === "kroger" && d.length === 13 && d.startsWith("00")) {
    const body = d.slice(2);                         // 11 digits, no check digit
    if (/^0{6,}/.test(body)) return null;            // PLU (e.g. bananas 4011)
    upcA = body + gs1CheckDigit(body);
  } else if (store === "meijer" && d.length <= 11) {
    if (d.length <= 5) return null;                  // PLU
    const body = d.padStart(11, "0");                // UPC-A without check digit
    upcA = body + gs1CheckDigit(body);
  } else if (d.length >= 8 && d.length <= 14 && isValidGtin(d)) {
    const g = d.padStart(14, "0");
    if (g.startsWith("00")) upcA = g.slice(2);       // a US UPC-A inside GTIN-14
    else return g;                                   // EAN-13 / GTIN-14 from elsewhere
  } else {
    return null;
  }
  if (upcA[0] === "2" || upcA[0] === "4") return null; // in-store / variable-weight codes
  return upcA.padStart(14, "0");
}
