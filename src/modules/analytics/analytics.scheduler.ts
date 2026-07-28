import cron from "node-cron";
import { env } from "../../config/env";
import { analyticsService } from "./analytics.service";
import { ingestService } from "./analytics.ingest";

// Keeps the analytics tables healthy: refresh the daily rollup the dashboards
// read, then drop raw events past the retention window (the rollup preserves
// the long-range charts).
export function startAnalyticsScheduler(): void {
  if (!env.ENABLE_ANALYTICS_SCHEDULER) {
    console.info("[analytics] scheduler disabled");
    return;
  }

  cron.schedule(env.ANALYTICS_ROLLUP_CRON, () => {
    analyticsService
      .rollup()
      .catch((err) => console.error("[analytics] rollup failed", err));
  });

  cron.schedule(env.ANALYTICS_PRUNE_CRON, () => {
    ingestService
      .pruneOlderThan(env.ANALYTICS_RETENTION_DAYS)
      .then((n) => n && console.info(`[analytics] pruned ${n} events`))
      .catch((err) => console.error("[analytics] prune failed", err));
  });

  console.info(
    `[analytics] scheduler enabled (rollup="${env.ANALYTICS_ROLLUP_CRON}", retention=${env.ANALYTICS_RETENTION_DAYS}d)`,
  );
}
