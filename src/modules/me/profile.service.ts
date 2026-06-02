import { Department, Project, ROLES, User } from "../../models";
import { badRequest, notFound } from "../../lib/errors";
import { env } from "../../config/env";
import { uploadBuffer } from "../../lib/cloudinary";
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

  async completeOnboarding(userId: string): Promise<PublicUser> {
    const user = await User.findByPk(userId);
    if (!user) throw notFound("User not found");
    user.onboarded = true;
    await user.save();
    return publicUser(userId);
  },

  async joinDepartment(userId: string, departmentId: string): Promise<PublicUser> {
    const dept = await Department.findByPk(departmentId);
    if (!dept) throw notFound("Department not found");
    const user = await User.findByPk(userId);
    if (!user) throw notFound("User not found");
    await (user as any).addDepartment(departmentId);
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
