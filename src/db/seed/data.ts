import type { AccessLevel, ProductStage, WorkMode } from "../../models";

export const PRODUCTS: ProductSpec[] = [
  {
    name: "Plemuz",
    slug: "plemuz",
    description: "Plemuz product team workspace.",
    stage: "live",
    tint: "#D400D1",
    owner: "esther",
    members: [["esther", "Owner"], ["femi", "Frontend engineer"], ["ngozi", "Backend engineer"], ["kola", "Product designer"], ["amaka", "Email marketing"], ["seyi", "Social media"], ["uche", "QA engineer"], ["yusuf", "Sales lead"]],
  },
  {
    name: "Hyparrow",
    slug: "hyparrow",
    description: "Hyparrow product team workspace.",
    stage: "live",
    tint: "#0EA5E9",
    owner: "ngozi",
    members: [["ngozi", "Owner"], ["halima", "Platform engineer"], ["emeka", "Backend engineer"], ["uche", "QA engineer"], ["tobi", "Video"]],
  },
  {
    name: "Ceremotik",
    slug: "ceremotik",
    description: "Ceremotik product team workspace.",
    stage: "live",
    tint: "#F59E0B",
    owner: "chiamaka",
    members: [["chiamaka", "Owner"], ["bolu", "Content writer"], ["bisi", "Graphics designer"], ["zainab", "Frontend engineer"]],
  },
  {
    name: "Womaney",
    slug: "womaney",
    description: "Womaney product team workspace.",
    stage: "live",
    tint: "#EC4899",
    owner: "amaka",
    members: [["amaka", "Owner"], ["seyi", "Social media"], ["ifeoma", "Frontend engineer"], ["kemi", "Account executive"]],
  },
  {
    name: "Hempay",
    slug: "hempay",
    description: "Hempay product team workspace.",
    stage: "live",
    tint: "#10B981",
    owner: "daniel",
    members: [["daniel", "Owner"], ["emeka", "Backend engineer"], ["grace", "Finance advisor"], ["musa", "Customer success"]],
  },
  {
    name: "Agrocom",
    slug: "agrocom",
    description: "Agrocom product team workspace.",
    stage: "live",
    tint: "#65A30D",
    owner: "yusuf",
    members: [["yusuf", "Owner"], ["kemi", "Account executive"], ["halima", "Platform engineer"], ["chidi", "Support"]],
  },
  {
    name: "Esthipay",
    slug: "esthipay",
    description: "Esthipay product team workspace.",
    stage: "live",
    tint: "#14B8A6",
    owner: "esther",
    members: [["esther", "Owner"], ["daniel", "Payments engineer"], ["zainab", "Frontend engineer"], ["grace", "Finance advisor"]],
  },
  {
    name: "Conifer",
    slug: "conifer",
    description: "Conifer product team workspace.",
    stage: "live",
    tint: "#5B30FF",
    owner: "sam",
    members: [["sam", "Owner"], ["femi", "Mobile lead"], ["kola", "Product designer"], ["uche", "QA engineer"]],
  },
];

export interface ProductSpec {
  name: string;
  slug: string;
  description: string;
  stage: ProductStage;
  tint: string;
  owner: string;
  senderName?: string;
  senderEmail?: string;
  members: [person: string, title: string][];
}

export const EMAIL_DOMAIN = "mybizpush.com";
export const DEMO_PASSWORD = "Password123!";
export const emailOf = (key: string) => `${key}@${EMAIL_DOMAIN}`;

export interface PersonSpec {
  key: string;
  name: string;
  titles: string[];
  accessLevel: AccessLevel;
  workMode: WorkMode;
  color: string;
  joinedDaysAgo: number;
  office?: string;
  reportsTo?: string;
  lateProne?: boolean;
}

export const OFFICES = [
  { key: "lagos", name: "Lagos HQ", address: "14 Admiralty Way, Lekki Phase 1, Lagos", lateAfter: "09:15" },
  { key: "abuja", name: "Abuja Hub", address: "Plot 1102 Aminu Kano Crescent, Wuse 2, Abuja", lateAfter: "09:00" },
];

