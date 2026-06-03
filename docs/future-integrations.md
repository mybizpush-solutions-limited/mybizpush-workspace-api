# Future integrations — DevOps (Coolify) & Design (Figma)

> **Status: design only. Nothing here is implemented.** This is a thinking
> document so we can decide scope before building.

## Why

The GitHub integration mainly serves **developers**. To make the workspace
useful to every department, we want one well-chosen integration per discipline:

| Department | Tool | What it unlocks in the workspace |
| --- | --- | --- |
| Frontend / Backend | **GitHub** (done) | repos, PRs, CI, issues, commits, two-way sync |
| **DevOps** | **Coolify** (this doc) | servers, environments, deploys, status per project |
| **Creatives / UI-UX** | **Figma** (this doc) | live design previews, comments, version/update signals |

The unifying idea: a **project** is the hub, and each integration hangs the
relevant artefacts off it — code (GitHub), running infrastructure (Coolify),
and designs (Figma).

---

# Part 1 — Coolify: server & deployment management

We deploy on **VPS boxes managed by Coolify**. Coolify is a self-hosted PaaS
(Heroku/Netlify alternative) that already knows about our servers, apps, and
deployments and exposes a REST API — so we integrate with Coolify rather than
SSHing into boxes ourselves.

## How our deployments are shaped

- Every project usually has **three environments — dev, staging, production**.
- Those environments most often **run on a single VPS** (one Coolify *server*,
  several *applications*).
- **Some projects only have production.** So the model must treat environments
  as optional, not a fixed trio.

## Coolify concepts → our model

Coolify's object graph:

```
Server (a VPS, connected over SSH)
└── Project
    └── Environment (production, staging, …)
        └── Resource: Application | Database | Service   ← has a UUID, this is the deployable
            └── Deployments (build/deploy runs, with status + logs)
```

So a MyBizPush **project + environment** maps to one Coolify **Application UUID**
(which lives on a server). That UUID is the handle we deploy, start/stop, and
read status from.

## Coolify API (what we'd call)

- **Base URL:** `https://<our-coolify-host>/api/v1`
- **Auth:** `Authorization: Bearer <api-token>` — created in Coolify →
  *Keys & Tokens → API tokens*. Tokens have permission levels
  (read-only / read-write / deploy / root); we'd use a **deploy-scoped** token.
- Useful endpoints (verify exact shapes against `coolify.io/docs/api`):
  - `GET /servers`, `GET /servers/{uuid}`, `GET /servers/{uuid}/resources` — servers + what's running, with health/usage.
  - `GET /projects`, `GET /projects/{uuid}`, `GET /projects/{uuid}/{environment}` — projects + environments.
  - `GET /applications`, `GET /applications/{uuid}` — app detail (status, domains, git source).
  - `GET /applications/{uuid}/logs` — runtime logs.
  - `GET /applications/{uuid}/start | /stop | /restart` — lifecycle actions.
  - `GET /deployments`, `GET /deployments/applications/{uuid}` — deployment history + live status.
  - `GET /deploy?uuid={uuid}&force={bool}` — **trigger a deploy** (accepts comma-separated UUIDs / tags).

## Proposed data model (new tables)

```
coolify_connection            (one per org)
  baseUrl, apiTokenEncrypted, defaultServerUuid?, createdBy

server                        (mirror/cache of a Coolify server)
  id, name, host/ip, region, coolifyServerUuid, status, lastSeenAt

project_environment           (the core link: project + env → Coolify app)
  id, projectId, environment ('dev'|'staging'|'production'),
  coolifyApplicationUuid, serverId, url, lastStatus, lastDeployAt
  UNIQUE(projectId, environment)
```

- A project links **0–3** environments. Prod-only projects just have one row.
- `server` is a cache so we can render a workspace-wide infra view without
  hammering Coolify on every page load.

## API surface we'd add (mirrors our existing patterns)

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/api/v1/servers` | member | list servers + status (cached from Coolify) |
| GET | `/api/v1/projects/:id/environments` | member | the project's dev/staging/prod links + **live** status |
| POST | `/api/v1/projects/:id/environments` | PM / dept head / exec | link an env to a Coolify app (`{ environment, coolifyApplicationUuid }`) |
| DELETE | `/api/v1/projects/:id/environments/:env` | PM / head / exec | unlink |
| POST | `/api/v1/projects/:id/environments/:env/deploy` | PM / head / exec / DevOps | trigger redeploy |
| POST | `/api/v1/projects/:id/environments/:env/:action` | PM / head / exec / DevOps | start / stop / restart |
| GET | `/api/v1/projects/:id/deployments` | member | recent deploys across envs (live) |
| POST | `/api/v1/coolify/webhook` | signature | Coolify deploy notifications → update env status |

Reads are **live with a short cache**, like the GitHub PR/issue/commit reads;
the link tables are the only stored state.

## Capabilities, phased

1. **Read-only (MVP):** link projects → environments; per project show dev /
   staging / prod cards with status (running / stopped / building), URL, last
   deploy time. A workspace **Infrastructure** page lists servers and what runs
   on each.
2. **Actions:** Deploy / restart / stop buttons (gated to PM / head / exec /
   DevOps role). Show streaming/last deployment status.
3. **Live status:** consume Coolify deploy notifications via webhook (if Coolify
   can POST a generic webhook on deploy success/failure — **verify**; otherwise
   poll `GET /deployments`). Update `project_environment.lastStatus` and notify.
4. **Health:** surface server CPU/RAM/disk from `/servers/{uuid}/resources` on
   the infra page (amber/red badges when a box is under pressure).

## UI surfaces

- **Project → "Deployments" tab** (next to Repos): three environment cards
  (dev/staging/prod) — status pill, URL, "Deploy" / "Restart", last-deploy time,
  link to logs. Prod-only projects show one card.
- **Workspace → "Infrastructure"** (DevOps + exec): server list with health and
  the apps/environments on each, so DevOps can see the whole estate.

## Security

- Store the Coolify token **encrypted** (same approach as other secrets), one
  per org, never sent to the client.
- Deploy/stop/restart gated to **PM / department head / exec / a `devops` role**.
- The webhook (if used) is signature/passcode-verified like the GitHub one.

## Open questions / to verify before building

- Does Coolify v4 emit a **generic outbound webhook** on deploy success/failure,
  or only Discord/Telegram/email? (Drives live-status vs polling.)
- Exact deploy endpoint verb/shape (`GET /deploy?uuid=`), and whether one
  application can represent multiple environments or we need one app per env.
- Token permission granularity (can we issue a deploy-only token, not root?).
- Should "servers" also model **non-Coolify** VPS (raw SSH)? (Out of scope for v1
  — Coolify-managed only.)

---

# Part 2 — Figma: design previews, comments & change signals

For **Creatives / UI-UX**, Figma is where the work lives. The win is bringing
**live design previews and comments** into the project — and tightening the
design → frontend handoff (the Creatives ↔ Frontend seam).

## Figma API (what we'd call)

- **Base URL:** `https://api.figma.com`
- **Auth (two options):**
  - **Personal/Team access token** — `X-Figma-Token: <token>`. Simplest; one
    org token can read team files + comments. No per-user attribution.
  - **OAuth2 per-user** — same "Connect Figma" pattern as GitHub/Google;
    scopes like `files:read`, `file_comments:write`. Gives attribution and
    respects each user's access. **Recommended** for a team tool.
