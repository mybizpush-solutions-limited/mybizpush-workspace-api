import { Op } from "sequelize";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { AttendanceRecord, Office, OrganizationSetting, User, type WorkMode } from "../../models";
import { issueCode, localDayAndTime, newCodeSecret, parseCode, verifyCode } from "./attendance.code";

const DEFAULT_TIME_ZONE = "Africa/Lagos";
const MAX_REPORT_DAYS = 370;

export type OfficeInput = { name: string; address?: string | null; lateAfter?: string };

function serializeOffice(office: Office) {
  return { id: office.id, name: office.name, address: office.address ?? null, lateAfter: office.lateAfter, active: office.active, createdAt: office.createdAt.toISOString() };
}

function serializeRecord(record: AttendanceRecord) {
  const user = record.get("user") as User | undefined;
  const office = record.get("office") as Office | undefined;
  return {
    id: record.id,
    userId: record.userId,
    officeId: record.officeId,
    day: record.day,
    status: record.status,
    checkInAt: record.checkInAt.toISOString(),
    checkOutAt: record.checkOutAt?.toISOString() ?? null,
    user: user ? { id: user.id, name: user.name, avatarUrl: user.avatarUrl ?? null, workMode: user.workMode } : undefined,
    office: office ? { id: office.id, name: office.name } : undefined,
  };
}

const withPeople = { include: [{ model: User, as: "user", attributes: ["id", "name", "avatarUrl", "workMode"] }, { model: Office, as: "office", attributes: ["id", "name"] }] };

async function timeZone(): Promise<string> {
  return (await OrganizationSetting.findByPk(1))?.timezone ?? DEFAULT_TIME_ZONE;
}

async function officeFromCode(code: string): Promise<Office> {
  const parsed = parseCode(code);
  if (!parsed) throw badRequest("That isn't a MyBizPush office code");
  const office = await Office.findByPk(parsed.officeId);
  if (!office || !office.active) throw badRequest("This office code is no longer in use");
  if (!verifyCode(parsed, office.codeSecret)) throw badRequest("This code has expired. Scan the code on the office screen again.");
  return office;
}

function assertRange(from: string, to: string) {
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (!(span >= 0)) throw badRequest("from must be on or before to");
  if (span > MAX_REPORT_DAYS) throw badRequest(`Choose at most ${MAX_REPORT_DAYS} days`);
}

