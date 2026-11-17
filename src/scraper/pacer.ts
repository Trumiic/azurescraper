/**
 * Per-extension pacing and the "back off at the first interruption" breaker.
 *
 * State lives in DATA_DIR/scraper/state.json so a restart doesn't reset the
 * hourly count or lift a cooldown early.
 *  - at most `maxPerHour` requests in any rolling hour
 *  - a random gap (minGap..maxGap) after every request, so timing isn't robotic
 *  - after an interruption: no requests until cooldownUntil
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { sleep } from "../core/ratelimit.js";
import type { Pacing } from "./types.js";

interface ExtState {
  requests: number[];        // timestamps (ms) within the last hour
  nextAllowedAt: number;
  cooldownUntil?: number;
  cooldownReason?: string;
}

const dir = () => path.join(config.dataDir, "scraper");
const file = () => path.join(dir(), "state.json");
let state: Record<string, ExtState> | null = null;

function load(): Record<string, ExtState> {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(file(), "utf8")); } catch { state = {}; }
  return state!;
}
function save() {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(`${file()}.tmp`, JSON.stringify(state, null, 1));
  fs.renameSync(`${file()}.tmp`, file());
}
function get(id: string): ExtState {
  const s = load();
  s[id] ??= { requests: [], nextAllowedAt: 0 };
  s[id].requests = s[id].requests.filter((t) => Date.now() - t < 3_600_000);
  return s[id];
}

/** Test/dev override: SCRAPER_FAST=1 shrinks gaps to ~0.2 s (never use against real sites). */
export function effectivePacing(p: Pacing): Pacing {
  return process.env.SCRAPER_FAST === "1" ? { ...p, minGapMs: 150, maxGapMs: 300 } : p;
}

export class CooldownError extends Error {
  statusCode = 423;
  constructor(public until: number, reason?: string) {
    super(`Paused after an interruption until ${new Date(until).toLocaleString()}${reason ? ` (${reason})` : ""}`);
  }
}

/** When could the next request start (ms epoch), and why. */
export function nextSlot(id: string, pacing: Pacing): { at: number; reason: "ready" | "gap" | "hourly" | "cooldown" } {
  const s = get(id);
  const now = Date.now();
  if (s.cooldownUntil && s.cooldownUntil > now) return { at: s.cooldownUntil, reason: "cooldown" };
  if (s.requests.length >= pacing.maxPerHour) return { at: s.requests[0] + 3_600_000 + 1000, reason: "hourly" };
  if (s.nextAllowedAt > now) return { at: s.nextAllowedAt, reason: "gap" };
  return { at: now, reason: "ready" };
}

/** Wait for a slot, then record the request. Throws CooldownError if paused. */
export async function acquire(id: string, pacing: Pacing, cancelled?: () => boolean, onWait?: (ms: number, why: string) => void) {
  const p = effectivePacing(pacing);
  for (;;) {
    const slot = nextSlot(id, p);
    if (slot.reason === "cooldown") throw new CooldownError(slot.at, get(id).cooldownReason);
    const wait = slot.at - Date.now();
    if (wait <= 0) break;
    onWait?.(wait, slot.reason);
    await sleep(Math.min(wait, 5000), cancelled);
  }
  const s = get(id);
  const now = Date.now();
  s.requests.push(now);
  s.nextAllowedAt = now + p.minGapMs + Math.random() * (p.maxGapMs - p.minGapMs);
  save();
}

/** Trip the breaker: no requests for this extension until the cooldown ends. */
export function tripCooldown(id: string, pacing: Pacing, reason: string) {
  const s = get(id);
  s.cooldownUntil = Date.now() + pacing.cooldownHours * 3_600_000;
  s.cooldownReason = reason.slice(0, 200);
  save();
  return s.cooldownUntil;
}

export function clearCooldown(id: string) {
  const s = get(id);
  delete s.cooldownUntil;
  delete s.cooldownReason;
  save();
}

export function pacerStatus(id: string, pacing: Pacing) {
  const p = effectivePacing(pacing);
  const s = get(id);
  const slot = nextSlot(id, p);
  return {
    maxPerHour: p.maxPerHour,
    gapSeconds: [Math.round(p.minGapMs / 1000), Math.round(p.maxGapMs / 1000)],
    cooldownHours: p.cooldownHours,
    lastHour: s.requests.length,
    nextAt: slot.at,
    nextReason: slot.reason,
    cooldownUntil: s.cooldownUntil && s.cooldownUntil > Date.now() ? s.cooldownUntil : null,
    cooldownReason: s.cooldownUntil && s.cooldownUntil > Date.now() ? s.cooldownReason : null,
  };
}
