import { AttendanceRecord, Office } from "../../models";
import { attendanceService } from "../../modules/attendance/attendance.service";
import type { SeedContext } from "./context";
import { OFFICES, PEOPLE } from "./data";
import { clock, dayAt, dayString, hash, now, weekdayIndex, workingDaysBack } from "./time";

const HYBRID_OFFICE_DAYS = [0, 2, 3];

export async function seedAttendance(ctx: SeedContext): Promise<void> {
  const offices = new Map<string, Office>();
  for (const spec of OFFICES) {
    let office = await Office.findOne({ where: { name: spec.name } });
    if (!office) {
      const created = await attendanceService.createOffice({ name: spec.name, address: spec.address, lateAfter: spec.lateAfter }, ctx.id("tunde"));
      office = await Office.findByPk(created.id);
    }
    offices.set(spec.key, office!);
  }

  const days = workingDaysBack(20);
  for (const person of PEOPLE) {
    if (person.workMode === "remote" || !person.office) continue;
    const office = offices.get(person.office)!;
    const userId = ctx.id(person.key);
    for (const offset of days) {
      const seed = `${person.key}:${offset}`;
      if (person.workMode === "hybrid" && !HYBRID_OFFICE_DAYS.includes(weekdayIndex(offset))) continue;
      if (hash(`${seed}:absent`) % 17 === 0) continue;
      const lateBias = person.lateProne ? 35 : 0;
      const arrival = 7 * 60 + 50 + (hash(seed) % 70) + lateBias;
      const checkInAt = dayAt(offset, clock(arrival));
      if (checkInAt > now) continue;
      const checkOut = dayAt(offset, clock(17 * 60 + (hash(`${seed}:out`) % 95)));
      await AttendanceRecord.findOrCreate({
        where: { userId, day: dayString(offset) },
        defaults: {
          userId,
          officeId: office.id,
          day: dayString(offset),
          checkInAt,
          checkOutAt: checkOut < now ? checkOut : null,
          status: clock(arrival) > office.lateAfter ? "late" : "present",
        },
      });
    }
  }
}
