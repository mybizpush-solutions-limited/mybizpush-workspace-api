import { Department, NotificationPreference, User } from "../../models";

// Public shape returned to clients — mirrors ui/src/types/index.ts `User`.
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  avatarColor: string;
  roles: string[];
  accessLevel: "member" | "admin" | "executive_admin";
  departmentIds: string[];
}

// Serialize a User model (optionally with its `departments` association loaded)
// into the public API shape.
export function toPublicUser(user: User): PublicUser {
  const departments = (user.get("departments") as Department[] | undefined) ?? [];
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarColor: user.avatarColor,
    roles: user.roles,
    accessLevel: user.accessLevel,
    departmentIds: departments.map((d) => d.id),
  };
}

const withDepartments = {
  include: [{ model: Department, as: "departments", attributes: ["id"], through: { attributes: [] } }],
};

export const usersRepo = {
  rawByEmail: (email: string) =>
    User.findOne({ where: { email: email.toLowerCase() } }),

  publicById: async (id: string): Promise<PublicUser | undefined> => {
    const user = await User.findByPk(id, withDepartments);
    return user ? toPublicUser(user) : undefined;
  },

  list: async (): Promise<PublicUser[]> => {
    const users = await User.findAll({ ...withDepartments, order: [["name", "ASC"]] });
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
