# Rework: projects ⟷ departments (many-to-many, department lanes)

> **Status: design / proposal. Not implemented.** Confirm the model before we build.

## The problem with today's model

Today a **project belongs to exactly one department**:

```
Department (Frontend)  ──<  Project (Frontend's "Agrocom")  ──<  Tasks / Repos
Department (Backend)   ──<  Project (Backend's "Agrocom")   ──<  Tasks / Repos
```

But "Agrocom" is **one product** that Frontend, Backend, DevOps and UI/UX all
build **together**. The current shape forces you to create the *same* project
twice (once under Frontend, once under Backend); the two copies are unrelated and
never sync. That's the oversight.

## The model we actually want

- **Projects are top-level and independent.** A project has a **project manager**,
  a name, an avatar, overall progress.
- **Departments are top-level and independent** (Frontend, Backend, DevOps,
  UI/UX, …), each with a **head** and members.
- A project is **worked on by many departments**, and a department **works on many
  projects** → a **many-to-many** between projects and departments.
- **Inside a project, work is organised by department "lane":** Frontend's tasks
  and Frontend's repos, Backend's tasks and Backend's repos, etc. — but it's **one
  shared project**, so everyone sees the same project; the departments are just
  the lanes within it.

```
Project (Agrocom, PM: Sam)
├── involves → Frontend, Backend, DevOps, UI/UX        (many-to-many)
├── Tasks/Issues   each tagged with a department lane  (frontend task, backend task…)
└── Repos          each tagged with a department lane  (frontend repo, backend repo…)

Department (Frontend, head: Ada)
└── works on → Agrocom, Ceremotik, …                   (the same join, other side)
```

So the "sync" you want is automatic: there's **one** Agrocom project; Frontend and
Backend are two lanes inside it, not two separate projects.

---

## Data model changes

### New: `project_departments` (the join)

| column | notes |
| --- | --- |
| `project_id` | FK projects |
| `department_id` | FK departments |
| `lead_id` (optional) | who leads this department's lane on this project (defaults to the dept head) |

Unique `(project_id, department_id)`.

### `projects`
- **Drop the hard `department_id`** ownership. A project is independent.
- (Optional) keep `primary_department_id` *nullable* if we ever want a "home"
  department, but it's not required.

### `tasks` and `issues`
- Add **`department_id` (nullable)** — which lane the item belongs to. Nullable so
  a project can still have cross-cutting / general items that aren't department-specific.

### `project_repos`
- Add **`department_id` (nullable)** — the frontend repo vs the backend repo on
  the same project.

### Membership (the open one — see below)
- A person belongs to a **department**; the department is **on a project**; so a
  person's involvement in a project flows **through their department**.
- **Option A (derived):** a project's people = union of the members of its involved
  departments (+ the PM). No separate project-members table. *This matches your
  description most closely and removes the "add member to project" step I built.*
- **Option B (explicit + derived):** keep an optional explicit project-members
  list for guests/cross-team helpers, on top of the derived set.

---

## API changes

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects` | all projects (top-level) |
| GET | `/projects/:id` | includes `departments` (involved) + PM |
| POST | `/projects` | create (PM + name); **no** department required |
| POST | `/projects/:id/departments` | add a department to the project (PM/exec) |
| DELETE | `/projects/:id/departments/:deptId` | remove a department lane |
| GET | `/departments/:id/projects` | projects this department works on |
| GET | `/tasks?projectId=&departmentId=` | filter a project's board by lane |
| GET | `/issues?projectId=&departmentId=` | same |
| POST | `/tasks` / `/issues` | accept optional `departmentId` (the lane) |
| GET/POST | `/projects/:id/repos?departmentId=` | repos filtered/tagged by lane |

Everything else (PRs, commits, issues mirroring, comments) hangs off the repos,
which now carry a department — so a department's lane naturally shows *its* repos'
PRs/commits.

---

## UI / UX arrangement

### Workspace (top level)
Two peers instead of "departments own projects":
- **Projects** — all projects (cards: name, PM, progress, involved-department chips).
- **Departments** — all departments (cards: name, head, members, # projects).

(Could be two tabs, or two sections on the page.)

### Project page (the hub)
- Header: project name, **PM**, progress, avatar.
- **Departments involved** row (chips/avatars) with add/remove for PM/exec.
- A **department lane switcher** — a segmented control / dropdown: **All ·
  Frontend · Backend · DevOps · UI-UX** (only the involved ones).
  - **Tasks / Issues** boards filter to the selected lane (or "All" shows
    everything, each card tagged with its department colour).
  - **Repos** tab filters/groups by lane (frontend repos vs backend repos), and
    the PR/commit views follow.
- Net effect: Frontend opens Agrocom and works the **Frontend lane**; Backend
  opens the **same** Agrocom and works the **Backend lane**; the PM sees all lanes.

### Department page
- Header: dept name, **head**, members, avatar (as now).
- **Projects this department works on** (the many-to-many) — clicking a project
  opens it **pre-filtered to this department's lane**.
- Members / join-requests as today.

### Creating work
- Create a **task/issue** inside a project → pick the **lane (department)**
  (defaults to your own department).
- Link a **repo** to a project → pick the **lane** it belongs to.

---

## Permissions (proposed)

| Action | Who |
| --- | --- |
| Create / delete a project | executive admin (assigns the PM) |
| Edit project details, change PM, set avatar | PM · exec |
| Add/remove a **department** to/from a project | PM · exec |
| Manage a **lane** (its tasks/repos) | that department's **head** · PM · exec |
| Work in a lane (create/assign tasks) | members of that department on the project |

---

## Migration (phased, non-breaking)

1. **Data:** create `project_departments`; back-fill each existing project's
   current `department_id` as its first involved department. Add nullable
   `department_id` to `tasks`, `issues`, `project_repos` and back-fill from the
   project's original department.
2. **API:** add the join endpoints + `departmentId` filters; keep old behaviour
   working (a project with one department behaves like today).
3. **UI:** add the lane switcher on the project page and the "projects" list on
   the department page; move project creation to be top-level.
4. **Membership:** switch to derived membership (Option A) — retire the explicit
   "add member to project" control in favour of "add a department to the project."

Each phase ships independently; nothing breaks mid-way because a single-department
project is just a project with one lane.

---

## Open questions (please confirm)

1. **Membership: Option A (derived from departments) or B (derived + explicit
   guests)?** Your description points to **A**.
2. **Can a task/issue be department-less** (a general project task), or must every
   item belong to a lane? (I'd allow null = "general".)
3. **Who creates projects** — execs only, or any PM/department head? (Doc assumes
   execs create + assign a PM.)
4. **Project progress** — overall only, or also per-lane (per department)?
5. **Repos without a lane** — allowed (shared/infra repo), or must each repo pick
   a department?
6. Do we keep a project's **"primary/home" department**, or are projects fully
   department-agnostic? (Doc assumes fully independent.)

---

## What changes from what we built recently

- **"Add member to project"** (Members tab) → becomes **"add a department to the
  project."** Membership is then derived from the involved departments.
- **"Create project" lives on the department page** → moves to a **top-level
  Projects** area; a project then *gets departments added to it*.
- Department page's "Projects" section changes from *"projects owned by this
  department"* to *"projects this department works on."*
