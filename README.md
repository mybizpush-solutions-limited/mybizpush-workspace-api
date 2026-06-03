# MyBizPush Dev Space — API

Backend for the MyBizPush Dev Space. **Node.js + TypeScript + Express + Sequelize (Postgres) + Redis + Cloudinary + Resend + JWT.**

Auth is gated to `@mybizpush.com` email addresses only.

## Stack

| Concern        | Choice                                            |
| -------------- | ------------------------------------------------- |
| HTTP           | Express 4                                         |
| ORM / schema   | Sequelize 6 (models in `src/models`)              |
| Migrations     | Umzug (TypeScript migrations in `src/db/migrations`) |
| Database       | Postgres (`pg`)                                   |
| Cache / tokens | Redis (`ioredis`) — refresh-token allowlist       |
| Auth           | JWT access + rotating refresh tokens              |
| Uploads        | Cloudinary (image/video)                          |
| Email          | Resend                                            |
| Validation     | Zod                                               |

## Getting started

```bash
cp .env.example .env          # fill in secrets (JWT secrets are required)
npm install
# Make sure Postgres and Redis are running and DATABASE_URL/REDIS_URL point at them
npm run migrate               # create the schema
npm run seed                  # optional: load demo data (password: Password123!)
npm run dev                   # start with hot reload on http://localhost:4000
```

### Scripts

- `npm run dev` — hot-reloading dev server (tsx)
- `npm run build` / `npm start` — compile to `dist/` and run
- `npm run typecheck` — `tsc --noEmit`
- `npm run migrate` — run pending migrations (`npm run migrate -- down` to roll back one)
- `npm run seed` — load idempotent demo data

## Project structure

```
src/
  config/env.ts            # Zod-validated environment
  db/
    sequelize.ts           # Sequelize instance
    umzug.ts               # migration engine
    migrate.ts             # migration CLI
    seed.ts                # demo data
    migrations/            # TypeScript migrations
  models/index.ts          # all Sequelize models + associations (schema source of truth)
  lib/                     # errors, jwt, password, cloudinary, email
  middleware/              # auth, validate, error
  modules/
    auth/                  # register / login / refresh / logout / me  (@mybizpush.com gate)
    users/                 # list / get
    departments/           # list / get / create (executive_admin only)  ← CRUD pattern to copy
    health/                # liveness + db/redis checks
  app.ts                   # express wiring
  index.ts                 # entrypoint
```

## API surface (current)

Versioned business endpoints live under `/api/v1`. The infra health check stays unversioned at `/api/health`.

| Method | Path                         | Auth            | Notes                                  |
| ------ | ---------------------------- | --------------- | -------------------------------------- |
| GET    | `/api/health`                | —               | db + redis status (unversioned)        |
| POST   | `/api/v1/auth/register`      | —               | `@mybizpush.com` only                  |
| POST   | `/api/v1/auth/login`         | —               | sets httpOnly refresh cookie           |
| POST   | `/api/v1/auth/refresh`       | refresh cookie  | rotates refresh, returns new access    |
| POST   | `/api/v1/auth/logout`        | refresh cookie  | revokes refresh token                  |
| GET    | `/api/v1/auth/me`            | Bearer          | current user                           |
| POST   | `/api/v1/auth/forgot-password` | — (rate-limited) | emails a reset link (via Resend)    |
| POST   | `/api/v1/auth/reset-password`  | — (rate-limited) | sets a new password from a token    |
| GET    | `/api/v1/users`              | Bearer          | list users                             |
| GET    | `/api/v1/users/:id`          | Bearer          | one user                               |
| GET    | `/api/v1/departments`        | Bearer          | list departments                       |
| GET    | `/api/v1/departments/:slug`  | Bearer          | one department                         |
| POST   | `/api/v1/departments`        | executive_admin | create department                      |
| GET    | `/api/v1/projects`           | Bearer          | list (`?departmentId=`)                |
| GET    | `/api/v1/projects/:id`       | Bearer          | one project                            |
| POST   | `/api/v1/projects`           | Bearer          | create project                         |
| PATCH  | `/api/v1/projects/:id`       | Bearer          | update (name/manager/progress/members) |
| GET/POST/DELETE | `/api/v1/projects/:id/repos` | Bearer    | list / link (`{ repo }`) / unlink GitHub repos |
| GET    | `/api/v1/projects/:id/pull-requests` | Bearer  | open PRs across the project's repos (live) |
| GET    | `/api/v1/tasks`              | Bearer          | list (`?projectId=`)                   |
| GET    | `/api/v1/tasks/:id`          | Bearer          | one task                               |
| POST   | `/api/v1/tasks`              | Bearer          | create task                            |
| PATCH  | `/api/v1/tasks/:id`          | Bearer          | update task                            |
| POST   | `/api/v1/tasks/:id/status`   | Bearer          | change status                          |
| POST   | `/api/v1/tasks/:id/feedback/request` | Bearer  | request feedback from a user           |
| POST   | `/api/v1/tasks/:id/feedback/provide` | Bearer  | provide feedback (adds a comment)      |
| POST   | `/api/v1/tasks/:id/pull-requests`    | Bearer  | link a GitHub PR                       |
| …      | `/api/v1/issues…`            | Bearer          | identical shape to tasks (+ severity)  |
| GET/POST | `/api/v1/comments`         | Bearer          | `?itemId=` / add (with mentions)       |
| GET    | `/api/v1/activity`           | Bearer          | `?itemId=` / `?departmentId=` / recent |
| GET    | `/api/v1/notifications`      | Bearer          | mine; `/unread-count`, `/:id/read`, `/read-all` |
| GET/PATCH | `/api/v1/preferences`     | Bearer          | my email-digest preferences            |
| GET/POST | `/api/v1/meetings`         | Bearer          | list / schedule (mock Meet URL)        |
| GET    | `/api/v1/labels`             | Bearer          | list labels                            |
| GET    | `/api/v1/me/assigned`        | Bearer          | also `/awaiting-feedback`, `/due-soon`, `/reported` |
| GET/POST/DELETE | `/api/v1/attachments` | Bearer          | `?itemId=` / upload to Cloudinary (multipart `file`) / `/:id` delete |
| POST   | `/api/v1/ai/chat`            | Bearer          | OpenRouter chat (`{ messages }`)       |
| POST   | `/api/v1/ai/summarize`       | Bearer          | summarize a task/issue (`{ itemId, itemType }`) |
| GET    | `/api/v1/digests/preview`    | Bearer          | preview your digest HTML (no send)     |
| POST   | `/api/v1/digests/send-me`    | Bearer          | send yourself a test digest now        |
| POST   | `/api/v1/digests/run`        | admin           | run the batch for a cadence (`{ frequency }`) |
| GET    | `/api/v1/google/auth-url`    | Bearer          | start the Google Calendar connect flow |
| GET    | `/api/v1/google/callback`    | — (OAuth state) | Google redirect target → stores tokens |
| GET    | `/api/v1/google/status`      | Bearer          | `{ connected, email }`                 |
| POST   | `/api/v1/google/disconnect`  | Bearer          | remove the stored Google tokens        |
| GET    | `/api/v1/github/auth-url`    | Bearer          | start the GitHub connect flow          |
| GET    | `/api/v1/github/callback`    | — (OAuth state) | GitHub redirect target → stores token + identity |
| GET    | `/api/v1/github/status`      | Bearer          | `{ connected, login, avatarUrl, orgMember, org }` |
| POST   | `/api/v1/github/disconnect`  | Bearer          | remove the stored GitHub account       |
| POST   | `/api/v1/github/webhook`     | HMAC signature  | GitHub events → auto-updates linked PR status |

