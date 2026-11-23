import { Op } from "sequelize";
import { env } from "../../config/env";
import { uploadBuffer } from "../../lib/cloudinary";
import { moveRoutingRule, type RoutingMove } from "../../lib/cloudflareEmail";
import { renderEmail, sendEmail } from "../../lib/email";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { revokeAllRefreshTokens } from "../../lib/jwt";
import { ProfileChangeRequest, User, type ProfileChanges } from "../../models";
import { can } from "../access/engine";
import { escapeHtml } from "../marketing/campaign.render";
import { notify } from "../shared/events";
import { usersRepo } from "../users/users.repo";

export const APPROVE_PERMISSION = "staff.approve_changes";
const AVATAR_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

type Actor = { sub: string };
type AvatarFile = { buffer: Buffer; originalname: string; size: number };

function describe(changes: ProfileChanges) {
  const parts: string[] = [];
  if (changes.name !== undefined) parts.push("name");
  if (changes.phone !== undefined) parts.push("phone");
  if (changes.secondaryEmail !== undefined) parts.push("second email");
  if (changes.avatarUrl !== undefined) parts.push("photo");
  return parts.join(", ") || "details";
}

async function approverIds(exceptUserId: string): Promise<string[]> {
  const candidates = await User.findAll({ where: { status: "active", id: { [Op.ne]: exceptUserId } }, attributes: ["id"] });
  const allowed = await Promise.all(candidates.map(async (u) => ((await can({ sub: u.id }, APPROVE_PERMISSION)) ? u.id : null)));
  return allowed.filter((id): id is string => id !== null);
}

async function serialize(request: ProfileChangeRequest) {
  const [person, reviewer] = await Promise.all([
    usersRepo.publicById(request.userId),
    request.reviewerId ? User.findByPk(request.reviewerId, { attributes: ["id", "name"] }) : null,
  ]);
  return {
    id: request.id,
    status: request.status,
    changes: request.changes,
    current: person ? { name: person.name, phone: person.phone ?? null, secondaryEmail: person.secondaryEmail ?? null, avatarUrl: person.avatarUrl ?? null } : null,
    user: person ? { id: person.id, name: person.name, email: person.email, avatarUrl: person.avatarUrl ?? null, avatarColor: person.avatarColor } : null,
    reviewer: reviewer ? { id: reviewer.id, name: reviewer.name } : null,
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
    reviewNote: request.reviewNote ?? null,
    createdAt: request.createdAt.toISOString(),
  };
}

async function assertApprover(actor: Actor) {
  if (!(await can(actor, APPROVE_PERMISSION))) throw forbidden("Only HR, admins or chiefs can approve staff details");
}

async function emailAvailable(email: string, exceptUserId: string) {
  const taken = await User.findOne({ where: { id: { [Op.ne]: exceptUserId }, [Op.or]: [{ email }, { secondaryEmail: email }] }, attributes: ["id"] });
  return !taken;
}

