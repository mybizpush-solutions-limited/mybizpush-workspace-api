import { Op } from "sequelize";
import { Meeting, Notification, NotificationPreference, User } from "../../models";
import { meService } from "../me/me.service";
import { sendEmail } from "../../lib/email";
import { env } from "../../config/env";

type DigestFrequency = "off" | "daily" | "weekly";

interface Prefs {
  digestFrequency: DigestFrequency;
  meetingReminders: boolean;
  pendingTasks: boolean;
  feedbackRequests: boolean;
  mentions: boolean;
  events: boolean;
}

const DEFAULT_PREFS: Prefs = {
  digestFrequency: "daily",
  meetingReminders: true,
  pendingTasks: true,
  feedbackRequests: true,
  mentions: true,
  events: false,
};

async function prefsFor(userId: string): Promise<Prefs> {
  const row = await NotificationPreference.findByPk(userId);
  return row ? (row.toJSON() as unknown as Prefs) : DEFAULT_PREFS;
}

function section(title: string, lines: string[]): string {
  if (!lines.length) return "";
  return `<h3 style="margin:16px 0 6px">${title}</h3><ul style="margin:0;padding-left:18px">${lines
    .map((l) => `<li>${l}</li>`)
    .join("")}</ul>`;
}

export interface BuiltDigest {
  subject: string;
  html: string;
  hasContent: boolean;
}

// Assemble a user's digest based on their channel preferences. `windowDays`
// scopes "due soon" and "upcoming meetings".
export async function buildDigest(userId: string, prefs: Prefs, windowDays: number): Promise<BuiltDigest> {
  const blocks: string[] = [];

  if (prefs.pendingTasks) {
    const due = await meService.dueSoon(userId, windowDays);
    blocks.push(
      section(
        "Pending work",
        due.map((it) => {
          const when = it.dueDate ? ` — due ${new Date(it.dueDate).toLocaleDateString()}` : "";
          return `<strong>${it.title}</strong> (${it.type}, ${it.status})${when}`;
        }),
      ),
    );
  }

  if (prefs.feedbackRequests) {
    const awaiting = await meService.awaitingFeedback(userId);
    blocks.push(
      section(
        "Awaiting your feedback",
        awaiting.map((it) => `<strong>${it.title}</strong> (${it.type})`),
      ),
    );
  }

  if (prefs.meetingReminders) {
    const now = new Date();
    const end = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
    const meetings = await Meeting.findAll({
      include: [{ model: User, as: "attendees", attributes: [], where: { id: userId }, through: { attributes: [] } }],
      where: { startsAt: { [Op.gte]: now, [Op.lte]: end } },
      order: [["startsAt", "ASC"]],
    });
    blocks.push(
      section(
        "Upcoming meetings",
        meetings.map((m) => `<strong>${m.title}</strong> — ${new Date(m.startsAt).toLocaleString()} · <a href="${m.meetUrl}">join</a>`),
      ),
    );
  }

  if (prefs.mentions) {
    const mentions = await Notification.findAll({
      where: { userId, kind: "mentioned", read: false },
      order: [["createdAt", "DESC"]],
      limit: 10,
    });
    blocks.push(section("You were mentioned", mentions.map((n) => n.message)));
  }

  const body = blocks.filter(Boolean).join("");
  const hasContent = body.length > 0;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
<h2 style="margin:0 0 4px">Your MyBizPush Dev Space digest</h2>
<p style="color:#666;margin:0 0 8px">Here's what needs you.</p>
${hasContent ? body : "<p>You're all clear — nothing needs you right now. 🎉</p>"}
<p style="margin-top:20px;color:#999;font-size:12px"><a href="${env.APP_URL}/profile">Manage your email preferences</a></p>
</div>`;

  return { subject: "Your MyBizPush Dev Space digest", html, hasContent };
}

// Build + send one user's digest (skips if they have nothing and aren't 'off').
export async function sendDigestToUser(user: { id: string; email: string }, windowDays: number): Promise<boolean> {
  const prefs = await prefsFor(user.id);
  if (prefs.digestFrequency === "off") return false;
  const digest = await buildDigest(user.id, prefs, windowDays);
  if (!digest.hasContent) return false;
  await sendEmail({ to: user.email, subject: digest.subject, html: digest.html });
  return true;
}

// Run digests for everyone whose cadence matches `frequency`.
export async function runDigests(frequency: "daily" | "weekly"): Promise<{ sent: number; considered: number }> {
  const windowDays = frequency === "weekly" ? 7 : 2;
  const users = await User.findAll({ attributes: ["id", "email"] });
  let sent = 0;
  let considered = 0;
  for (const user of users) {
    const prefs = await prefsFor(user.id);
    if (prefs.digestFrequency !== frequency) continue;
    considered += 1;
    if (await sendDigestToUser({ id: user.id, email: user.email }, windowDays)) sent += 1;
  }
  return { sent, considered };
}

export { prefsFor };
