import { badRequest, notFound } from "../../lib/errors";
import type { Auth } from "../../lib/permissions";
import { env } from "../../config/env";
import {
  DatabaseBackupSchedule,
  type BackupFrequency,
  type BackupStorage,
} from "../../models";
import { loadManaged } from "./databases.service";
import {
  computeNextRun,
  isValidTimezone,
  serializeSchedule,
  type SerializedSchedule,
} from "./schedules.helpers";

export interface ScheduleInput {
  enabled?: boolean;
  frequency?: BackupFrequency;
  hour?: number;
  minute?: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  timezone?: string;
  format?: string;
  storageTarget?: BackupStorage;
}

export const schedulesService = {
  async get(databaseId: string, auth: Auth): Promise<SerializedSchedule | null> {
    await loadManaged(databaseId, auth);
    const schedule = await DatabaseBackupSchedule.findOne({ where: { databaseId } });
    return schedule ? serializeSchedule(schedule) : null;
  },

  // Upsert: a database has at most one schedule, so "create" and "edit" are the
  // same call from the UI's point of view.
  async save(databaseId: string, input: ScheduleInput, auth: Auth): Promise<SerializedSchedule> {
    await loadManaged(databaseId, auth);
    if (input.timezone && !isValidTimezone(input.timezone)) {
      throw badRequest(`"${input.timezone}" is not a recognised IANA timezone`);
    }

    const existing = await DatabaseBackupSchedule.findOne({ where: { databaseId } });
    const schedule =
      existing ??
      DatabaseBackupSchedule.build({
        databaseId,
        timezone: env.BACKUP_DEFAULT_TIMEZONE,
        createdBy: auth.sub,
      });

    if (input.enabled !== undefined) schedule.enabled = input.enabled;
    if (input.frequency !== undefined) schedule.frequency = input.frequency;
    if (input.hour !== undefined) schedule.hour = input.hour;
    if (input.minute !== undefined) schedule.minute = input.minute;
    if (input.dayOfWeek !== undefined) schedule.dayOfWeek = input.dayOfWeek;
    if (input.dayOfMonth !== undefined) schedule.dayOfMonth = input.dayOfMonth;
    if (input.timezone !== undefined) schedule.timezone = input.timezone;
    if (input.format !== undefined) schedule.format = input.format;
    if (input.storageTarget !== undefined) schedule.storageTarget = input.storageTarget;

    // Recomputed on every save so a paused-then-resumed schedule never fires a
    // burst of "missed" runs from a stale nextRunAt.
    schedule.nextRunAt = schedule.enabled ? computeNextRun(schedule) : null;
    await schedule.save();
    return serializeSchedule(schedule);
  },

  async remove(databaseId: string, auth: Auth): Promise<void> {
    await loadManaged(databaseId, auth);
    const schedule = await DatabaseBackupSchedule.findOne({ where: { databaseId } });
    if (!schedule) throw notFound("No schedule set for this database");
    await schedule.destroy();
  },
};
