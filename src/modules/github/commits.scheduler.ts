import cron from "node-cron";
import { env } from "../../config/env";
import { commitsSyncService } from "./commits.sync.service";

// Nightly commit sync across every project with linked repos. Keeps the
// workspace's commit record (feed, per-member counts, staff reports) fresh
// without anyone having to think about it.
export function startCommitsScheduler() {
  cron.schedule(env.COMMITS_SYNC_CRON, () => {
    console.info("[commits-sync] nightly sync starting");
    void commitsSyncService.syncAll().catch((err) => console.error("[commits-sync] failed:", err));
  });
}