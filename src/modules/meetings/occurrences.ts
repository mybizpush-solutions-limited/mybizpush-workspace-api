// Expanding a recurring meeting into its dates (API-CHANGES A401). Pure. Works in
// UTC, which matches how the times are stored; Nigeria has no daylight saving,
// and Google remains the source of truth for invites in other zones.

export interface Recurrence {
  freq: "daily" | "weekly" | "monthly";
  interval: number;
  count?: number | null;
  until?: string | null; // YYYY-MM-DD, inclusive
}

const MAX_OCCURRENCES = 1000;

function nth(start: Date, rule: Recurrence, n: number): Date {
  const step = Math.max(1, rule.interval || 1);
  if (rule.freq === "daily") return new Date(start.getTime() + n * step * 86_400_000);
  if (rule.freq === "weekly") return new Date(start.getTime() + n * step * 7 * 86_400_000);
  // Monthly: the same day, or the month's last day when it's shorter (31 Jan to 28 Feb).
  const month = start.getUTCMonth() + n * step;
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), month + 1, 0)).getUTCDate();
  const out = new Date(start);
  out.setUTCFullYear(start.getUTCFullYear(), month, Math.min(start.getUTCDate(), lastDay));
  return out;
}

export interface Occurrence {
  start: Date;
  end: Date;
}

// Occurrences that overlap [from, to).
export function occurrencesBetween(startsAt: Date, endsAt: Date, rule: Recurrence | null | undefined, from: Date, to: Date): Occurrence[] {
  const duration = endsAt.getTime() - startsAt.getTime();
  if (!rule) {
    return endsAt > from && startsAt < to ? [{ start: startsAt, end: endsAt }] : [];
  }
  const until = rule.until ? new Date(`${rule.until}T23:59:59.999Z`) : null;
  const limit = Math.min(rule.count && rule.count > 0 ? rule.count : MAX_OCCURRENCES, MAX_OCCURRENCES);
  const out: Occurrence[] = [];
  for (let n = 0; n < limit; n++) {
    const start = nth(startsAt, rule, n);
    if (start >= to) break;
    if (until && start > until) break;
    const end = new Date(start.getTime() + duration);
    if (end > from) out.push({ start, end });
  }
  return out;
}
