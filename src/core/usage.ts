/**
 * Counts API calls per day (UTC) so jobs can stay under store rate limits.
 * Kept in DATA_DIR/usage.json so it survives restarts; only the last 14 days are kept.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

type Usage = Record<string, Record<string, number>>; // day -> counter -> calls

const file = () => path.join(config.dataDir, "usage.json");
let usage: Usage | null = null;
let dirty = false;

const today = () => new Date().toISOString().slice(0, 10);

function load(): Usage {
  if (usage) return usage;
  try {
    usage = JSON.parse(fs.readFileSync(file(), "utf8")) as Usage;
  } catch {
    usage = {};
  }
  return usage;
}

function flush() {
  if (!dirty || !usage) return;
  dirty = false;
  const days = Object.keys(usage).sort().slice(-14);
  usage = Object.fromEntries(days.map((d) => [d, usage![d]]));
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(`${file()}.tmp`, JSON.stringify(usage));
  fs.renameSync(`${file()}.tmp`, file());
}
setInterval(flush, 5000).unref();
process.on("exit", flush);

export function countCall(counter: string) {
  const u = load();
  const d = today();
  u[d] ??= {};
  u[d][counter] = (u[d][counter] ?? 0) + 1;
  dirty = true;
}

export function callsToday(counter: string): number {
  return load()[today()]?.[counter] ?? 0;
}

export class BudgetExceededError extends Error {
  statusCode = 429;
}
