import cron from "node-cron";
import { Op } from "sequelize";
import { env } from "../../config/env";
import { isSshConfigured } from "../../lib/ssh";
import { Server, ServerJob, ServerSnapshot } from "../../models";
import { collectStats, inMaintenanceWindow, nextAutoUpgrade, pollJob, startJob } from "./servers.service";

// One minute ticker, like the backup scheduler. Each tick:
//   1. reads back every running job (so logs and outcomes land without a browser open);
//   2. refreshes snapshots older than SERVER_STATS_INTERVAL_MINUTES;
//   3. starts weekly automatic upgrades that are due;
//   4. once a day at SERVER_SCAN_HOUR_UTC, starts the security scan everywhere;
//   5. once a day, prunes old snapshots.
// SSH is slow and servers are few, so work is bounded and runs a few at a time.

const PARALLEL = 4;
let ticking = false;

async function inBatches<T>(items: T[], fn: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += PARALLEL) {
    await Promise.allSettled(items.slice(i, i + PARALLEL).map(fn));
  }
}

function startOfTodayAt(hour: number, now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour));
}

export async function serverTick(now = new Date()): Promise<void> {
  if (ticking || !isSshConfigured()) return;
  ticking = true;
  try {
    const running = await ServerJob.findAll({ where: { status: "running" } });
    await inBatches(running, (job) => pollJob(job));

    const staleBefore = new Date(now.getTime() - env.SERVER_STATS_INTERVAL_MINUTES * 60_000);
    const stale = await Server.findAll({
      where: { [Op.or]: [{ lastStatsAt: null }, { lastStatsAt: { [Op.lt]: staleBefore } }] },
    });
    await inBatches(stale, (server) => collectStats(server));

    const dueUpgrades = await Server.findAll({
      where: { autoUpgrade: true, mode: "managed", nextAutoUpgradeAt: { [Op.lte]: now } },
    });
    for (const server of dueUpgrades) {
      // Claim the slot first, so a failure doesn't retry every minute.
      server.nextAutoUpgradeAt = nextAutoUpgrade(server, now);
      await server.save();
      if (inMaintenanceWindow(server, now)) continue;
      try {
        await startJob(server, "upgrade", "scheduled", null);
      } catch (err) {
        console.error(`[servers] scheduled upgrade of ${server.name} not started: ${(err as Error).message}`);
      }
    }

    // Daily scan: every server without a scan since today's scan hour.
    if (now.getUTCHours() === env.SERVER_SCAN_HOUR_UTC) {
      const since = startOfTodayAt(env.SERVER_SCAN_HOUR_UTC, now);
      const servers = await Server.findAll({ where: { status: "ok" } });
      for (const server of servers) {
        const done = await ServerJob.findOne({ where: { serverId: server.id, kind: "scan", startedAt: { [Op.gte]: since } } });
        if (done || inMaintenanceWindow(server, now)) continue;
        try {
          await startJob(server, "scan", "scheduled", null);
        } catch (err) {
          // Usually "a job is already running"; the next tick in this hour retries.
          console.warn(`[servers] daily scan of ${server.name} deferred: ${(err as Error).message}`);
        }
      }
    }

    if (now.getUTCHours() === 2 && now.getUTCMinutes() === 17) {
      const cutoff = new Date(now.getTime() - env.SERVER_SNAPSHOT_RETENTION_DAYS * 86_400_000);
      const n = await ServerSnapshot.destroy({ where: { collectedAt: { [Op.lt]: cutoff } } });
      if (n) console.info(`[servers] pruned ${n} snapshot(s) older than ${env.SERVER_SNAPSHOT_RETENTION_DAYS} days`);
    }
  } finally {
    ticking = false;
  }
}

export function startServerScheduler(): void {
  if (!env.ENABLE_SERVER_SCHEDULER) {
    console.info("[servers] scheduler disabled");
    return;
  }
  if (!isSshConfigured()) {
    console.warn("[servers] SERVER_SSH_PRIVATE_KEY not set: the server console can't reach any server");
  }
  cron.schedule(env.SERVER_SCHEDULER_CRON, () => {
    serverTick().catch((err) => console.error("[servers] tick failed", err));
  });
  console.info("[servers] scheduler enabled");
}