- Useful endpoints:
  - `GET /v1/me` — identity (for the connect flow).
  - `GET /v1/files/:key` / `GET /v1/files/:key/nodes?ids=…` — document / specific frames.
  - **`GET /v1/images/:key?ids=…&format=png|svg&scale=2`** — render frames to
    image URLs → **live previews/thumbnails** (the headline feature).
  - `GET /v1/files/:key/comments` / `POST …/comments` — read + post comments.
  - `GET /v1/files/:key/versions` — version history / "last updated".
  - `GET /v1/teams/:team_id/projects`, `GET /v1/projects/:project_id/files` — browse a team's files.
  - `GET /v1/files/:key/variables/local` — **design tokens/variables** (Enterprise only — note the gate).
- **Webhooks v2:** `POST /v2/webhooks` for `FILE_UPDATE`, `FILE_VERSION_UPDATE`,
  `FILE_COMMENT`, `LIBRARY_PUBLISH` (scoped to a team, with a passcode). Figma
  POSTs to our endpoint → live "design updated / new comment" signals.
- **Parsing a Figma link:** `figma.com/{file|design}/<fileKey>/<name>?node-id=<id>`
  → extract `fileKey` (+ optional `node-id` for a specific frame).

## Proposed data model (new tables)

```
figma_account                 (per-user OAuth, optional — mirrors github_accounts)
  userId, accessToken, refreshToken, handle, email

figma_link                    (a design linked to a project or a work item)
  id, ownerType ('project'|'task'|'issue'), ownerId,
  fileKey, nodeId?, name, thumbnailUrl?, lastModifiedAt
```

A project can have many linked files (e.g. "Marketing site", "Mobile app");
a task/issue can link a single frame for handoff.

## API surface we'd add

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/figma/auth-url` / `/callback` / `/status` / `/disconnect` | per-user connect (if OAuth) |
| POST | `/api/v1/projects/:id/figma` | link a file/frame by URL |
| GET | `/api/v1/projects/:id/figma` | linked designs + fresh thumbnails |
| DELETE | `/api/v1/projects/:id/figma/:linkId` | unlink |
| GET | `/api/v1/figma/:fileKey/comments` | comments for a linked file |
| POST | `/api/v1/figma/:fileKey/comments` | post a comment (if write scope) |
| POST | `/api/v1/figma/webhook` | FILE_UPDATE / FILE_COMMENT → notify + refresh |

## UI surfaces

- **Project → "Designs" tab:** cards for each linked Figma file — **thumbnail**
  (from `/v1/images`), name, last-updated, comment count, "Open in Figma". A
  "design updated" badge when the webhook fires.
- **On a task/issue:** link a specific **frame**; render its preview inline so
  Frontend builds against the exact design (and can read its comments). Natural
  fit beside the existing PR/attachment sections in the item drawer.
- Optional **Creatives dashboard**: recently-updated designs across the team.

## Capabilities, phased

1. **Previews (MVP):** link files/frames by URL; show thumbnails + last-updated
   via a team token. Read-only.
2. **Comments:** surface file comments in-app; optionally post back (write scope).
3. **Live signals:** Figma webhooks → "design updated" / "new comment" →
   notifications + thumbnail refresh.
4. **Handoff polish:** per-frame previews on tasks; optionally pull
   variables/tokens (Enterprise) to compare against the frontend design system.

## Security / notes

- Prefer **OAuth per-user**; fall back to one org token for previews only.
- Cache rendered image URLs briefly (Figma image URLs expire).
- Webhooks scoped per team with a passcode; verify on receipt.

---

# Other departments (parked — note only)

- **Marketing:** analytics (Plausible/GA4), or social schedulers — link campaigns
  to projects. Lower priority.
- **HR:** mostly internal; the existing departments/members model already covers
  most needs. No external API needed yet.

# Suggested build order

1. **Coolify read-only** (servers + project environments + status) — highest
   operational value, unblocks DevOps.
2. **Figma previews** (thumbnails on projects/tasks) — quick win for Creatives.
3. Coolify **deploy actions** → Figma **comments/webhooks** → health & tokens.
