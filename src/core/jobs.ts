/**
 * Minimal background job runner (in-process).
 *
 * A job is an async function that reports progress through `ctx`. The UI polls
 * job status. Today jobs are started by buttons; later the Redis scheduler will
 * start the same jobs on a timetable.
 *
 * The last finished run of each job type is kept in DATA_DIR/jobs.json so the UI
 * can show "last crawl: ..." after a restart.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  type: string;      // e.g. "crawl", "prices"
  scope: string;     // e.g. "groceries/kroger"
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  progress: { done: number; total: number };
  stats: Record<string, number>;
  message?: string;  // summary or error
  log: string[];     // last ~100 lines
}

export interface JobContext {
  setTotal(n: number): void;
  tick(n?: number): void;
  stat(key: string, add?: number): void;
  log(line: string): void;
  readonly cancelled: boolean;
}

const jobs = new Map<string, Job>();
const cancelFlags = new Set<string>();

const lastFile = () => path.join(config.dataDir, "jobs.json");
let lastRuns: Record<string, Job> = {};
try {
  lastRuns = JSON.parse(fs.readFileSync(lastFile(), "utf8"));
} catch { /* first run */ }

function saveLast(job: Job) {
  lastRuns[`${job.scope}:${job.type}`] = job;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(lastFile(), JSON.stringify(lastRuns, null, 2));
  } catch { /* non-fatal */ }
}

export function runningJob(scope: string): Job | undefined {
  return [...jobs.values()].find((j) => j.scope === scope && j.status === "running");
}

/** Start a job; only one job may run per scope (store module) at a time. */
export function startJob(
  scope: string,
  type: string,
  fn: (ctx: JobContext) => Promise<string>,
): Job {
  const busy = runningJob(scope);
  if (busy) {
    throw Object.assign(new Error(`A ${busy.type} job is already running for this store`), { statusCode: 409 });
  }
  const job: Job = {
    id: randomUUID(),
    type,
    scope,
    status: "running",
    startedAt: new Date().toISOString(),
    progress: { done: 0, total: 0 },
    stats: {},
    log: [],
  };
  jobs.set(job.id, job);

  const ctx: JobContext = {
    setTotal: (n) => { job.progress.total = n; },
    tick: (n = 1) => { job.progress.done += n; },
    stat: (k, add = 1) => { job.stats[k] = (job.stats[k] ?? 0) + add; },
    log: (line) => {
      job.log.push(`${new Date().toLocaleTimeString()}  ${line}`);
      if (job.log.length > 100) job.log.shift();
    },
    get cancelled() { return cancelFlags.has(job.id); },
  };

  fn(ctx)
    .then((summary) => {
      job.status = cancelFlags.has(job.id) ? "cancelled" : "done";
      job.message = summary;
    })
    .catch((e: Error & { statusCode?: number }) => {
      if (e.statusCode === 429) {
        // Daily API budget reached: a normal stop, not a failure. Saved work is kept.
        job.status = "done";
        job.message = `Stopped early: ${e.message}`;
      } else {
        job.status = "failed";
        job.message = e.message;
      }
      ctx.log(e.message);
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      cancelFlags.delete(job.id);
      saveLast(job);
      // keep finished jobs in memory for a while so the UI can show the result
      setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000).unref();
    });

  return job;
}

export function cancelJob(id: string) {
  const job = jobs.get(id);
  if (!job || job.status !== "running") {
    throw Object.assign(new Error("Job is not running"), { statusCode: 404 });
  }
  cancelFlags.add(id);
  job.log.push(`${new Date().toLocaleTimeString()}  Cancelling…`);
}

/** Current job (if any) plus the last finished run of each type, for one scope. */
export function jobsFor(scope: string) {
  const current = runningJob(scope)
    ?? [...jobs.values()].filter((j) => j.scope === scope).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const last = Object.fromEntries(
    Object.values(lastRuns)
      .filter((j) => j.scope === scope)
      .map((j) => [j.type, { status: j.status, finishedAt: j.finishedAt, message: j.message, stats: j.stats }]),
  );
  return { current: current ?? null, last };
}
