/**
 * Next.js (App Router) pages ship their server data in
 *   <script>self.__next_f.push([1,"..."])</script>
 * blocks. These helpers join those strings and pull JSON objects out of them,
 * so extensions can read structured data instead of on-screen text.
 * Only data is parsed; no page code is executed.
 */

export function decodeNextFlight(html: string): string {
  let out = "";
  const re = /self\.__next_f\.push\((\[[\s\S]*?\])\)\s*<\/script>/g;
  for (const m of html.matchAll(re)) {
    try {
      const arr = JSON.parse(m[1]);
      if (typeof arr[1] === "string") out += arr[1];
    } catch { /* not a data block */ }
  }
  return out;
}

/** Text of the balanced {...} object starting at `start`, or null. */
function objectAt(text: string, start: number): string | null {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/**
 * Find JSON objects in `text` that contain `marker` (e.g. '"nutritionLabelMain"')
 * and satisfy `accept`. Walks outward from each marker to the nearest enclosing
 * object that parses.
 */
export function findObjects<T = Record<string, unknown>>(
  text: string,
  marker: string,
  accept: (o: Record<string, unknown>) => boolean,
  limit = 5,
): T[] {
  const found: T[] = [];
  let from = 0;
  while (found.length < limit) {
    const at = text.indexOf(marker, from);
    if (at < 0) break;
    from = at + marker.length;
    // try enclosing '{' positions moving left, nearest first
    let tries = 0;
    for (let s = text.lastIndexOf("{", at); s >= 0 && tries < 300; s = text.lastIndexOf("{", s - 1), tries++) {
      const t = objectAt(text, s);
      if (!t || t.length < at - s) continue; // object closes before the marker
      try {
        const o = JSON.parse(t);
        if (o && typeof o === "object" && accept(o)) { found.push(o as T); break; }
      } catch { /* keep walking out */ }
    }
  }
  return found;
}

/** Values that are sometimes a JSON string and sometimes already parsed. */
export function jsonish<T>(v: unknown): T | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") {
    const s = v.trim();
    if (!(s.startsWith("{") || s.startsWith("["))) return undefined;
    try { return JSON.parse(s) as T; } catch { return undefined; }
  }
  return v as T;
}
