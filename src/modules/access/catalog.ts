// Permission catalog (API-CHANGES A103). Every permission is "<resource>.<action>".
// Adding an action here makes it available to every role editor; nothing else
// needs to change. Labels feed the role editor (PERM-02) and "who can" (PERM-06).

export const SCOPE_TYPES = ["organization", "department", "team", "product", "project"] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export interface Scope {
  type: ScopeType;
  id?: string | null; // null for organization
}

export const ORG: Scope = { type: "organization", id: null };

type Resource = { resource: string; label: string; actions: Record<string, string> };

export const CATALOG: Resource[] = [
  { resource: "staff", label: "Staff", actions: { view: "View", create: "Invite", edit: "Edit", suspend: "Suspend", export: "Export", import: "Import" } },
  { resource: "department", label: "Departments", actions: { view: "View", create: "Create", edit: "Edit", delete: "Delete", manage_members: "Manage members" } },
  { resource: "team", label: "Teams", actions: { view: "View", create: "Create", edit: "Edit", delete: "Delete" } },
  { resource: "product", label: "Products", actions: { view: "View", create: "Create", edit: "Edit", manage_members: "Manage people", manage_projects: "Manage projects" } },
  { resource: "project", label: "Projects", actions: { view: "View", create: "Create", manage: "Manage", delete: "Delete" } },
  { resource: "task", label: "Tasks", actions: { view: "View", create: "Create", assign: "Assign", submit: "Submit work", approve: "Approve", reject: "Reject", delete: "Delete", manage_templates: "Manage templates" } },
  { resource: "meeting", label: "Meetings", actions: { view: "View", create: "Create", edit: "Edit", cancel: "Cancel" } },
  { resource: "event", label: "Calendar events", actions: { create: "Create", edit: "Edit", delete: "Delete" } },
  { resource: "channel", label: "Channels", actions: { create: "Create", edit: "Edit", archive: "Archive", manage_members: "Manage members" } },
  { resource: "message", label: "Messages", actions: { send: "Send", moderate: "Moderate" } },
  { resource: "announcement", label: "Announcements", actions: { draft: "Draft", publish: "Publish", edit: "Edit", archive: "Archive" } },
  { resource: "target", label: "Targets", actions: { create: "Create", assign: "Assign", update: "Update", evaluate: "Evaluate" } },
  { resource: "query", label: "Staff queries", actions: { issue: "Issue", respond: "Respond", review: "Review", resolve: "Resolve", view: "View all" } },
  { resource: "hr", label: "HR records", actions: { view: "View", edit: "Edit" } },
  { resource: "report", label: "Reports", actions: { view: "View", generate: "Generate", export: "Export" } },
  { resource: "campaign", label: "Campaigns", actions: { create: "Create", import: "Import leads", approve: "Approve", send: "Send", view: "View analytics" } },
  { resource: "content", label: "Content", actions: { create: "Create", approve: "Approve", publish: "Publish" } },
  { resource: "integration", label: "Integrations", actions: { manage: "Manage" } },
  { resource: "database", label: "Databases", actions: { manage: "Manage" } },
  { resource: "role", label: "Roles and permissions", actions: { view: "View", manage: "Manage", assign: "Assign" } },
  { resource: "audit", label: "Audit log", actions: { view: "View" } },
];

export const ALL_PERMISSIONS: string[] = CATALOG.flatMap((r) => Object.keys(r.actions).map((a) => `${r.resource}.${a}`));
export const PERMISSION_SET = new Set(ALL_PERMISSIONS);

// Seeded roles. System roles mirror the existing access levels so current
// behaviour is unchanged; "derived" roles are given automatically to people
// who already hold that position (department head, project manager, product
// owner, team lead). All of them stay editable except their keys.
export interface SeedRole {
  key: string;
  name: string;
  description: string;
  system: boolean; // cannot be deleted
  defaultScope: ScopeType;
  permissions: string[]; // "*" = everything
}

// report.view is deliberately not here: "work" roles are often held organization
// wide, and everyone already sees their own work without it.
const work = ["task.view", "task.create", "task.submit", "meeting.view", "message.send"];
// Roles held organization wide leave task.view out: it would open every task to
// everyone holding the role. What they see comes from their connection to the work.
const orgWork = work.filter((p) => p !== "task.view");

