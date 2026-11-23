import { localDayAndTime } from "../../modules/attendance/attendance.code";

// All seeded dates are relative to the moment the seed runs, in the
// organization's zone (Africa/Lagos has no daylight saving, so a fixed offset holds).
export const TIME_ZONE = "Africa/Lagos";
const UTC_OFFSET = "+01:00";
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export const now = new Date();
export const today = localDayAndTime(now, TIME_ZONE).day;
const todayIndex = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;

export function dayAt(offsetDays: number, time = "00:00"): Date {
  return new Date(Date.parse(`${today}T${time}:00${UTC_OFFSET}`) + offsetDays * DAY_MS);
}

export function dayString(offsetDays: number): string {
  return localDayAndTime(dayAt(offsetDays, "12:00"), TIME_ZONE).day;
}

export function weekdayIndex(offsetDays: number): number {
  return (todayIndex + (offsetDays % 7) + 7) % 7;
}

export function isWorkingDay(offsetDays: number): boolean {
  return weekdayIndex(offsetDays) < 5;
}

// Monday of this week is week 0, day 0. Friday of next week is week 1, day 4.
export function weekSlot(week: number, day: number, time: string): Date {
  return dayAt(week * 7 + day - todayIndex, time);
}

// Offsets (0 = today, negative = past) of the last `count` working days, oldest first.
export function workingDaysBack(count: number): number[] {
  const out: number[] = [];
  for (let offset = 0; out.length < count; offset -= 1) if (isWorkingDay(offset)) out.unshift(offset);
  return out;
}

export function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * MINUTE_MS);
}

export function minutesAgo(minutes: number): Date {
  return addMinutes(now, -minutes);
}

export function earliest(...dates: Date[]): Date {
  return new Date(Math.min(...dates.map((d) => d.getTime())));
}

export function clock(minutesFromMidnight: number): string {
  const total = Math.round(minutesFromMidnight);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function monthBounds(): { start: string; end: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${y}-${String(m).padStart(2, "0")}-01`, end: `${y}-${String(m).padStart(2, "0")}-${last}` };
}

export function previousMonthBounds(): { start: string; end: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 2, 1));
  const last = new Date(Date.UTC(y, m - 1, 0));
  return { start: first.toISOString().slice(0, 10), end: last.toISOString().slice(0, 10) };
}

export function quarterBounds(): { start: string; end: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const q = Math.floor((m - 1) / 3);
  const first = new Date(Date.UTC(y, q * 3, 1));
  const last = new Date(Date.UTC(y, q * 3 + 3, 0));
  return { start: first.toISOString().slice(0, 10), end: last.toISOString().slice(0, 10) };
}

// Stable pseudo-randomness so re-runs and reviews see the same data.
export function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function pick<T>(items: readonly T[], seed: string): T {
  return items[hash(seed) % items.length]!;
}
