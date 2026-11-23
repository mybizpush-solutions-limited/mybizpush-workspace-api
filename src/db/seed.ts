/**
 * Idempotent demo seed: a busy MyBizPush company with people, products, work,
 * chat, meetings, announcements, targets and attendance. Safe to run multiple
 * times. Every seeded user signs in with the password in seed/data.ts (DEMO_PASSWORD).
 *
 * Run with: npm run seed
 */
import { sequelize } from "./sequelize";
import {
  AccessAssignment,
  Announcement,
  AttendanceRecord,
  CalendarEvent,
  Campaign,
  ContentItem,
  Conversation,
  Department,
  Issue,
  Lead,
  Meeting,
  Message,
  Notification,
  Office,
  Product,
  Project,
  Target,
  Task,
  Team,
  User,
} from "../models";
import { SeedContext } from "./seed/context";
import { DEMO_PASSWORD, emailOf } from "./seed/data";
import { seedAccessRoles, seedPeople, seedStructure } from "./seed/org";
import { seedIssues, seedTasks } from "./seed/work";
import { seedChat } from "./seed/chat";
import { seedCalendarEvents, seedMeetings } from "./seed/calendar";
import { seedAnnouncements } from "./seed/announcements";
import { seedTargets } from "./seed/targets";
import { seedAttendance } from "./seed/attendance";
import { seedMarketing } from "./seed/marketing";
import { seedNotifications } from "./seed/notifications";

const ACCESS_CACHE_TIMEOUT_MS = 3_000;

// Cached permission grants would hide the new roles for a few minutes. Redis is
// optional for seeding, so a missing server only skips this step.
async function invalidateAccessCache(): Promise<void> {
  const { redis } = await import("../redis/client");
  const { invalidateAccess } = await import("../modules/access/engine");
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ACCESS_CACHE_TIMEOUT_MS).unref());
  const outcome = await Promise.race([invalidateAccess().then(() => "ok" as const), timeout]).catch(() => "failed" as const);
  if (outcome !== "ok") console.warn("Access cache not cleared (Redis unavailable). Permissions refresh within 5 minutes.");
  redis.disconnect();
}

async function summary(): Promise<void> {
  const tables = { User, Department, Team, Product, Project, Task, Issue, Meeting, CalendarEvent, Conversation, Message, Announcement, Target, Office, AttendanceRecord, AccessAssignment, Lead, Campaign, ContentItem, Notification };
  const counts = await Promise.all(Object.entries(tables).map(async ([name, model]) => `${name}: ${await (model as unknown as { count(): Promise<number> }).count()}`));
  console.info(`Seed complete.\n  ${counts.join("\n  ")}`);
  console.info(`Sign in as ${emailOf("ada")} (chief) or any seeded email with password: ${DEMO_PASSWORD}`);
}

async function seed() {
  await sequelize.authenticate();
  const ctx = new SeedContext();

  await seedPeople(ctx);
  await seedStructure(ctx);
  const missingRoles = await seedAccessRoles(ctx);
  if (missingRoles.length) console.warn(`Access roles not found, run migrations first: ${missingRoles.join(", ")}`);
  await seedTasks(ctx);
  await seedIssues(ctx);
  await seedChat(ctx);
  await seedMeetings(ctx);
  await seedCalendarEvents(ctx);
  await seedAnnouncements(ctx);
  await seedTargets(ctx);
  await seedAttendance(ctx);
  await seedMarketing(ctx);
  await seedNotifications(ctx);

  await invalidateAccessCache();
  await summary();
  await sequelize.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
