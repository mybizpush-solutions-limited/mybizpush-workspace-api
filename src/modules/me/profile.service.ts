import { Department, GithubAccount, GoogleAccount, Project, ROLES, User } from "../../models";
import { badRequest, notFound } from "../../lib/errors";
import { env } from "../../config/env";
import { uploadBuffer } from "../../lib/cloudinary";
import { isOAuthConfigured } from "../../lib/github";
import { isGoogleConfigured } from "../../lib/google";
import { usersRepo, type PublicUser } from "../users/users.repo";

const ALLOWED_AVATAR_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
const MAX_AVATAR_MB = 8;
const ROLE_SET = new Set<string>(ROLES);

interface AvatarFile {
  buffer: Buffer;
  originalname: string;
  size: number;
  mimetype: string;
}

// Re-read the user in its public shape after any mutation.
async function publicUser(userId: string): Promise<PublicUser> {
  const user = await usersRepo.publicById(userId);
  if (!user) throw notFound("User not found");
  return user;
}

export const profileService = {
  // Patch the caller's own name / roles. Roles are validated against the
  // canonical list so the picker can't smuggle in arbitrary strings.
  async updateProfile(
    userId: string,
    patch: { name?: string; roles?: string[] },
  ): Promise<PublicUser> {
    const user = await User.findByPk(userId);
    if (!user) throw notFound("User not found");

    if (patch.name !== undefined) user.name = patch.name;
    if (patch.roles !== undefined) {
      const invalid = patch.roles.filter((r) => !ROLE_SET.has(r));
      if (invalid.length) throw badRequest(`Unknown role(s): ${invalid.join(", ")}`);
      user.roles = [...new Set(patch.roles)];
    }
    await user.save();
    return publicUser(userId);
  },

  // Upload an avatar image to Cloudinary, replacing any previous one.
  async setAvatar(userId: string, file: AvatarFile): Promise<PublicUser> {
    const ext = file.originalname.slice(file.originalname.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED_AVATAR_EXTENSIONS.includes(ext)) {
      throw badRequest(`Avatar must be one of: ${ALLOWED_AVATAR_EXTENSIONS.join(", ")}`);
    }
    if (file.size > MAX_AVATAR_MB * 1024 * 1024) {
      throw badRequest(`Avatar must be ${MAX_AVATAR_MB}MB or smaller`);
    }

    const user = await User.findByPk(userId);
    if (!user) throw notFound("User not found");

    const result = await uploadBuffer(file.buffer, {
      folder: `${env.CLOUDINARY_UPLOAD_FOLDER}/avatars`,
      resourceType: "image",
      tags: ["avatar", userId],
      publicId: userId, // one asset per user — overwrites the previous upload
    });

    user.avatarUrl = result.secure_url;
    await user.save();
    return publicUser(userId);
  },

  // Onboarding requires a profile picture, one department, at least one project,
  // and at least one connected tool — GitHub OR Google (neither is compulsory on
  // its own). If GitHub is the one they connect, it must be a verified org member.
  async completeOnboarding(userId: string): Promise<PublicUser> {
    const user = await User.findByPk(userId);
    if (!user) throw notFound("User not found");

    const me = await publicUser(userId);
    const missing: string[] = [];
    if (!me.avatarUrl) missing.push("a profile picture");
    if (me.departmentIds.length === 0) missing.push("a department");
    if (me.projectIds.length === 0) missing.push("at least one project");

    const githubConfigured = isOAuthConfigured();
    const googleConfigured = isGoogleConfigured();
    let githubConnected = false;
    let googleConnected = false;

    if (githubConfigured) {
      const gh = await GithubAccount.findByPk(userId);
      githubConnected = Boolean(gh?.accessToken);
      // Org membership is only enforced for those who choose to connect GitHub.
      if (githubConnected && env.GITHUB_ORG && !gh!.orgMember) {
        throw badRequest(
          `Your connected GitHub account (@${gh!.login ?? "unknown"}) isn't a member of the ${env.GITHUB_ORG} organization. Ask an admin for an invite, then reconnect.`,
        );
      }
    }
    if (googleConfigured) {
      googleConnected = Boolean(await GoogleAccount.findByPk(userId));
    }

    // Require at least one connected tool when any integration is configured.
    if ((githubConfigured || googleConfigured) && !githubConnected && !googleConnected) {
      missing.push("GitHub or Google");
    }

    if (missing.length) {
      throw badRequest(`Finish onboarding first — still need: ${missing.join(", ")}.`);
    }

    user.onboarded = true;
    await user.save();
    return publicUser(userId);
  },

  // Self-join is only for onboarding, where the user picks exactly one
  // department. After onboarding, joining another goes through a request that a
  // department head or executive admin approves.
  async joinDepartment(userId: string, departmentId: string): Promise<PublicUser> {
    const dept = await Department.findByPk(departmentId);
    if (!dept) throw notFound("Department not found");
    const user = await User.findByPk(userId);
    if (!user) throw notFound("User not found");
    if (user.onboarded) {
      throw badRequest("Request to join — a department head or admin will add you.");
    }
    // Onboarding: this is the user's single department, so it replaces any prior pick.
    await (user as any).setDepartments([departmentId]);
    return publicUser(userId);
  },

  async leaveDepartment(userId: string, departmentId: string): Promise<PublicUser> {
    const user = await User.findByPk(userId);
    if (!user) throw notFound("User not found");
    await (user as any).removeDepartment(departmentId);
    return publicUser(userId);
  },

  async joinProject(userId: string, projectId: string): Promise<PublicUser> {
    const project = await Project.findByPk(projectId);
    if (!project) throw notFound("Project not found");
    const user = await User.findByPk(userId);
    if (!user) throw notFound("User not found");
    await (user as any).addProject(projectId);
    return publicUser(userId);
  },

  async leaveProject(userId: string, projectId: string): Promise<PublicUser> {
    const user = await User.findByPk(userId);
    if (!user) throw notFound("User not found");
    await (user as any).removeProject(projectId);
    return publicUser(userId);
  },
};