export const SEED_ROLES: SeedRole[] = [
  { key: "executive_admin", name: "Executive admin", description: "Everything, organization wide", system: true, defaultScope: "organization", permissions: ["*"] },
  {
    key: "chief",
    name: "Chief",
    description: "Manage the organization, reports and meetings",
    system: true,
    defaultScope: "organization",
    permissions: ALL_PERMISSIONS.filter((p) => !["role.manage", "staff.suspend", "hr.edit", "query.view", "hr.view"].includes(p)),
  },
  {
    key: "admin",
    name: "Admin",
    description: "Operations, databases and integrations",
    system: true,
    defaultScope: "organization",
    permissions: [...orgWork, "database.manage", "integration.manage", "staff.view", "audit.view", "report.generate"],
  },
  { key: "member", name: "Member", description: "Default for every staff member", system: true, defaultScope: "organization", permissions: [...orgWork, "staff.view", "department.view", "team.view", "product.view", "project.view"] },
  {
    key: "product_manager",
    name: "Product manager",
    description: "Runs a product: people, projects, approvals, marketing",
    system: false,
    defaultScope: "product",
    permissions: [...work, "product.edit", "product.manage_members", "product.manage_projects", "project.create", "project.manage", "task.assign", "task.approve", "task.reject", "meeting.create", "meeting.edit", "announcement.draft", "announcement.publish", "target.create", "target.assign", "target.evaluate", "report.generate", "report.export", "event.create", "event.edit", "event.delete", "campaign.create", "campaign.import", "campaign.approve", "campaign.send", "campaign.view", "content.create", "content.approve", "content.publish", "channel.create", "channel.edit", "channel.manage_members", "channel.archive", "message.moderate", "task.manage_templates", "report.view"],
  },
  {
    key: "project_manager",
    name: "Project manager",
    description: "Runs a project: tasks, approvals, meetings",
    system: false,
    defaultScope: "project",
    permissions: [...work, "project.manage", "task.assign", "task.approve", "task.reject", "meeting.create", "meeting.edit", "event.create", "event.edit", "report.generate", "channel.create", "channel.edit", "channel.manage_members", "report.view"],
  },
  {
    key: "department_head",
    name: "Department head",
    description: "Leads a department and the projects it works on",
    system: false,
    defaultScope: "department",
    permissions: [...work, "department.edit", "department.manage_members", "project.manage", "task.assign", "task.approve", "task.reject", "meeting.create", "event.create", "event.edit", "event.delete", "target.create", "target.assign", "target.evaluate", "report.generate", "report.export", "task.manage_templates", "report.view", "channel.create", "channel.edit", "channel.manage_members"],
  },
  { key: "team_lead", name: "Team lead", description: "Leads a team", system: false, defaultScope: "team", permissions: [...work, "team.edit", "task.assign", "task.approve", "task.reject", "meeting.create", "event.create", "event.edit", "report.view", "channel.create", "channel.edit", "channel.manage_members"] },
  { key: "reviewer", name: "Reviewer", description: "Approve and reject work", system: false, defaultScope: "product", permissions: ["task.view", "task.approve", "task.reject"] },
  { key: "contributor", name: "Contributor", description: "Does the work", system: false, defaultScope: "product", permissions: work },
  {
    key: "hr_officer",
    name: "HR officer",
    description: "Staff records, queries and appraisals",
    system: false,
    defaultScope: "organization",
    permissions: [...orgWork, "staff.create", "staff.edit", "staff.suspend", "staff.export", "staff.import", "hr.view", "hr.edit", "query.issue", "query.review", "query.resolve", "query.view", "announcement.draft", "announcement.publish", "event.create", "event.edit", "event.delete"],
  },
  { key: "email_marketer", name: "Email marketer", description: "Leads and campaigns for a product", system: false, defaultScope: "product", permissions: [...work, "campaign.create", "campaign.import", "campaign.send", "campaign.view", "content.create"] },
];

// Access level -> system role key (parity with requireAccessLevel).
export const ACCESS_LEVEL_ROLE: Record<string, string> = {
  executive_admin: "executive_admin",
  chief: "chief",
  admin: "admin",
  member: "member",
};
