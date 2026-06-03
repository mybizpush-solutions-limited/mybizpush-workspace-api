import { Op } from "sequelize";
import { Department, NotificationPreference, Project, User } from "../../models";

// Public shape returned to clients — mirrors ui/src/types/index.ts `User`.
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  secondaryEmail: string | null;
  avatarColor: string;
  avatarUrl: string | null;
  roles: string[];
  accessLevel: "member" | "admin" | "executive_admin";
  onboarded: boolean;
  departmentIds: string[];
  projectIds: string[];
}

// Serialize a User model (optionally with its `departments`/`projects`
// associations loaded) into the public API shape.
export function toPublicUser(user: User): PublicUser {
  const departments = (user.get("departments") as Department[] | undefined) ?? [];
  const projects = (user.get("projects") as Project[] | undefined) ?? [];
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    secondaryEmail: user.secondaryEmail ?? null,
    avatarColor: user.avatarColor,
    avatarUrl: user.avatarUrl ?? null,
    roles: user.roles,
    accessLevel: user.accessLevel,
    onboarded: user.onboarded,
    departmentIds: departments.map((d) => d.id),
    projectIds: projects.map((p) => p.id),
  };
}

const withMemberships = {
  include: [
    { model: Department, as: "departments", attributes: ["id"], through: { attributes: [] } },
    { model: Project, as: "projects", attributes: ["id"], through: { attributes: [] } },
  ],
};

export const usersRepo = {
  rawByEmail: (email: string) =>
    User.findOne({ where: { email: email.toLowerCase() } }),

  // Sign-in / reset lookups match either the primary or the secondary email.
  rawByEmailOrSecondary: (email: string) => {
    const e = email.toLowerCase();
    return User.findOne({ where: { [Op.or]: [{ email: e }, { secondaryEmail: e }] } });
  },

  // Is this email already taken (as a primary or secondary) by anyone?
  emailTaken: async (email: string, exceptUserId?: string): Promise<boolean> => {
    const e = email.toLowerCase();
    const row = await User.findOne({ where: { [Op.or]: [{ email: e }, { secondaryEmail: e }] } });
    return Boolean(row && row.id !== exceptUserId);
  },

  publicById: async (id: string): Promise<PublicUser | undefined> => {
    const user = await User.findByPk(id, withMemberships);
    return user ? toPublicUser(user) : undefined;
  },

  list: async (): Promise<PublicUser[]> => {
    const users = await User.findAll({ ...withMemberships, order: [["name", "ASC"]] });
    return users.map(toPublicUser);
  },

  create: async (input: {
    name: string;
    email: string;
    passwordHash: string;
    accessLevel?: PublicUser["accessLevel"];
  }): Promise<User> => {
    const user = await User.create({
      name: input.name,
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      accessLevel: input.accessLevel ?? "member",
    });
    // Seed default digest preferences so the row always exists.
    await NotificationPreference.findOrCreate({ where: { userId: user.id }, defaults: { userId: user.id } });
    return user;
  },
};
