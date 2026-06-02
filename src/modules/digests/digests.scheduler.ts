import cron from "node-cron";
import { env } from "../../config/env";
import { runDigests } from "./digests.service";

// Schedule the recurring digest emails. Cron expressions + on/off come from env.
export function startDigestScheduler(): void {
  if (!env.ENABLE_DIGEST_SCHEDULER) {
    console.info("[digests] scheduler disabled");
    return;
  }

  cron.schedule(env.DIGEST_DAILY_CRON, () => {
    runDigests("daily")
      .then((r) => console.info(`[digests] daily sent ${r.sent}/${r.considered}`))
      .catch((err) => console.error("[digests] daily run failed", err));
  });

  cron.schedule(env.DIGEST_WEEKLY_CRON, () => {
    runDigests("weekly")
      .then((r) => console.info(`[digests] weekly sent ${r.sent}/${r.considered}`))
      .catch((err) => console.error("[digests] weekly run failed", err));
  });

  console.info(
    `[digests] scheduler enabled (daily="${env.DIGEST_DAILY_CRON}", weekly="${env.DIGEST_WEEKLY_CRON}")`,
  );
}
