// Target arithmetic (API-CHANGES A502). Pure.

export function progressPercent(start: number, target: number, current: number): number {
  if (target === start) return current === target ? 100 : 0;
  // Works for targets that go down too, such as reducing a backlog from 80 to 20.
  const pct = ((current - start) / (target - start)) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

// A group's current value is its average, because each person holds the same
// target value individually; a sum would pass the target far too early.
export function rollup(values: number[]): number {
  if (!values.length) return 0;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}

export function isReached(start: number, target: number, current: number): boolean {
  return target >= start ? current >= target : current <= target;
}

export type TargetState = "active" | "achieved" | "missed" | "cancelled";

// Evaluated and cancelled targets are final; a person decided those.
export function nextTargetStatus(input: { status: TargetState; evaluated: boolean; start: number; target: number; current: number; endDate: string; today: string }): TargetState {
  if (input.status === "cancelled" || input.evaluated) return input.status;
  if (isReached(input.start, input.target, input.current)) return "achieved";
  if (input.today > input.endDate) return "missed";
  return "active";
}

const STATUS_ORDER: Record<string, string[]> = {
  issued: ["responded", "under_review", "withdrawn"],
  responded: ["under_review", "resolved", "withdrawn"],
  under_review: ["resolved", "withdrawn"],
  resolved: [],
  withdrawn: [],
};
export const canMoveQuery = (from: string, to: string) => (STATUS_ORDER[from] ?? []).includes(to);

export const queryReference = (seq: number, createdAt: Date) => `Q-${createdAt.getUTCFullYear()}-${String(seq).padStart(4, "0")}`;
