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

/**
 * Barcodes to try for a stored item_upc, best guess first.
 * Returns [] for things that can't be retail barcodes (e.g. produce PLUs).
 */
export function barcodeCandidates(raw: string | null | undefined, store?: string): string[] {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return [];
  const out: string[] = [];
  const add = (c: string) => { if (!out.includes(c)) out.push(c); };

  if (store === "kroger" && digits.length === 13 && digits.startsWith("00")) {
    const body = digits.slice(2);                   // 11 digits, no check digit
    if (/^0{6,}/.test(body)) return [];             // PLU / random-weight codes, e.g. bananas
    const upcA = body + gs1CheckDigit(body);        // 12-digit UPC-A
    add(upcA);
    add("0" + upcA);                                // same code as EAN-13
  }
  // Already a complete barcode (other stores, or Kroger ids that happen to be valid)
  if (isValidGtin(digits)) {
    add(digits);
    if (digits.length === 13 && digits.startsWith("0")) add(digits.slice(1));
    if (digits.length === 12) add("0" + digits);
  }
  return out;
}

/** Compare barcodes ignoring leading zeros (USDA stores 12 or 14 digit forms). */
export const sameBarcode = (a: string, b: string) => a.replace(/^0+/, "") === b.replace(/^0+/, "");
