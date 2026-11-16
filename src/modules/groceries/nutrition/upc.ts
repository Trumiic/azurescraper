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
