# Multi-organization GitHub support

> **Status: design / proposal. Not implemented.** Confirm before we build.

## The situation

- We have **more than one GitHub organization**. Today the GitHub App is installed
  on **`mybizpush-solutions-limited`** only.
- One project lives in a **second org**, and we still want its repos / PRs /
  commits / issues to show up in this workspace.
- **Org membership rules differ:** being a member of `mybizpush-solutions-limited`
  (the **primary** org) is **compulsory** (onboarding gate + "Verified member"
  badge). Being a member of the **second** org is **not** required.

So we need to (a) read from multiple orgs and (b) keep the membership check scoped
to the primary org only.

## How GitHub Apps handle multiple orgs (the good news)

- **One GitHub App can be installed on many orgs.** Each installation has its own
  **installation ID** and its own **installation access token** scoped to that
  org's repos. Same App ID + same private key cover all installations — **no new
  secrets.**
- The single **webhook** receives events from **all** installations; payloads say
  which org/installation they came from. Our existing handlers already match by
  repo URL / head SHA, so they keep working across orgs.

### What you change in GitHub (the manual step)

1. App → **Settings → Advanced / "Where can this app be installed?"** → switch from
   **"Only on this account"** to **"Any account."**
2. Then **install the App on the second org** (Org → Settings → GitHub Apps →
   Install, or the App's public install URL). Grant the same permissions.

> "Any account" sounds broad, but it only means the App *can* be installed
> elsewhere; an install only grants access to **that org's** repos, and our own
> auth/membership gates still control who can use the workspace. We can also keep
> an **allowlist** of orgs we actually read from (below).

## Recommended approach: one App, multiple installations

- Keep the single App. Add installs per org. Resolve the **right installation
  token by repo owner** at read time.

(The alternative — a second App per org — means duplicate credentials and config.
Only worth it if the orgs must be cryptographically isolated. Not recommended.)

## Backend changes (design)

1. **Installation resolution by org.** Replace today's single auto-discovered
   installation (`GET /orgs/{GITHUB_ORG}/installation`) with a **map of
   `orgLogin → installationId`**, built from `GET /app/installations` (App JWT).
   - `getInstallationToken(owner)` → mint/cache the token for the installation
     whose `account.login === owner`.
   - `readHeaders(owner)` → use that org's token.
   - The read helpers already receive `owner` (e.g. `getRepo(owner, repo)`,
     `listOpenPullRequests(owner, repo)`), so we just thread it through.
   - Cache one token per org (each ~1h), same single-flight guard as today.
2. **Primary vs. additional orgs.**
   - `GITHUB_ORG` stays = the **primary** org: the only one whose **membership is
     required** (onboarding + badge). `checkOrgMembership` is unchanged.
   - Additional orgs are **discovered automatically** from the App's installations
     — no per-org env needed.
   - Optional safety: `GITHUB_ALLOWED_ORGS` (comma-separated) to restrict which
     installed orgs we'll read from. Empty = all installations.
3. **Repo linking + discovery across orgs.**
   - `addRepo("owner/repo")` already carries the owner → validate against that
     org's installation token.
   - `listOrgRepos()` currently lists one org; extend to list repos across **all
     (allowed) installations**, or accept an `?org=` filter for the picker.
4. **Membership semantics (the key rule).**
   - A user connects GitHub once. The **"Verified member" badge + onboarding gate
     check only `GITHUB_ORG`** (primary). Membership in the second org is never
     required.
   - Reads from the second org use that org's **installation token**, not the
     user's token — so a user who isn't in the second org can still see its repos'
     PRs/commits in the workspace.

## Data / segregation

- `project_repos` already stores **`owner`** (the org) + `full_name`, so repos are
  inherently segregated by org — **no schema change required.**
- In the UI we can **group / label repos by org** (e.g. a small org chip), since a
  project can now span repos from different orgs.

## UI changes (design)

- **Repo picker:** group the org-repo suggestions by org (there's >1 now), or add
  an org selector.
- **Linked repos / PR / commit lists:** show the org on each row (we already have
  `owner`).
- Everything else is automatic — PR/commit/issue reads follow each repo's org via
  the correct installation token.

## Roll-out steps

1. **GitHub:** set the App to "Any account" and **install it on the second org.**
2. **Code:** switch installation-token logic to **per-org resolution** via
   `GET /app/installations`; thread `owner` through the read helpers.
3. **(Optional)** add `GITHUB_ALLOWED_ORGS` allowlist.
4. **Membership:** leave as-is — only `GITHUB_ORG` is compulsory.
5. No new secrets; same App ID + private key.

## Open questions (please confirm)

1. **Allowlist or open?** Restrict reads to a named list of orgs
   (`GITHUB_ALLOWED_ORGS`), or trust that only we install the App?
2. **Who owns the second org?** If you own it, you can install directly. If it's a
   third party, their admin must approve the install.
3. **Label repos/projects by org** in the UI, or is the repo name enough?
4. **Repo linking permission across orgs** — anyone who can manage a project, or
   only execs for non-primary orgs?
5. Confirm: **membership stays primary-org-only** (a user in `mybizpush-solutions-
   limited` but not the second org is fully fine). ✅ (assumed)
