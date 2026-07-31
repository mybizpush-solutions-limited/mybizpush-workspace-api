import cron from "node-cron";
import { Op } from "sequelize";
import { env } from "../../config/env";
import { DatabaseBackupSchedule, ProjectDatabase } from "../../models";
import { pgDumpVersion } from "../../lib/pgdump";
import { backupsService, runBackup } from "./backups.service";
import { computeNextRun, describeSchedule } from "./schedules.helpers";

// A minute ticker rather than one cron job per schedule: schedules are edited
// from the UI at runtime, and re-registering node-cron jobs on every save is a
// bookkeeping problem we'd rather not own. Each row carries its own precomputed
// nextRunAt, so "what's due" is a single indexed query.

let ticking = false;

export async function runDueBackups(now = new Date()): Promise<number> {
  // Overlap guard: a slow dump must not have the next tick start it again.
  if (ticking) return 0;
  ticking = true;

  try {
    const due = await DatabaseBackupSchedule.findAll({
      where: { enabled: true, nextRunAt: { [Op.lte]: now } },
      order: [["nextRunAt", "ASC"]],
      limit: 20,
    });
    if (due.length === 0) return 0;

    let ran = 0;
    for (const schedule of due) {
      // Claim the slot before doing the work. If the dump throws we still want
      // nextRunAt moved on, or the row would retry every single minute.
      schedule.lastRunAt = now;
      schedule.nextRunAt = computeNextRun(schedule, now);
      await schedule.save();

      const db = await ProjectDatabase.findByPk(schedule.databaseId);
      if (!db) {
        await schedule.destroy(); // database was deleted out from under it
        continue;
      }

      try {
        await runBackup(db, {
          trigger: "scheduled",
          format: schedule.format as "custom" | "plain",
          storageTarget: schedule.storageTarget,
          userId: schedule.createdBy,
        });
        ran += 1;
        console.info(`[backups] scheduled backup of "${db.name}" completed`);
      } catch (err) {
        // The failure is already recorded on the backup row; this is for the logs.
        console.error(`[backups] scheduled backup of "${db.name}" failed:`, (err as Error).message);
      }
    }
    return ran;
  } finally {
    ticking = false;
  }
}

export function startBackupScheduler(): void {
  if (!env.ENABLE_BACKUP_SCHEDULER) {
    console.info("[backups] scheduler disabled");
    return;
  }

  // Anything left "running" by a restart is dead; say so in the history.
  backupsService
    .reconcileStale()
    .then((n) => n && console.warn(`[backups] marked ${n} interrupted backup(s) as failed`))
    .catch((err) => console.error("[backups] stale reconcile failed", err));

  // Warn once at boot rather than at 2am on the night we need a restore.
  void pgDumpVersion().then((version) => {
    if (version) console.info(`[backups] pg_dump ${version} available`);
    else
      console.warn(
        `[backups] pg_dump not found (PG_DUMP_PATH="${env.PG_DUMP_PATH}") — scheduled backups will fail until it's installed`,
      );
  });

  cron.schedule(env.BACKUP_SCHEDULER_CRON, () => {
    runDueBackups().catch((err) => console.error("[backups] tick failed", err));
  });

  // Surface what's actually armed, so a mis-set timezone is caught early.
  DatabaseBackupSchedule.findAll({ where: { enabled: true } })
    .then((schedules) => {
      console.info(`[backups] scheduler enabled — ${schedules.length} schedule(s) armed`);
      for (const s of schedules) {
        console.info(`[backups]   ${describeSchedule(s)} → next ${s.nextRunAt?.toISOString() ?? "unset"}`);
      }
    })
    .catch(() => undefined);
}
