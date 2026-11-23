import { TARGET_UNITS, Target, TargetAssignment, TargetProgress } from "../../models";
import { groupsService } from "../../modules/groups/groups.service";
import { rollup } from "../../modules/performance/target.calc";
import type { SeedContext } from "./context";
import { dayAt, hash, monthBounds, previousMonthBounds, quarterBounds } from "./time";

interface TargetSpec {
  name: string;
  description: string;
  owner: { type: "user"; ref: string } | { type: "team" | "department"; ref: string };
  period: "month" | "quarter";
  previous?: boolean;
  unit: (typeof TARGET_UNITS)[number];
  unitLabel?: string;
  startValue?: number;
  targetValue: number;
  progress: number;
  reviewer: string;
  status?: "active" | "achieved";
}

const TARGETS: TargetSpec[] = [
  { name: "Instagram followers", description: "Grow the MyBizPush Instagram audience.", owner: { type: "user", ref: "seyi" }, period: "month", unit: "count", startValue: 8400, targetValue: 10000, progress: 0.62, reviewer: "chiamaka" },
  { name: "New merchant accounts", description: "Signed and onboarded merchants in Abuja.", owner: { type: "user", ref: "kemi" }, period: "quarter", unit: "count", targetValue: 30, progress: 0.6, reviewer: "yusuf" },
  { name: "Workspace mobile 1.2 scope delivered", description: "Share of the 1.2 release scope merged and tested.", owner: { type: "user", ref: "femi" }, period: "month", unit: "percent", targetValue: 100, progress: 0.71, reviewer: "sam" },
  { name: "Qualified leads", description: "Marketing qualified leads across all channels.", owner: { type: "team", ref: "growth-pod" }, period: "month", unit: "count", targetValue: 400, progress: 0.58, reviewer: "chiamaka" },
  { name: "API p95 latency", description: "Bring p95 latency of the public API down.", owner: { type: "team", ref: "platform-core" }, period: "quarter", unit: "custom", unitLabel: "ms", startValue: 480, targetValue: 250, progress: 0.74, reviewer: "sam" },
  { name: "Q4 revenue", description: "New and expansion revenue booked this quarter.", owner: { type: "department", ref: "sales" }, period: "quarter", unit: "currency", unitLabel: "NGN", targetValue: 25_000_000, progress: 0.57, reviewer: "ada" },
  { name: "Support tickets resolved", description: "Tickets resolved within SLA last month.", owner: { type: "user", ref: "musa" }, period: "month", previous: true, unit: "count", targetValue: 150, progress: 1.08, reviewer: "yusuf", status: "achieved" },
];

function ownerIdOf(ctx: SeedContext, owner: TargetSpec["owner"]): string {
  if (owner.type === "user") return ctx.id(owner.ref);
  return owner.type === "team" ? ctx.team(owner.ref).id : ctx.department(owner.ref).id;
}

export async function seedTargets(ctx: SeedContext): Promise<void> {
  for (const spec of TARGETS) {
    const ownerId = ownerIdOf(ctx, spec.owner);
    if (await Target.findOne({ where: { name: spec.name, ownerType: spec.owner.type, ownerId } })) continue;
    const bounds = spec.period === "quarter" ? quarterBounds() : spec.previous ? previousMonthBounds() : monthBounds();
    const startValue = spec.startValue ?? 0;
    const reviewerId = ctx.id(spec.reviewer);
    const people = spec.owner.type === "user" ? [ownerId] : await groupsService.expandIds([{ type: spec.owner.type, id: ownerId }]);

    const target = await Target.create({
      name: spec.name,
      description: spec.description,
      ownerType: spec.owner.type,
      ownerId,
      period: spec.period,
      startDate: bounds.start,
      endDate: bounds.end,
      unit: spec.unit,
      unitLabel: spec.unitLabel ?? null,
      startValue,
      targetValue: spec.targetValue,
      currentValue: startValue,
      reviewerId,
      status: spec.status ?? "active",
      evaluation: spec.status === "achieved" ? { rating: 5, note: "Consistently fast and friendly responses.", by: reviewerId, at: dayAt(-1, "16:00").toISOString() } : null,
      createdBy: reviewerId,
      createdAt: new Date(`${bounds.start}T09:00:00+01:00`),
    });

    const values: number[] = [];
    for (const userId of people) {
      const share = spec.progress * (0.85 + (hash(`${spec.name}:${userId}`) % 30) / 100);
      const value = Math.round((startValue + (spec.targetValue - startValue) * share) * 100) / 100;
      const assignment = await TargetAssignment.create({ targetId: target.id, userId, targetValue: spec.targetValue, currentValue: value });
      await TargetProgress.create({ targetId: target.id, assignmentId: assignment.id, value, delta: value - startValue, source: "manual", note: "Weekly update", recordedBy: userId, createdAt: dayAt(-2, "17:30") });
      values.push(value);
    }
    await target.update({ currentValue: rollup(values) });
  }
}