export const PEOPLE: PersonSpec[] = [
  { key: "ada", name: "Ada Okafor", titles: ["CEO"], accessLevel: "chief", workMode: "onsite", color: "#960095", joinedDaysAgo: 1460, office: "lagos" },
  { key: "sam", name: "Samson Agbo", titles: ["CTO", "Backend"], accessLevel: "admin", workMode: "hybrid", color: "#3906FE", joinedDaysAgo: 1400, office: "lagos", reportsTo: "ada" },
  { key: "chiamaka", name: "Chiamaka Eze", titles: ["CMO"], accessLevel: "member", workMode: "onsite", color: "#790278", joinedDaysAgo: 1100, office: "lagos", reportsTo: "ada" },
  { key: "tunde", name: "Tunde Bakare", titles: ["COO"], accessLevel: "member", workMode: "onsite", color: "#0F766E", joinedDaysAgo: 900, office: "lagos", reportsTo: "ada" },
  { key: "femi", name: "Femi Adebayo", titles: ["Frontend"], accessLevel: "member", workMode: "hybrid", color: "#0EA5E9", joinedDaysAgo: 820, office: "lagos", reportsTo: "sam" },
  { key: "ngozi", name: "Ngozi Umeh", titles: ["Backend", "DevOps"], accessLevel: "admin", workMode: "onsite", color: "#10B981", joinedDaysAgo: 1000, office: "lagos", reportsTo: "sam" },
  { key: "kola", name: "Kola Akin", titles: ["UI/UX Designer"], accessLevel: "member", workMode: "onsite", color: "#F59E0B", joinedDaysAgo: 760, office: "lagos", reportsTo: "sam", lateProne: true },
  { key: "bisi", name: "Bisi Salami", titles: ["Graphics Designer"], accessLevel: "member", workMode: "hybrid", color: "#EF4444", joinedDaysAgo: 540, office: "lagos", reportsTo: "kola" },
  { key: "seyi", name: "Seyi Lawal", titles: ["SMM"], accessLevel: "member", workMode: "onsite", color: "#EC4899", joinedDaysAgo: 480, office: "lagos", reportsTo: "chiamaka", lateProne: true },
  { key: "esther", name: "Esther Akpan", titles: ["Product Manager"], accessLevel: "member", workMode: "onsite", color: "#6366F1", joinedDaysAgo: 610, office: "lagos", reportsTo: "sam" },
  { key: "ifeoma", name: "Ifeoma Nwosu", titles: ["Frontend"], accessLevel: "member", workMode: "hybrid", color: "#14B8A6", joinedDaysAgo: 400, office: "lagos", reportsTo: "femi" },
  { key: "emeka", name: "Emeka Obi", titles: ["Backend"], accessLevel: "member", workMode: "onsite", color: "#84CC16", joinedDaysAgo: 520, office: "lagos", reportsTo: "ngozi", lateProne: true },
  { key: "halima", name: "Halima Bello", titles: ["DevOps"], accessLevel: "member", workMode: "remote", color: "#A855F7", joinedDaysAgo: 350, reportsTo: "ngozi" },
  { key: "daniel", name: "Daniel Etim", titles: ["Backend"], accessLevel: "member", workMode: "remote", color: "#F97316", joinedDaysAgo: 300, reportsTo: "ngozi" },
  { key: "zainab", name: "Zainab Musa", titles: ["Frontend"], accessLevel: "member", workMode: "remote", color: "#06B6D4", joinedDaysAgo: 210, reportsTo: "femi" },
  { key: "uche", name: "Uche Okonkwo", titles: ["QA Engineer"], accessLevel: "member", workMode: "onsite", color: "#64748B", joinedDaysAgo: 260, office: "lagos", reportsTo: "sam" },
  { key: "amaka", name: "Amaka Nnaji", titles: ["Marketer"], accessLevel: "member", workMode: "hybrid", color: "#DB2777", joinedDaysAgo: 330, office: "lagos", reportsTo: "chiamaka" },
  { key: "bolu", name: "Bolu Ogunleye", titles: ["Content Writer"], accessLevel: "member", workMode: "remote", color: "#B45309", joinedDaysAgo: 190, reportsTo: "chiamaka" },
  { key: "tobi", name: "Tobi Alade", titles: ["Video Editor"], accessLevel: "member", workMode: "remote", color: "#7C3AED", joinedDaysAgo: 150, reportsTo: "kola" },
  { key: "funke", name: "Funke Adeyemi", titles: ["HR Officer"], accessLevel: "member", workMode: "onsite", color: "#BE185D", joinedDaysAgo: 700, office: "lagos", reportsTo: "tunde" },
  { key: "grace", name: "Grace Okon", titles: ["Accountant"], accessLevel: "member", workMode: "hybrid", color: "#059669", joinedDaysAgo: 450, office: "lagos", reportsTo: "tunde" },
  { key: "yusuf", name: "Yusuf Ibrahim", titles: ["Sales Lead"], accessLevel: "member", workMode: "onsite", color: "#2563EB", joinedDaysAgo: 580, office: "abuja", reportsTo: "tunde" },
  { key: "kemi", name: "Kemi Oladipo", titles: ["Account Executive"], accessLevel: "member", workMode: "onsite", color: "#E11D48", joinedDaysAgo: 240, office: "abuja", reportsTo: "yusuf", lateProne: true },
  { key: "musa", name: "Musa Danjuma", titles: ["Customer Success"], accessLevel: "member", workMode: "hybrid", color: "#0891B2", joinedDaysAgo: 280, office: "abuja", reportsTo: "yusuf" },
  { key: "chidi", name: "Chidi Okeke", titles: ["Support Specialist"], accessLevel: "member", workMode: "onsite", color: "#4D7C0F", joinedDaysAgo: 120, office: "lagos", reportsTo: "yusuf" },
];

