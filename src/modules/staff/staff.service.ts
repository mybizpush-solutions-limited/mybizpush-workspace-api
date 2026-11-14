import { createHash, randomBytes } from "node:crypto";
import { Op } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { env } from "../../config/env";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { emails } from "../../lib/email";
import { hashPassword } from "../../lib/password";
import { meetsPasswordPolicy } from "../../lib/passwordPolicy";
import { revokeAllRefreshTokens } from "../../lib/jwt";
import {
  AccessAssignment,
  AccessRole,
  Department,
  DeviceToken,
  Invitation,
  Product,
  ProductMember,
  Team,
  User,
  type EmploymentStatus,
} from "./staff.models";
import { usersRepo, type PublicUser } from "../users/users.repo";
import { usersService } from "../users/users.service";
import { invalidateAccess } from "../access/engine";

// Staff administration (API-CHANGES A106): profile fields, suspension and
// invitations. Access is checked by the routes with the permission engine.

const INVITE_TTL_DAYS = 7;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function assertCompanyEmail(email: string) {
  const domain = `@${env.ALLOWED_EMAIL_DOMAIN}`.toLowerCase();
  if (!email.toLowerCase().endsWith(domain)) throw badRequest(`Use a ${domain} address`);
}

export interface InviteInput {
  email: string;
  name?: string;
  departmentId?: string;
  teamId?: string;
  productId?: string;
  productTitle?: string;
  roleId?: string;
  jobTitles?: string[];
}

export function inviteLink(token: string): string {
  return `${env.APP_URL.replace(/\/$/, "")}/invite?token=${encodeURIComponent(token)}`;
}

async function accessLabels(inv: Pick<Invitation, "departmentId" | "teamId" | "productId" | "productTitle" | "roleId">): Promise<string[]> {
  const [dept, team, product, role] = await Promise.all([
    inv.departmentId ? Department.findByPk(inv.departmentId, { attributes: ["name"] }) : null,
    inv.teamId ? Team.findByPk(inv.teamId, { attributes: ["name"] }) : null,
    inv.productId ? Product.findByPk(inv.productId, { attributes: ["name"] }) : null,
    inv.roleId ? AccessRole.findByPk(inv.roleId, { attributes: ["name"] }) : null,
  ]);
  return [dept?.name, team?.name, product?.name, role?.name ?? inv.productTitle ?? undefined].filter((x): x is string => !!x);
}

export function serializeInvitation(inv: Invitation) {
  return {
    id: inv.id,
    email: inv.email,
    name: inv.name ?? null,
    departmentId: inv.departmentId ?? null,
    teamId: inv.teamId ?? null,
    productId: inv.productId ?? null,
    roleId: inv.roleId ?? null,
    jobTitles: inv.jobTitles,
    source: inv.source,
    status: inv.acceptedAt ? "accepted" : inv.revokedAt ? "revoked" : inv.expiresAt < new Date() ? "expired" : "pending",
    expiresAt: inv.expiresAt.toISOString(),
    createdAt: inv.createdAt.toISOString(),
  };
}

