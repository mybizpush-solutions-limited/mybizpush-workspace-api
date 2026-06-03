/**
 * Idempotent demo seed — mirrors ui/src/data/seed.ts so the API serves the same
 * realistic data the UI was built against. Safe to run multiple times.
 * Default password for every seeded user: "Password123!"
 *
 * Run with: npm run seed
 */
import { sequelize } from "./sequelize";
import { Department, Issue, Label, Project, Task, User } from "../models";
import { NotificationPreference } from "../models";
import { hashPassword } from "../lib/password";
import "../models";

type Seeded<T> = T & { id: string };

async function seed() {
  await sequelize.authenticate();
  const passwordHash = await hashPassword("Password123!");

  const userSpecs = [
    { name: "Ada Okafor", email: "ada@mybizpush.com", avatarColor: "#960095", roles: ["CEO"], accessLevel: "executive_admin" as const },
    { name: "Samson Agbo", email: "sam@mybizpush.com", avatarColor: "#3906FE", roles: ["CTO", "Backend"], accessLevel: "executive_admin" as const },
    { name: "Chiamaka Eze", email: "chiamaka@mybizpush.com", avatarColor: "#790278", roles: ["CMO"], accessLevel: "executive_admin" as const },
    { name: "Femi Adebayo", email: "femi@mybizpush.com", avatarColor: "#0EA5E9", roles: ["Frontend"], accessLevel: "member" as const },
    { name: "Ngozi Umeh", email: "ngozi@mybizpush.com", avatarColor: "#10B981", roles: ["Backend", "DevOps"], accessLevel: "admin" as const },
    { name: "Kola Akin", email: "kola@mybizpush.com", avatarColor: "#F59E0B", roles: ["UI/UX Designer"], accessLevel: "member" as const },
    { name: "Bisi Salami", email: "bisi@mybizpush.com", avatarColor: "#EF4444", roles: ["Graphics Designer"], accessLevel: "member" as const },
    { name: "Seyi Lawal", email: "seyi@mybizpush.com", avatarColor: "#EC4899", roles: ["SMM"], accessLevel: "member" as const },
  ];

  const users: Record<string, Seeded<User>> = {};
  for (const spec of userSpecs) {
    const [user] = await User.findOrCreate({
      where: { email: spec.email },
      // Seeded demo accounts are already set up — skip the onboarding wizard.
      defaults: { ...spec, passwordHash, onboarded: true },
    });
    await NotificationPreference.findOrCreate({ where: { userId: user.id }, defaults: { userId: user.id } });
    users[spec.email] = user as Seeded<User>;
  }

  const deptSpecs = [
    { slug: "dev", name: "Dev", description: "Engineering, infrastructure, and product platform.", head: "sam@mybizpush.com", members: ["sam@mybizpush.com", "femi@mybizpush.com", "ngozi@mybizpush.com", "kola@mybizpush.com"] },
    { slug: "marketing", name: "Marketing", description: "Growth, social media, and campaigns.", head: "chiamaka@mybizpush.com", members: ["chiamaka@mybizpush.com", "seyi@mybizpush.com"] },
    { slug: "creatives", name: "Creatives", description: "Design, video, and brand systems.", head: "kola@mybizpush.com", members: ["kola@mybizpush.com", "bisi@mybizpush.com"] },
    { slug: "executive", name: "Executive", description: "Strategy, leadership, and operations.", head: "ada@mybizpush.com", members: ["ada@mybizpush.com", "sam@mybizpush.com", "chiamaka@mybizpush.com"] },
  ];

  const depts: Record<string, Seeded<Department>> = {};
  for (const spec of deptSpecs) {
    const [dept] = await Department.findOrCreate({
      where: { slug: spec.slug },
      defaults: { slug: spec.slug, name: spec.name, description: spec.description, headId: users[spec.head]!.id },
    });
    await (dept as any).setMembers(spec.members.map((e) => users[e]!.id));
    depts[spec.slug] = dept as Seeded<Department>;
  }

  const labelSpecs = [
    { name: "bug", color: "#EF4444" },
    { name: "frontend", color: "#0EA5E9" },
    { name: "backend", color: "#10B981" },
    { name: "design", color: "#F59E0B" },
  ];
  for (const spec of labelSpecs) {
    await Label.findOrCreate({ where: { name: spec.name }, defaults: spec });
  }

  const projectSpecs = [
    { dept: "dev", name: "Platform", description: "Core internal platform and API.", manager: "sam@mybizpush.com", progress: 62 },
    { dept: "dev", name: "Public API", description: "External-facing API and SDKs.", manager: "ngozi@mybizpush.com", progress: 35 },
    { dept: "marketing", name: "Q4 Launch", description: "Multi-channel Q4 product launch.", manager: "chiamaka@mybizpush.com", progress: 48 },
    { dept: "creatives", name: "Brand Refresh", description: "Brand guidelines, identity refresh.", manager: "kola@mybizpush.com", progress: 78 },
  ];

  const projects: Record<string, Seeded<Project>> = {};
  for (const spec of projectSpecs) {
    const [project] = await Project.findOrCreate({
      where: { name: spec.name },
      defaults: {
        departmentId: depts[spec.dept]!.id,
        name: spec.name,
        description: spec.description,
        managerId: users[spec.manager]!.id,
        progress: spec.progress,
      },
    });
    // The project's "home" department is also its first involved department (lane).
    await (project as unknown as { setDepartments(ids: string[]): Promise<void> }).setDepartments([
      depts[spec.dept]!.id,
    ]);
    projects[spec.name] = project as Seeded<Project>;
  }

  const taskSpecs = [
    { project: "Platform", title: "Implement task Kanban board", status: "in_progress" as const, priority: "high" as const, reporter: "sam@mybizpush.com", assignees: ["femi@mybizpush.com"] },
    { project: "Platform", title: "Notifications inbox", status: "todo" as const, priority: "medium" as const, reporter: "sam@mybizpush.com", assignees: ["femi@mybizpush.com"] },
    { project: "Public API", title: "Rate limit middleware", status: "in_progress" as const, priority: "high" as const, reporter: "ngozi@mybizpush.com", assignees: ["ngozi@mybizpush.com"] },
  ];
  for (const spec of taskSpecs) {
    const [task, created] = await Task.findOrCreate({
      where: { title: spec.title },
      defaults: {
        projectId: projects[spec.project]!.id,
        title: spec.title,
        status: spec.status,
        priority: spec.priority,
        reporterId: users[spec.reporter]!.id,
      },
    });
    if (created) await (task as any).setAssignees(spec.assignees.map((e) => users[e]!.id));
  }

  const issueSpecs = [
    { project: "Public API", title: "401 returns inconsistent body", status: "todo" as const, priority: "high" as const, severity: "major" as const, reporter: "sam@mybizpush.com", assignees: ["ngozi@mybizpush.com"] },
    { project: "Platform", title: "Dock overlaps content on iPhone SE", status: "todo" as const, priority: "high" as const, severity: "minor" as const, reporter: "kola@mybizpush.com", assignees: ["femi@mybizpush.com"] },
  ];
  for (const spec of issueSpecs) {
    const [issue, created] = await Issue.findOrCreate({
      where: { title: spec.title },
      defaults: {
        projectId: projects[spec.project]!.id,
        title: spec.title,
        status: spec.status,
        priority: spec.priority,
        severity: spec.severity,
        reporterId: users[spec.reporter]!.id,
      },
    });
    if (created) await (issue as any).setAssignees(spec.assignees.map((e) => users[e]!.id));
  }

  console.info("✅ Seed complete. Login with any seeded email and password: Password123!");
  await sequelize.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
