import {
  AccessAssignment,
  AccessRole,
  CustomRole,
  Department,
  Label,
  NotificationPreference,
  Product,
  ProductMember,
  Project,
  Team,
  User,
} from "../../models";
import { hashPassword } from "../../lib/password";
import { rolesService } from "../../modules/roles/roles.service";
import { setAssociation, type SeedContext } from "./context";
import { CUSTOM_TITLES, DEMO_PASSWORD, DEPARTMENTS, LABELS, PEOPLE, PRODUCTS, PROJECTS, ROLE_ASSIGNMENTS, TEAMS, emailOf } from "./data";
import { dayString } from "./time";

export async function seedPeople(ctx: SeedContext): Promise<void> {
  for (const name of CUSTOM_TITLES) await CustomRole.findOrCreate({ where: { name }, defaults: { name } });
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  for (const [index, spec] of PEOPLE.entries()) {
    const profile = {
      name: spec.name,
      roles: await rolesService.normalize(spec.titles),
      accessLevel: spec.accessLevel,
      chiefBadge: spec.accessLevel === "chief",
      workMode: spec.workMode,
      onboarded: true,
    };
    const [user, created] = await User.findOrCreate({
      where: { email: emailOf(spec.key) },
      defaults: { ...profile, email: emailOf(spec.key), avatarColor: spec.color, passwordHash },
    });
    const employeeId = `MBP-${String(index + 1).padStart(3, "0")}`;
    const employeeIdFree = !user.employeeId && !(await User.findOne({ where: { employeeId }, attributes: ["id"] }));
    await user.update({
      ...(created ? {} : profile),
      ...(employeeIdFree ? { employeeId } : {}),
      ...(user.dateJoined ? {} : { dateJoined: dayString(-spec.joinedDaysAgo) }),
    });
    // Seeded addresses are not real inboxes, so no daily digest goes out to them.
    await NotificationPreference.findOrCreate({ where: { userId: user.id }, defaults: { userId: user.id, digestFrequency: "off" } });
    ctx.users.set(spec.key, user);
  }

  for (const spec of PEOPLE) {
    if (spec.reportsTo) await ctx.user(spec.key).update({ reportsToId: ctx.id(spec.reportsTo) });
  }
}

export async function seedStructure(ctx: SeedContext): Promise<void> {
  for (const spec of DEPARTMENTS) {
    const [dept] = await Department.findOrCreate({
      where: { slug: spec.slug },
      defaults: { slug: spec.slug, name: spec.name, description: spec.description, headId: ctx.id(spec.head) },
    });
    await setAssociation(dept, "setMembers", ctx.ids(spec.members));
    ctx.departments.set(spec.slug, dept);
  }

  for (const spec of LABELS) {
    const [label] = await Label.findOrCreate({ where: { name: spec.name }, defaults: spec });
    ctx.labels.set(spec.name, label);
  }

  for (const spec of PRODUCTS) {
    const [product] = await Product.findOrCreate({
      where: { name: spec.name },
      defaults: {
        name: spec.name,
        slug: spec.slug,
        description: spec.description,
        stage: spec.stage,
        tint: spec.tint,
        ownerId: ctx.id(spec.owner),
        senderName: spec.senderName ?? null,
        senderEmail: spec.senderEmail ?? null,
      },
    });
    for (const [person, title] of spec.members) {
      await ProductMember.findOrCreate({ where: { productId: product.id, userId: ctx.id(person) }, defaults: { productId: product.id, userId: ctx.id(person), title } });
    }
    ctx.products.set(spec.slug, product);
  }

  for (const spec of PROJECTS) {
    const dept = ctx.department(spec.department);
    const productId = spec.product ? ctx.product(spec.product).id : null;
    const [project] = await Project.findOrCreate({
      where: { name: spec.name },
      defaults: {
        departmentId: dept.id,
        name: spec.name,
        description: spec.description,
        techStack: spec.techStack ?? "",
        managerId: ctx.id(spec.manager),
        productId,
        progress: spec.progress,
      },
    });
    if (productId && !project.productId) await project.update({ productId });
    await setAssociation(project, "setDepartments", [dept.id]);
    await setAssociation(project, "setMembers", ctx.ids(spec.members));
    ctx.projects.set(spec.name, project);
  }

  for (const spec of TEAMS) {
    const [team] = await Team.findOrCreate({
      where: { slug: spec.slug },
      defaults: { slug: spec.slug, name: spec.name, description: spec.description, leadId: ctx.id(spec.lead) },
    });
    await setAssociation(team, "setMembers", ctx.ids(spec.members));
    await setAssociation(team, "setProjects", spec.projects.map((name) => ctx.project(name).id));
    ctx.teams.set(spec.slug, team);
  }
}

export async function seedAccessRoles(ctx: SeedContext): Promise<string[]> {
  const missing: string[] = [];
  for (const spec of ROLE_ASSIGNMENTS) {
    const role = await AccessRole.findOne({ where: { key: spec.role } });
    if (!role) {
      missing.push(spec.role);
      continue;
    }
    const scopeId = spec.scope === "product" ? ctx.product(spec.product!).id : null;
    const where = { roleId: role.id, subjectType: "user" as const, subjectId: ctx.id(spec.person), scopeType: spec.scope, scopeId };
    await AccessAssignment.findOrCreate({ where, defaults: { ...where, createdBy: ctx.id("ada") } });
  }
  return missing;
}