export const attendanceService = {
  async offices(includeInactive: boolean) {
    const offices = await Office.findAll({ where: includeInactive ? {} : { active: true }, order: [["name", "ASC"]] });
    return offices.map(serializeOffice);
  },

  async createOffice(input: OfficeInput, actorId: string) {
    const office = await Office.create({ name: input.name, address: input.address ?? null, lateAfter: input.lateAfter ?? "09:15", codeSecret: newCodeSecret(), createdBy: actorId });
    return serializeOffice(office);
  },

  async updateOffice(id: string, patch: Partial<OfficeInput> & { active?: boolean }) {
    const office = await Office.findByPk(id);
    if (!office) throw notFound("Office not found");
    await office.update(patch);
    return serializeOffice(office);
  },

  // Invalidates every code shown so far, e.g. after a photo of the screen leaks.
  async rotateSecret(id: string) {
    const office = await Office.findByPk(id);
    if (!office) throw notFound("Office not found");
    await office.update({ codeSecret: newCodeSecret() });
    return serializeOffice(office);
  },

  async currentCode(id: string) {
    const office = await Office.findByPk(id);
    if (!office || !office.active) throw notFound("Office not found");
    const { code, expiresAt } = issueCode(office.id, office.codeSecret);
    return { office: serializeOffice(office), code, expiresAt: expiresAt.toISOString() };
  },

  async checkIn(userId: string, code: string) {
    const user = await User.findByPk(userId, { attributes: ["id", "workMode", "status"] });
    if (!user || user.status !== "active") throw forbidden("Your account can't check in");
    if (user.workMode === "remote") throw forbidden("Remote staff don't check in at the office");
    const office = await officeFromCode(code);
    const now = new Date();
    const { day, time } = localDayAndTime(now, await timeZone());
    const existing = await AttendanceRecord.findOne({ where: { userId, day } });
    if (existing) throw conflict("You've already checked in today");
    const record = await AttendanceRecord.create({ userId, officeId: office.id, day, checkInAt: now, status: time > office.lateAfter ? "late" : "present" });
    return serializeRecord((await AttendanceRecord.findByPk(record.id, withPeople))!);
  },

  async checkOut(userId: string, code: string) {
    const office = await officeFromCode(code);
    const { day } = localDayAndTime(new Date(), await timeZone());
    const record = await AttendanceRecord.findOne({ where: { userId, day } });
    if (!record) throw badRequest("You haven't checked in today");
    if (record.checkOutAt) throw conflict("You've already checked out today");
    if (record.officeId !== office.id) throw badRequest("Check out at the office you checked in at");
    await record.update({ checkOutAt: new Date() });
    return serializeRecord((await AttendanceRecord.findByPk(record.id, withPeople))!);
  },

  async mine(userId: string, range: { from: string; to: string }) {
    assertRange(range.from, range.to);
    const { day } = localDayAndTime(new Date(), await timeZone());
    const records = await AttendanceRecord.findAll({ where: { userId, day: { [Op.between]: [range.from, range.to] } }, ...withPeople, order: [["day", "DESC"]] });
    const today = records.find((record) => record.day === day);
    return { today: today ? serializeRecord(today) : null, day, records: records.map(serializeRecord) };
  },

  // One day across the organization: who came in, and which onsite staff didn't.
  async day(date: string | undefined, officeId?: string) {
    const day = date ?? localDayAndTime(new Date(), await timeZone()).day;
    const records = await AttendanceRecord.findAll({ where: { day, ...(officeId ? { officeId } : {}) }, ...withPeople, order: [["checkInAt", "ASC"]] });
    const seen = new Set(records.map((record) => record.userId));
    const onsite = await User.findAll({ where: { status: "active", workMode: "onsite" }, attributes: ["id", "name", "avatarUrl", "workMode"], order: [["name", "ASC"]] });
    return {
      day,
      records: records.map(serializeRecord),
      absent: onsite.filter((user) => !seen.has(user.id)).map((user) => ({ id: user.id, name: user.name, avatarUrl: user.avatarUrl ?? null, workMode: user.workMode })),
    };
  },

  async report(range: { from: string; to: string }) {
    assertRange(range.from, range.to);
    const [records, people] = await Promise.all([
      AttendanceRecord.findAll({ where: { day: { [Op.between]: [range.from, range.to] } }, attributes: ["userId", "status", "checkInAt", "checkOutAt"] }),
      User.findAll({ where: { status: "active", workMode: { [Op.ne]: "remote" } }, attributes: ["id", "name", "workMode"], order: [["name", "ASC"]] }),
    ]);
    const byUser = new Map<string, { present: number; late: number; minutes: number }>();
    for (const record of records) {
      const row = byUser.get(record.userId) ?? { present: 0, late: 0, minutes: 0 };
      if (record.status === "late") row.late += 1;
      else row.present += 1;
      if (record.checkOutAt) row.minutes += Math.max(0, (record.checkOutAt.getTime() - record.checkInAt.getTime()) / 60_000);
      byUser.set(record.userId, row);
    }
    const rows = people.map((person) => {
      const row = byUser.get(person.id) ?? { present: 0, late: 0, minutes: 0 };
      return { userId: person.id, name: person.name, workMode: person.workMode as WorkMode, daysAttended: row.present + row.late, onTime: row.present, late: row.late, hoursOnSite: Math.round(row.minutes / 6) / 10 };
    });
    return {
      from: range.from,
      to: range.to,
      totals: { people: rows.length, checkIns: records.length, late: records.filter((record) => record.status === "late").length },
      rows,
    };
  },

  toCsv(report: { rows: Array<{ name: string; workMode: string; daysAttended: number; onTime: number; late: number; hoursOnSite: number }> }): string {
    const escape = (value: string | number) => {
      // A leading quote stops spreadsheets running a name like "=cmd()" as a formula.
      const text = /^[=+\-@]/.test(String(value)) && typeof value === "string" ? `'${value}` : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const header = ["Name", "Work mode", "Days attended", "On time", "Late", "Hours on site"];
    const lines = report.rows.map((row) => [row.name, row.workMode, row.daysAttended, row.onTime, row.late, row.hoursOnSite].map(escape).join(","));
    return [header.join(","), ...lines].join("\n");
  },
};