export const DEPARTMENTS = [
  { slug: "executive", name: "Executive", description: "Strategy, leadership, and operations.", head: "ada", members: ["ada", "sam", "chiamaka", "tunde"] },
  { slug: "dev", name: "Dev", description: "Engineering, infrastructure, and product platform.", head: "sam", members: ["sam", "femi", "ngozi", "kola", "esther", "ifeoma", "emeka", "halima", "daniel", "zainab", "uche"] },
  { slug: "marketing", name: "Marketing", description: "Growth, social media, and campaigns.", head: "chiamaka", members: ["chiamaka", "seyi", "amaka", "bolu"] },
  { slug: "creatives", name: "Creatives", description: "Design, video, and brand systems.", head: "kola", members: ["kola", "bisi", "tobi"] },
  { slug: "hr", name: "People and Operations", description: "HR, finance, office and compliance.", head: "tunde", members: ["tunde", "funke", "grace"] },
  { slug: "sales", name: "Sales and Support", description: "Merchant acquisition, partnerships and customer success.", head: "yusuf", members: ["yusuf", "kemi", "musa", "chidi"] },
];

export const TEAMS = [
  { slug: "mobile-squad", name: "Mobile Squad", description: "Builds the MyBizPush Workspace mobile app.", lead: "femi", members: ["femi", "ifeoma", "zainab", "kola", "uche"], projects: ["Workspace Mobile App"] },
  { slug: "platform-core", name: "Platform Core", description: "APIs, infrastructure and reliability across products.", lead: "ngozi", members: ["ngozi", "emeka", "daniel", "halima"], projects: ["Platform", "Public API", "Hyparrow Roadmap"] },
  { slug: "growth-pod", name: "Growth Pod", description: "Acquisition, content and lifecycle marketing.", lead: "seyi", members: ["seyi", "amaka", "bolu", "bisi"], projects: ["Q4 Launch", "Womaney Roadmap"] },
  { slug: "product-squad", name: "Product Squad", description: "Ships product roadmaps across the portfolio.", lead: "daniel", members: ["daniel", "emeka", "zainab", "grace"], projects: ["Hempay Roadmap", "Esthipay Roadmap"] },
  { slug: "people-ops", name: "People Ops", description: "Hiring, onboarding, policies and attendance.", lead: "funke", members: ["funke", "tunde", "grace"], projects: ["People Ops Rollout"] },
];

export const LABELS = [
  { name: "bug", color: "#EF4444" },
  { name: "frontend", color: "#0EA5E9" },
  { name: "backend", color: "#10B981" },
  { name: "design", color: "#F59E0B" },
  { name: "mobile", color: "#8B5CF6" },
  { name: "infra", color: "#64748B" },
  { name: "content", color: "#F97316" },
  { name: "payments", color: "#14B8A6" },
];

export interface ProjectSpec {
  name: string;
  product?: string;
  department: string;
  manager: string;
  description: string;
  techStack?: string;
  progress: number;
  members: string[];
  labels: string[];
  tasks: string[];
}