### GitHub setup

> 📖 Full step-by-step walkthrough (with screenshots-worthy detail) for both GitHub and Google credentials: [`docs/oauth-setup.md`](docs/oauth-setup.md).

- **PR enrichment / project repos:** set `GITHUB_TOKEN` (a fine-grained PAT with **Pull requests: Read-only** on the relevant repos). Link repos to a project from **Project → Repos**.
- **Per-user OAuth (connect account + verify org membership):** create a **GitHub OAuth App** (Settings → Developer settings → OAuth Apps). Set the **Authorization callback URL** to `GITHUB_OAUTH_REDIRECT_URI` (default `http://localhost:4000/api/v1/github/callback`), then put `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` in `.env`. Set `GITHUB_ORG` to the org whose membership should be verified on connect (the requested scopes are `read:user` + `read:org`; leave `GITHUB_ORG` empty to skip the check). Users connect from the onboarding wizard's **Connect your tools** step or later from **Profile → GitHub**.
- **Webhook (auto-update PR status):** in each repo (or the org) → **Settings → Webhooks → Add webhook**. Payload URL `https://<api-host>/api/v1/github/webhook`, content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`, events: **Pull requests**. When a PR is merged/closed/reopened, any linked PR (on a task/issue) updates automatically.

## Docker

```bash
cp .env.example .env   # fill JWT secrets (required) + any integration keys
docker compose up --build
```
Brings up Postgres + Redis + the API (which runs pending migrations on start, then listens on `:4000`). The compose file overrides `DATABASE_URL`/`REDIS_URL` to point at the bundled services; everything else comes from `.env`.

### Google Calendar / Meet setup

1. In Google Cloud Console, create an **OAuth 2.0 Client ID** (Web application) and enable the **Google Calendar API**.
2. Add `GOOGLE_REDIRECT_URI` (default `http://localhost:4000/api/v1/google/callback`) to the client's **Authorized redirect URIs**, and your UI origin to **Authorized JavaScript origins**.
3. Put `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`.
4. Users connect from **Profile → Google Calendar & Meet**. Once connected, meetings they schedule create a real Calendar event with a Meet link and email invites; otherwise a placeholder URL is used.

Auth: send the access token as `Authorization: Bearer <token>`. The refresh token lives in an httpOnly cookie scoped to `/api/v1/auth`.

## Adding a resource

Each module is a `*.service.ts` (model queries + serialization to the UI's public shape, in `modules/shared/serializers.ts`) and a `*.routes.ts` (Zod validation + auth guards). The serialized shapes intentionally mirror `ui/src/types/index.ts` so the UI's `src/services` layer can swap mock calls for `fetch` with no shape changes. `modules/departments` is the simplest reference; `modules/workitems` shows the richer pattern (shared service for tasks + issues, activity logging, notifications, feedback loop).

**What's still TODO (integrations):** OpenRouter AI (`/ai/*`), GitHub PR sync (webhooks; PR linking already works), Google Calendar/Meet (real OAuth + Meet links — currently mock URLs), Resend digest scheduler honoring `notification_preferences`, and password reset. See the project plan.

## Notes

- Cloudinary and Resend are optional in dev: without keys, uploads throw a clear 503 and emails log to the console.
- The schema lives in **both** the models (ORM) and the initial migration (DB) — standard Sequelize practice. Evolve it by adding a new migration in `src/db/migrations` and updating the matching model.
