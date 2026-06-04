import { QueryTypes } from "sequelize";
import { sequelize } from "../../db/sequelize";
import {
  Activity,
  BlacklistedEmail,
  Comment,
  Department,
  DepartmentJoinRequest,
  GithubAccount,
  GoogleAccount,
  Issue,
  Meeting,
  Notification,
  NotificationPreference,
  Project,
  Task,
  User,
} from "../../models";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { revokeAllRefreshTokens } from "../../lib/jwt";
import { usersRepo, type PublicUser } from "./users.repo";

type AccessLevel = "member" | "admin" | "chief" | "executive_admin";

// Join tables that carry a user_id — cleared with raw deletes (the through
// models aren't exported as named classes).
const USER_JOIN_TABLES = [
  "department_members",
  "project_members",
  "task_assignees",
  "issue_assignees",
  "comment_mentions",
  "meeting_attendees",
];

export const usersService = {
  // Permanently remove a user and de-identify everything they touched. Tasks,
  // issues, comments and activity are kept but their author/reporter/assignee
  // references are cleared, so no orphaned foreign keys remain. The email
  // becomes reusable unless `blacklist` is set, which bans it from signing up
  // again. Exec-only; callers must not delete themselves.
  async remove(actingUserId: string, targetId: string, blacklist: boolean): Promise<void> {
    if (actingUserId === targetId) throw badRequest("You can't delete your own account here");
    const user = await User.findByPk(targetId);
    if (!user) throw notFound("User not found");
    if (user.accessLevel === "executive_admin") {
      throw forbidden("Executives can't be deleted from here — change their access level first");
    }

    const emails = [user.email, user.secondaryEmail].filter((e): e is string => Boolean(e));

    await sequelize.transaction(async (tx) => {
      // Null scalar references so the work survives without a dangling FK.
      await Department.update({ headId: null }, { where: { headId: targetId }, transaction: tx });
      await Project.update({ managerId: null }, { where: { managerId: targetId }, transaction: tx });
      for (const M of [Task, Issue]) {
        await M.update({ reporterId: null }, { where: { reporterId: targetId }, transaction: tx });
        await M.update({ feedbackAwaitingFrom: null }, { where: { feedbackAwaitingFrom: targetId }, transaction: tx });
        await M.update({ feedbackRequestedBy: null }, { where: { feedbackRequestedBy: targetId }, transaction: tx });
      }
      await Comment.update({ authorId: null }, { where: { authorId: targetId }, transaction: tx });
      await Activity.update({ actorId: null }, { where: { actorId: targetId }, transaction: tx });
      await Meeting.update({ organizerId: null }, { where: { organizerId: targetId }, transaction: tx });
      await Notification.update({ fromUserId: null }, { where: { fromUserId: targetId }, transaction: tx });

      // Delete rows the user owns outright.
      await Notification.destroy({ where: { userId: targetId }, transaction: tx });
      await NotificationPreference.destroy({ where: { userId: targetId }, transaction: tx });
      await GoogleAccount.destroy({ where: { userId: targetId }, transaction: tx });
      await GithubAccount.destroy({ where: { userId: targetId }, transaction: tx });
      await DepartmentJoinRequest.destroy({ where: { userId: targetId }, transaction: tx });

      // Clear membership / assignee / mention / attendee join rows.
      for (const table of USER_JOIN_TABLES) {
        await sequelize.query(`DELETE FROM "${table}" WHERE user_id = :id`, {
          replacements: { id: targetId },
          type: QueryTypes.DELETE,
          transaction: tx,
        });
      }

      if (blacklist) {
        for (const email of emails) {
          await BlacklistedEmail.findOrCreate({
            where: { email: email.toLowerCase() },
            defaults: { email: email.toLowerCase(), reason: "Blacklisted by an executive" },
            transaction: tx,
          });
        }
      }

      await user.destroy({ transaction: tx });
    });

    await revokeAllRefreshTokens(targetId);
  },

  // Exec-only: promote/demote a member's access level (member ↔ admin ↔
  // executive_admin). This is what actually makes someone an executive — it's
  // separate from which department they belong to.
  async setAccessLevel(
    actingUserId: string,
    targetId: string,
    level: AccessLevel,
  ): Promise<PublicUser> {
    if (actingUserId === targetId) throw badRequest("You can't change your own access level");
    const user = await User.findByPk(targetId);
    if (!user) throw notFound("User not found");
    user.accessLevel = level;
    await user.save();
    return (await usersRepo.publicById(targetId))!;
  },

  // Is this email banned from signing up?
  async isBlacklisted(email: string): Promise<boolean> {
    const row = await BlacklistedEmail.findOne({ where: { email: email.toLowerCase() } });
    return Boolean(row);
  },
};