export const staffService = {
  async updateProfile(
    id: string,
    patch: { name?: string; phone?: string | null; employeeId?: string | null; employmentStatus?: EmploymentStatus; dateJoined?: string | null; reportsToId?: string | null },
  ): Promise<{ before: PublicUser; after: PublicUser }> {
    const before = await usersRepo.publicById(id);
    if (!before) throw notFound("User not found");
    if (patch.reportsToId === id) throw badRequest("Someone can't report to themselves");
    if (patch.employeeId) {
      const taken = await User.count({ where: { employeeId: patch.employeeId, id: { [Op.ne]: id } } });
      if (taken) throw conflict("That employee ID is already used");
    }
    await User.update(
      {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.employeeId !== undefined ? { employeeId: patch.employeeId } : {}),
        ...(patch.employmentStatus !== undefined ? { employmentStatus: patch.employmentStatus } : {}),
        ...(patch.dateJoined !== undefined ? { dateJoined: patch.dateJoined } : {}),
        ...(patch.reportsToId !== undefined ? { reportsToId: patch.reportsToId } : {}),
      },
      { where: { id } },
    );
    return { before, after: (await usersRepo.publicById(id))! };
  },

  // Suspension blocks sign-in and refresh, signs out every device and stops push.
  async suspend(actorId: string, id: string, reason?: string): Promise<PublicUser> {
    if (actorId === id) throw badRequest("You can't suspend yourself");
    const user = await User.findByPk(id);
    if (!user) throw notFound("User not found");
    if (user.accessLevel === "executive_admin") throw forbidden("Executive admins can't be suspended");
    await user.update({ status: "suspended", suspendedAt: new Date(), suspendedReason: reason ?? null });
    await revokeAllRefreshTokens(id);
    await DeviceToken.update({ disabledAt: new Date() }, { where: { userId: id } }).catch(() => undefined);
    return (await usersRepo.publicById(id))!;
  },

  async activate(id: string): Promise<PublicUser> {
    const user = await User.findByPk(id);
    if (!user) throw notFound("User not found");
    await user.update({ status: "active", suspendedAt: null, suspendedReason: null });
    return (await usersRepo.publicById(id))!;
  },

  // ---- Invitations ------------------------------------------------------------

  async listInvitations(): Promise<ReturnType<typeof serializeInvitation>[]> {
    const rows = await Invitation.findAll({ where: { acceptedAt: { [Op.is]: null }, revokedAt: { [Op.is]: null } }, order: [["createdAt", "DESC"]] });
    return rows.map(serializeInvitation);
  },

  // Creates (or refreshes) an invite and optionally emails it. Returns the raw
  // token only to the caller that created it (for share links), never stored.
  async invite(inviterId: string, input: InviteInput, opts: { send: boolean; source?: string }): Promise<{ invitation: Invitation; token: string }> {
    const email = input.email.trim().toLowerCase();
    assertCompanyEmail(email);
    if (await usersRepo.emailTaken(email)) throw conflict(`${email} already has an account`);
    if (await usersService.isBlacklisted(email)) throw forbidden(`${email} is blocked from joining`);

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
    // One live invite per email: a re-invite replaces the previous one.
    await Invitation.update({ revokedAt: new Date() }, { where: { email, acceptedAt: { [Op.is]: null }, revokedAt: { [Op.is]: null } } });
    const invitation = await Invitation.create({
      email,
      name: input.name?.trim() || null,
      tokenHash: hash(token),
      invitedBy: inviterId,
      departmentId: input.departmentId ?? null,
      teamId: input.teamId ?? null,
      productId: input.productId ?? null,
      productTitle: input.productTitle ?? null,
      roleId: input.roleId ?? null,
      jobTitles: input.jobTitles ?? [],
      source: opts.source ?? "manual",
      expiresAt,
    });
    if (opts.send) await this.sendInvitation(invitation, token);
    return { invitation, token };
  },

  async sendInvitation(invitation: Invitation, token: string): Promise<void> {
    const inviter = invitation.invitedBy ? await User.findByPk(invitation.invitedBy, { attributes: ["name"] }) : null;
    await emails.invitation(invitation.email, inviter?.name ?? "MyBizPush", inviteLink(token), await accessLabels(invitation));
  },

  // Resend issues a fresh token (the old link stops working) and a new expiry.
  async resend(id: string): Promise<Invitation> {
    const inv = await Invitation.findByPk(id);
    if (!inv || inv.acceptedAt || inv.revokedAt) throw notFound("Invitation not found");
    const token = randomBytes(32).toString("base64url");
    await inv.update({ tokenHash: hash(token), expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000) });
    await this.sendInvitation(inv, token);
    return inv;
  },

  async revoke(id: string): Promise<void> {
    const inv = await Invitation.findByPk(id);
    if (!inv || inv.acceptedAt) throw notFound("Invitation not found");
    await inv.update({ revokedAt: new Date() });
  },

  // Public: what the accept screen shows (AUTH-03).
  async lookup(token: string) {
    const inv = await Invitation.findOne({ where: { tokenHash: hash(token) } });
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw badRequest("This invitation is no longer valid");
    const inviter = inv.invitedBy ? await User.findByPk(inv.invitedBy, { attributes: ["name"] }) : null;
    return { email: inv.email, name: inv.name ?? null, inviter: inviter?.name ?? null, access: await accessLabels(inv) };
  },

  // Creates the account and applies everything the invite granted, atomically.
  async accept(token: string, input: { name?: string; password: string }): Promise<User> {
    const inv = await Invitation.findOne({ where: { tokenHash: hash(token) } });
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw badRequest("This invitation is no longer valid");
    if (await usersRepo.emailTaken(inv.email)) throw conflict("An account with this email already exists");
    // Blocked after the invitation went out.
    if (await usersService.isBlacklisted(inv.email)) throw forbidden(`${inv.email} is blocked from joining`);
    const name = (input.name ?? inv.name ?? "").trim();
    if (!name) throw badRequest("Your name is required");
    const passwordHash = await hashPassword(input.password);

    const userId = await sequelize.transaction(async (transaction) => {
      const user = await User.create(
        { name, email: inv.email, passwordHash, passwordMeetsPolicy: meetsPasswordPolicy(input.password), roles: inv.jobTitles, onboarded: false, dateJoined: new Date().toISOString().slice(0, 10) },
        { transaction },
      );
      if (inv.departmentId) {
        const dept = await Department.findByPk(inv.departmentId, { transaction });
        if (dept) await (dept as unknown as { addMember: (u: User, o: object) => Promise<void> }).addMember(user, { transaction });
      }
      if (inv.teamId) {
        const team = await Team.findByPk(inv.teamId, { transaction });
        if (team) await (team as unknown as { addMember: (u: User, o: object) => Promise<void> }).addMember(user, { transaction });
      }
      if (inv.productId) {
        await ProductMember.findOrCreate({
          where: { productId: inv.productId, userId: user.id },
          defaults: { productId: inv.productId, userId: user.id, title: inv.productTitle ?? null },
          transaction,
        });
      }
      if (inv.roleId) {
        const role = await AccessRole.findByPk(inv.roleId, { transaction });
        if (role && role.key !== "executive_admin") {
          const scopeType = inv.productId && role.defaultScope === "product" ? "product" : "organization";
          await AccessAssignment.create(
            { roleId: role.id, subjectType: "user", subjectId: user.id, scopeType, scopeId: scopeType === "product" ? inv.productId : null, createdBy: inv.invitedBy },
            { transaction },
          );
        }
      }
      await inv.update({ acceptedAt: new Date(), acceptedUserId: user.id }, { transaction });
      return user.id;
    });
    await invalidateAccess();
    void emails.welcome(inv.email, name).catch(() => undefined);
    return (await User.findByPk(userId))!;
  },
};