export const PROJECTS: ProjectSpec[] = [
  {
    name: "Platform", department: "dev", manager: "sam", progress: 62,
    description: "Core internal platform and API.", techStack: "Node.js + TypeScript (Express, Sequelize, Postgres, Redis)",
    members: ["femi", "ngozi", "emeka", "uche", "kola"], labels: ["backend", "frontend", "bug"],
    tasks: [
      "Implement task Kanban board", "Notifications inbox", "Migrate session store to Redis cluster", "Audit log filters by actor and scope",
      "Fix duplicate WhatsApp webhook deliveries", "Bulk import contacts from CSV", "Dashboard load time under 2 seconds", "Role based menu visibility",
    ],
  },
  {
    name: "Public API", department: "dev", manager: "ngozi", progress: 35,
    description: "External-facing API and SDKs.", techStack: "Node.js + TypeScript, OpenAPI 3.1",
    members: ["emeka", "daniel", "halima"], labels: ["backend", "infra"],
    tasks: [
      "Rate limit middleware", "Publish OpenAPI spec for v1", "API keys with scoped permissions", "Webhook signing and retries",
      "JavaScript SDK first release", "Usage metering per API key", "Sandbox environment for partners",
    ],
  },
  {
    name: "Q4 Launch", department: "marketing", manager: "chiamaka", progress: 48,
    description: "Multi-channel Q4 product launch.",
    members: ["seyi", "amaka", "bolu", "bisi", "tobi", "yusuf"], labels: ["content", "design"],
    tasks: [
      "Launch landing page copy", "Black Friday email sequence", "Instagram reels for Growth plan", "Partner webinar",
      "Customer story video", "Paid social budget plan for December", "Press kit and founder quotes", "Referral program terms",
    ],
  },
  {
    name: "Workspace Mobile App", department: "dev", manager: "femi", progress: 71,
    description: "React Native app for staff: tasks, chat, calendar, attendance.", techStack: "React Native + Expo, TypeScript, WatermelonDB sync",
    members: ["ifeoma", "zainab", "kola", "uche", "esther"], labels: ["mobile", "frontend", "bug"],
    tasks: [
      "Offline sync conflict banner", "QR check-in screen", "Chat thread view with reactions", "Calendar week view polish",
      "Push notification deep links", "Task review flow on mobile", "Crash on Android 10 when opening attachments", "Workspace switcher sheet",
      "Dark mode contrast fixes",
    ],
  },
  {
    name: "People Ops Rollout", department: "hr", manager: "funke", progress: 40,
    description: "Moving HR records, leave and attendance into Workspace.",
    members: ["tunde", "grace", "esther"], labels: ["content"],
    tasks: [
      "Import staff records from spreadsheet", "Leave policy document for review", "Office QR screens for Lagos and Abuja", "Onboarding checklist template",
      "Attendance report for November", "Appraisal cycle setup for Q4",
    ],
  },
  {
    name: "Brand Refresh", department: "creatives", manager: "kola", progress: 78,
    description: "Brand guidelines, identity refresh.",
    members: ["bisi", "tobi", "chiamaka"], labels: ["design"],
    tasks: [
      "Final logo lockups and spacing rules", "Gradient button and color tokens", "Icon set for Workspace modules", "Brand guidelines PDF",
      "Office wall graphics for Lagos HQ", "Email signature templates",
    ],
  },
  ...PRODUCTS.map((product, index): ProjectSpec => ({
    name: `${product.name} Roadmap`,
    product: product.slug,
    department: "dev",
    manager: product.owner,
    progress: 20 + ((index * 17) % 60),
    description: `Planned work for ${product.name} this quarter.`,
    members: product.members.map(([person]) => person).filter((person) => person !== product.owner),
    labels: ["backend", "frontend", "bug"],
    tasks: [
      `${product.name} quarterly roadmap review`, `${product.name} onboarding flow improvements`, `${product.name} release notes`,
      `${product.name} bug triage`, `${product.name} usage analytics dashboard`, `${product.name} QA regression pass`,
    ],
  })),
];

export const CUSTOM_TITLES = ["Product Manager", "QA Engineer", "Content Writer", "HR Officer", "Accountant", "Sales Lead", "Account Executive", "Customer Success", "Support Specialist"];

export const ROLE_ASSIGNMENTS = [
  { role: "hr_officer", person: "funke", scope: "organization" as const },
  { role: "product_manager", person: "esther", scope: "product" as const, product: "plemuz" },
  { role: "email_marketer", person: "amaka", scope: "product" as const, product: "plemuz" },
  { role: "reviewer", person: "uche", scope: "product" as const, product: "conifer" },
  { role: "reviewer", person: "uche", scope: "product" as const, product: "hyparrow" },
];
