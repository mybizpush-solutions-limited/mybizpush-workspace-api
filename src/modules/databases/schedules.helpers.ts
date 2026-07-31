import { env } from "../../config/env";
import type { BackupFrequency, DatabaseBackupSchedule } from "../../models";

// Schedules are expressed the way people actually describe them — "every night
// at 2am, Lagos time" — rather than as cron. That keeps the UI a couple of
// dropdowns, and lets us compute an exact next_run_at so the ticker is one
// indexed query instead of re-parsing cron for every row every minute.
//
// Timezone maths is done through Intl (Node ships full ICU), so DST is handled
// for teams outside West Africa too.

export interface SerializedSchedule {
  id: string;
  databaseId: string;
  enabled: boolean;
  frequency: BackupFrequency;
  hour: number;
  minute: number;
  dayOfWeek: number;
  dayOfMonth: number;
  timezone: string;
  format: string;
  storageTarget: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeSchedule(s: DatabaseBackupSchedule): SerializedSchedule {
  return {
    id: s.id,
    databaseId: s.databaseId,
    enabled: s.enabled,
    frequency: s.frequency,
    hour: s.hour,
    minute: s.minute,
    dayOfWeek: s.dayOfWeek,
    dayOfMonth: s.dayOfMonth,
    timezone: s.timezone,
    format: s.format,
    storageTarget: s.storageTarget,
    lastRunAt: s.lastRunAt?.toISOString() ?? null,
    nextRunAt: s.nextRunAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function safeTimezone(tz: string): string {
  if (isValidTimezone(tz)) return tz;
  return isValidTimezone(env.BACKUP_DEFAULT_TIMEZONE) ? env.BACKUP_DEFAULT_TIMEZONE : "UTC";
}

interface CivilParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// The wall-clock reading a person in `tz` would see at instant `d`.
function civilPartsIn(d: Date, tz: string): CivilParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    // Some ICU builds render midnight as hour 24 under hour12:false.
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

// Offset of `tz` at instant `d`, in minutes east of UTC.
function offsetMinutes(d: Date, tz: string): number {
  const p = civilPartsIn(d, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(d.getTime() / 1000) * 1000;
  return (asIfUtc - truncated) / 60_000;
}

// Inverse of civilPartsIn: which instant is "y-m-d h:mm in tz"? The offset
// depends on the answer, so we apply it and re-check — two passes converge for
// every real zone, including across a DST boundary.
function civilToInstant(y: number, mo: number, day: number, h: number, mi: number, tz: string): Date {
  const naive = Date.UTC(y, mo - 1, day, h, mi, 0);
  let ts = naive;
  for (let i = 0; i < 3; i++) {
    const next = naive - offsetMinutes(new Date(ts), tz) * 60_000;
    if (next === ts) break;
    ts = next;
  }
  return new Date(ts);
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

export interface ScheduleShape {
  frequency: BackupFrequency;
  hour: number;
  minute: number;
  dayOfWeek: number; // 0 = Sunday
  dayOfMonth: number;
  timezone: string;
}

// The next instant this schedule should fire, strictly after `from`.
export function computeNextRun(s: ScheduleShape, from: Date = new Date()): Date {
  const tz = safeTimezone(s.timezone);

  if (s.frequency === "hourly") {
    // Walk forward an hour at a time and pin the minute — correct even in the
    // zones whose offset isn't a whole number of hours.
    for (let i = 0; i <= 48; i++) {
      const p = civilPartsIn(new Date(from.getTime() + i * 3_600_000), tz);
      const candidate = civilToInstant(p.year, p.month, p.day, p.hour, s.minute, tz);
      if (candidate.getTime() > from.getTime()) return candidate;
    }
    return new Date(from.getTime() + 3_600_000);
  }

  // Daily / weekly / monthly all reduce to "find the next civil day that
  // matches, then place hour:minute on it".
  const limit = s.frequency === "weekly" ? 14 : s.frequency === "monthly" ? 400 : 2;
  const today = civilPartsIn(from, tz);
  const firstDay = Date.UTC(today.year, today.month - 1, today.day);

  for (let i = 0; i <= limit; i++) {
    const civil = new Date(firstDay + i * 86_400_000);
    const y = civil.getUTCFullYear();
    const mo = civil.getUTCMonth() + 1;
    const day = civil.getUTCDate();

    let matches = true;
    if (s.frequency === "weekly") {
      matches = civil.getUTCDay() === s.dayOfWeek;
    } else if (s.frequency === "monthly") {
      // Clamp so "the 31st" still runs in February.
      matches = day === Math.min(s.dayOfMonth, daysInMonth(y, mo));
    }
    if (!matches) continue;

    const candidate = civilToInstant(y, mo, day, s.hour, s.minute, tz);
    if (candidate.getTime() > from.getTime()) return candidate;
  }

  // Unreachable for valid input; a day out beats returning null and stalling.
  return new Date(from.getTime() + 86_400_000);
}

// Human summary used in the UI and in logs.
export function describeSchedule(s: ScheduleShape): string {
  const at = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const ordinal = (n: number) => {
    const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
    return `${n}${suffix}`;
  };
  switch (s.frequency) {
    case "hourly":
      return `Every hour at :${String(s.minute).padStart(2, "0")}`;
    case "weekly":
      return `Every ${days[s.dayOfWeek] ?? "Monday"} at ${at} (${s.timezone})`;
    case "monthly":
      return `Monthly on the ${ordinal(s.dayOfMonth)} at ${at} (${s.timezone})`;
    default:
      return `Every day at ${at} (${s.timezone})`;
  }
}
