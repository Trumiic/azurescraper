/**
 * Automatic schedule: ON STANDBY until Redis is set up.
 *
 * These are the agreed timetables. When Redis is ready, a scheduler (e.g. BullMQ
 * repeatable jobs) will start the same functions the buttons use today:
 *   crawl          -> startCrawl(scope, module, locationId)        weekly
 *   prices         -> startPriceUpdate(scope, module, store)       daily
 *   nutrition fill -> startNutritionFill()                         weekly, after the crawl
 */
export interface PlannedRun {
  scope: string;   // e.g. "groceries/kroger"
  job: string;     // job type
  every: string;   // human-readable plan
}

export const PLANNED_SCHEDULE: PlannedRun[] = [
  { scope: "groceries/kroger", job: "crawl", every: "Weekly (Sunday night)" },
  { scope: "groceries/kroger", job: "prices", every: "Daily" },
  { scope: "groceries/nutrition", job: "fill", every: "Weekly (after the Kroger crawl)" },
  { scope: "groceries/kroger-web", job: "scrape", every: "Weekly: new items only, after the crawl (50/hour)" },
];

export function scheduleFor(scope: string) {
  return {
    active: false,
    reason: "On standby until Redis is set up",
    runs: PLANNED_SCHEDULE.filter((r) => r.scope === scope),
  };
}