export const profileChangesService = {
  // Not-yet-onboarded people still fill in their own details; after that every edit is a request.
  async submit(userId: string, changes: ProfileChanges) {
    const user = await User.findByPk(userId);
    if (!user) throw notFound("User not found");
    const cleaned: ProfileChanges = {};
    if (changes.name !== undefined && changes.name.trim() !== user.name) cleaned.name = changes.name.trim();
    if (changes.phone !== undefined && (changes.phone || null) !== (user.phone ?? null)) cleaned.phone = changes.phone || null;
    if (changes.secondaryEmail !== undefined && (changes.secondaryEmail?.toLowerCase() || null) !== (user.secondaryEmail ?? null)) {
      const email = changes.secondaryEmail?.toLowerCase() || null;
      if (email && !(await emailAvailable(email, userId))) throw conflict("That email already belongs to someone");
      cleaned.secondaryEmail = email;
    }
    if (changes.avatarUrl) cleaned.avatarUrl = changes.avatarUrl;
    if (!Object.keys(cleaned).length) throw badRequest("Nothing has changed");

    const pending = await ProfileChangeRequest.findOne({ where: { userId, status: "pending" } });
    const request = pending
      ? await pending.update({ changes: { ...pending.changes, ...cleaned } })
      : await ProfileChangeRequest.create({ userId, changes: cleaned });

    for (const approverId of await approverIds(userId)) {
      await notify({ userId: approverId, fromUserId: userId, kind: "submitted", itemId: request.id, itemType: "profile_change", message: `${user.name} asked to update their ${describe(request.changes)}` });
    }
    return serialize(request);
  },

  // The photo is stored under a pending name so the current one stays until approval.
  async submitAvatar(userId: string, file: AvatarFile) {
    const ext = file.originalname.slice(file.originalname.lastIndexOf(".")).toLowerCase();
    if (!AVATAR_EXTENSIONS.includes(ext)) throw badRequest("Photo must be a PNG, JPG or WebP image");
    if (file.size > MAX_AVATAR_BYTES) throw badRequest("Photo must be 8MB or smaller");
    const result = await uploadBuffer(file.buffer, { folder: `${env.CLOUDINARY_UPLOAD_FOLDER}/avatars/pending`, resourceType: "image", tags: ["avatar", "pending", userId], publicId: `${userId}-${Date.now()}` });
    return this.submit(userId, { avatarUrl: result.secure_url });
  },

  async mine(userId: string) {
    const rows = await ProfileChangeRequest.findAll({ where: { userId }, order: [["createdAt", "DESC"]], limit: 10 });
    return Promise.all(rows.map(serialize));
  },

  async cancel(userId: string, id: string) {
    const request = await ProfileChangeRequest.findOne({ where: { id, userId, status: "pending" } });
    if (!request) throw notFound("No pending request to cancel");
    await request.update({ status: "cancelled" });
  },

  async list(actor: Actor, status: "pending" | "all") {
    await assertApprover(actor);
    const rows = await ProfileChangeRequest.findAll({ where: status === "pending" ? { status: "pending" } : {}, order: [["createdAt", "DESC"]], limit: 100 });
    return Promise.all(rows.map(serialize));
  },

  async decide(actor: Actor, id: string, approve: boolean, note?: string) {
    await assertApprover(actor);
    const request = await ProfileChangeRequest.findByPk(id);
    if (!request || request.status !== "pending") throw notFound("This request is no longer pending");
    if (request.userId === actor.sub) throw forbidden("Someone else has to approve changes to your own details");

    if (approve) {
      const user = await User.findByPk(request.userId);
      if (!user) throw notFound("User not found");
      const { name, phone, avatarUrl, secondaryEmail } = request.changes;
      if (name !== undefined) user.name = name;
      if (phone !== undefined) user.phone = phone;
      if (avatarUrl) user.avatarUrl = avatarUrl;
      await user.save();
      if (secondaryEmail !== undefined) {
        const { authService } = await import("../auth/auth.service");
        // The address still has to prove it's theirs before it can sign in.
        if (secondaryEmail === null) await authService.removeSecondaryEmail(user.id);
        else await authService.requestSecondaryEmailOtp(user.id, secondaryEmail);
      }
    }

    await request.update({ status: approve ? "approved" : "rejected", reviewerId: actor.sub, reviewedAt: new Date(), reviewNote: note?.trim() || null });
    await notify({
      userId: request.userId,
      fromUserId: actor.sub,
      kind: approve ? "approved" : "rejected",
      itemId: request.id,
      itemType: "profile_change",
      message: approve ? `Your ${describe(request.changes)} update was approved` : `Your ${describe(request.changes)} update was declined${note ? `: ${note}` : ""}`,
    });
    return serialize(request);
  },

  // Sign-in email change by an approver, e.g. a role mailbox moving from cro@ to coo@.
  async changeEmail(actor: Actor, userId: string, nextEmail: string): Promise<{ email: string; routing: RoutingMove }> {
    await assertApprover(actor);
    const email = nextEmail.trim().toLowerCase();
    if (!email.endsWith(`@${env.ALLOWED_EMAIL_DOMAIN.toLowerCase()}`)) throw badRequest(`Use a @${env.ALLOWED_EMAIL_DOMAIN} address`);
    const user = await User.findByPk(userId);
    if (!user) throw notFound("User not found");
    const previous = user.email.toLowerCase();
    if (previous === email) throw badRequest("That is already their email");
    if (!(await emailAvailable(email, userId))) throw conflict("That email already belongs to someone");

    const routing = await moveRoutingRule(previous, email);
    user.email = email;
    await user.save();
    await revokeAllRefreshTokens(userId);

    const html = renderEmail({
      preheader: "Your MyBizPush Workspace sign-in email changed",
      heading: "Your sign-in email changed",
      bodyHtml: `<p>Hi ${escapeHtml(user.name)},</p><p>Your MyBizPush Workspace sign-in email is now <strong>${escapeHtml(email)}</strong> (it was ${escapeHtml(previous)}). You've been signed out on every device; sign in again with the new address.</p><p>If you didn't expect this, contact HR straight away.</p>`,
    });
    await Promise.all([previous, email].map((to) => sendEmail({ to, subject: "Your sign-in email changed", html }).catch(() => undefined)));
    return { email, routing };
  },
};
