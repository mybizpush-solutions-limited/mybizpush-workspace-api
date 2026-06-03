# Reports — design

> **Status: design / proposal. Not implemented.** Approve before we build.

## Goal

Generate reports across the project ⟷ department model:

- **Project (general) report** — the whole project across all its departments.
- **Lane report** — one department's slice of a project (e.g. Agrocom's *Frontend*
  report, *Backend* report, *DevOps* report).
- **Department report** — one department's work across **all** the projects it
  works on.

So for an Agrocom project worked on by Frontend + Backend + DevOps, you can
produce: a Frontend lane report, a Backend lane report, a DevOps lane report, and
one general Agrocom report — plus a standalone Frontend-department report spanning
every project Frontend touches.

## Who can generate what

| Report | Who |
| --- | --- |
| A project's general report | the project's **PM** · a head of an involved dept · **exec** |
| A project's **lane** report (a department) | that **department's head** · the **PM** · exec |
| A **department** report (all its projects) | that **department's head** · exec |
| **Any** project / department report | **executive admin** |

(Members can *view* but not generate — TBD, see open questions.)

## What a report contains

A report is generated for a **scope** (project, project+department, or department)
and an optional **time window** (e.g. last 7/30 days, or all-time). Sections:

1. **Header** — scope name, period, generated-by, generated-at.
2. **Summary metrics**
   - Tasks: total, by status (todo / in progress / in review / blocked / done),
     completed-in-period, completion rate, overdue count.
   - Issues: total, by status + by severity (minor/major/critical), opened vs
     closed in period.
   - Progress: project progress %, or aggregate across lane.
3. **People** — members involved (for a lane: that department's members on the
   project; for a department: its members), with per-person counts
   (assigned / completed).
4. **GitHub** (if repos linked) — open PRs, merged-in-period, recent commits,
   CI health — **scoped to the lane's repos** for a lane report.
5. **Activity timeline** — key events in the period (status changes, feedback,
   PR links) for the scope.
6. **AI narrative (optional)** — a short written summary generated from the
   metrics via OpenRouter (we already have it), e.g. "Frontend closed 12 of 18
   tasks; 2 blocked on API contracts; PR throughput steady." Toggleable.

All of this comes from data we **already store** (tasks/issues + their
`departmentId` lane, activity, project_repos by lane). No new core schema needed
to compute a report.

## Generation & output

- **In-app view** — a Reports view that renders the sections (cards + small
  charts). Fast, no storage.
- **Export** — **PDF** (print-friendly HTML → PDF) and/or **CSV** of the tables.
  - MVP: a clean **printable HTML** report (browser "Save as PDF"). Phase 2: a
    real server-side PDF (e.g. Puppeteer/`@react-pdf`) if we want emailed/stored
    PDFs.
- **(Optional) Saved reports** — persist a generated report (snapshot) so it can
  be shared/emailed and compared over time. Needs a `reports` table. Phase 2.

## API surface (proposed)

Reports are **computed on demand** from existing data:

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/projects/:id/report?from=&to=` | general project report (all lanes) |
| GET | `/projects/:id/report?departmentId=&from=&to=` | one lane's report |
| GET | `/departments/:id/report?from=&to=` | department report across its projects |
| POST | `/projects/:id/report/narrative` | AI narrative for a report payload (optional) |
| GET | `/projects/:id/report.csv?...` | CSV export (optional) |

Each returns a structured JSON the UI renders; CSV/PDF are alternate
representations of the same payload. Permission checks reuse
`assertCanManageProject` / department head / exec.

## UI (proposed)

- **Project page → "Reports" tab** (PM / head / exec): pick **scope** (whole
  project, or a specific lane) + **period**, then **Generate** → renders the
  sections, with **Export PDF / CSV** and an optional **"Summarize with AI."**
- **Department page → "Reports"** (head / exec): department report across its
  projects.
- **Executive view** — generate for any project/department (already covered by
  the per-scope pages, since execs can open anything).

## Phasing

1. **Compute + in-app view** for the three scopes (project / lane / department),
   period filter, summary metrics + people + activity. (Highest value.)
2. **GitHub section** (PRs/commits/CI scoped to the lane's repos).
3. **Export** (printable PDF + CSV).
4. **AI narrative** (OpenRouter).
5. **Saved/emailed report snapshots** (`reports` table) — optional.

## Open questions (please confirm)

1. **Time windows** — fixed presets (7d / 30d / quarter / all-time), or custom
   date range?
2. **Can members view** reports (read-only), or generate-only for PM/head/exec?
3. **Export priority** — printable PDF first, or CSV first? (Doc assumes PDF view
   first, CSV next.)
4. **AI narrative** — include from the start, or add later? (It's cheap with
   OpenRouter but optional.)
5. **Saved snapshots** — do you want to store/share/email generated reports, or is
   on-demand generation enough for now?
6. **Charts** — simple numbers + bars in-app, or richer charts (a chart lib)?
