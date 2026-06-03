# OAuth setup — GitHub & Google

A step-by-step guide to creating the credentials MyBizPush Dev Space needs for its
two per-user integrations:

- **GitHub** — connect a teammate's GitHub account, verify they're in your org, and link their pull requests.
- **Google** — Calendar + Meet, so meetings scheduled in the app create real Calendar events with Meet links.

Both are **per-user OAuth** flows: each teammate clicks "Connect" (in the onboarding
wizard's *Connect your tools* step, or later from **Profile**) and authorizes the app
for their own account. You, the admin, only create the app credentials **once** and put
them in `api/.env`.

> All env vars below live in `api/.env` (copy from `api/.env.example`). They're optional —
> the API boots without them — but the relevant "Connect" button returns a *"not configured"*
> error until they're set.

---

## At a glance

| Integration | Env vars you'll set | Where you get them |
| --- | --- | --- |
| GitHub (connect + org check) | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URI`, `GITHUB_ORG` | GitHub → Settings → Developer settings → **OAuth Apps** |
| GitHub (PR enrichment, optional) | `GITHUB_TOKEN` | GitHub → Settings → Developer settings → **Personal access tokens** |
| GitHub (webhook, optional) | `GITHUB_WEBHOOK_SECRET` | A random secret you invent, set on the repo/org webhook |
| Google (Calendar + Meet) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google Cloud Console → **APIs & Services → Credentials** |

**Default callback URLs (local dev):**

- GitHub: `http://localhost:4000/api/v1/github/callback`
- Google: `http://localhost:4000/api/v1/google/callback`

For a deployed API, swap `http://localhost:4000` for your API's public origin (e.g.
`https://api.yourdomain.com`) **everywhere** — in the provider's console *and* in `.env`.

---

## 1. GitHub OAuth App (per-user connect + org verification)

This is the integration we just built. It uses a classic **OAuth App** (not a GitHub App).
Requested scopes: `read:user` (profile) and `read:org` (to confirm org membership).

### Steps

1. Go to **GitHub → your avatar → Settings → Developer settings → OAuth Apps → New OAuth App**.
   (Direct link: https://github.com/settings/developers)
   - To register it under your **organization** instead of your personal account, use
     **Org → Settings → Developer settings → OAuth Apps → New OAuth App**. Either works;
     org-owned is tidier for a team tool.
2. Fill in:
   - **Application name:** `MyBizPush Dev Space` (whatever your team will recognize on the consent screen)
   - **Homepage URL:** your UI URL — `http://localhost:3000` for local dev (this is `APP_URL`).
   - **Authorization callback URL:** **must exactly match** `GITHUB_OAUTH_REDIRECT_URI` →
     `http://localhost:4000/api/v1/github/callback`
   - Leave "Enable Device Flow" unchecked.
3. Click **Register application**.
4. On the app page, copy the **Client ID**.
5. Click **Generate a new client secret**, then copy it **immediately** (GitHub only shows it once).
6. Put both in `api/.env`:
   ```env
   GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxx
   GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   GITHUB_OAUTH_REDIRECT_URI=http://localhost:4000/api/v1/github/callback
   GITHUB_ORG=mybizpush
   GITHUB_OAUTH_BASE_URL=https://github.com/login/oauth
   ```
   - `GITHUB_ORG` is the org login slug whose membership is checked on connect (the bit in
     `github.com/<org>`). Leave it **empty** to skip the check — users still connect, they
     just won't get the green "Verified member" badge.
   - `GITHUB_OAUTH_BASE_URL` only changes for **GitHub Enterprise Server** (`https://<host>/login/oauth`).
     Leave the default for github.com.
7. Restart the API.

### Notes

- **No verification / publishing needed.** OAuth Apps work for anyone immediately; there's
  no "test users" list or review like Google has.
- **Tokens don't expire.** Classic OAuth-App tokens stay valid until the user disconnects or
  revokes them — so there's no weekly-reconnect problem (unlike Google in Testing mode, below).
- **Org membership visibility:** the `read:org` scope lets the app read the user's org
  memberships. If a member's org visibility is *Private*, the membership check still works
  because it queries *their own* memberships with *their* token — they just have to be an
  actual member of `GITHUB_ORG`.

---

## 2. (Optional) GitHub PAT for PR enrichment + webhook secret

These are **separate** from the OAuth App above and only needed for the project-repos / PR
features — not for the per-user "Connect GitHub" button.

### `GITHUB_TOKEN` — read PR/repo metadata

Used to fetch PR titles/status and validate repos when linking them to a project.

1. **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.**
2. Scope it to the repos you'll link, with **Repository permissions → Pull requests: Read-only**
   (and **Contents: Read-only** if the repos are private).
3. Copy the token and set:
   ```env
   GITHUB_TOKEN=github_pat_xxxxxxxx
   ```
   Without it, public repos still work at a lower rate limit; private repos won't.

### `GITHUB_WEBHOOK_SECRET` — auto-update linked PR status

1. Invent a random secret (e.g. `openssl rand -hex 32`).
2. In each repo (or the org) → **Settings → Webhooks → Add webhook**:
   - **Payload URL:** `https://<your-api-host>/api/v1/github/webhook`
   - **Content type:** `application/json`
   - **Secret:** the value you generated
   - **Events:** *Let me select individual events* → **Pull requests**
3. Set the same value in `.env`:
   ```env
   GITHUB_WEBHOOK_SECRET=<the-same-secret>
   ```

---

## 3. Google OAuth (Calendar + Meet)

Scopes requested: `https://www.googleapis.com/auth/calendar.events`, `openid`, `email`.

### Steps

1. Open the **Google Cloud Console** → https://console.cloud.google.com and select (or create)
   a project.
2. **Enable the API:** APIs & Services → **Library** → search **Google Calendar API** → **Enable**.
3. **Configure the OAuth consent screen** (APIs & Services → **OAuth consent screen**):
   - **User type: External.** (We are **not** on Google Workspace, so Internal isn't available.)
     External apps start in **Testing** status, which revokes refresh tokens after 7 days — not
     acceptable for us, so we **publish + verify** the app (see [§3a](#3a-getting-the-google-app-approved-production--verification) below).
   - Fill in app name, support email, and developer contact. Add the `calendar.events` scope if prompted.
4. **Create credentials:** APIs & Services → **Credentials → Create credentials → OAuth client ID**:
   - **Application type:** Web application
   - **Name:** `MyBizPush Dev Space`
   - **Authorized JavaScript origins:** your UI origin — `http://localhost:3000` (i.e. `APP_URL`)
   - **Authorized redirect URIs:** **must exactly match** `GOOGLE_REDIRECT_URI` →
     `http://localhost:4000/api/v1/google/callback`
5. Click **Create**, then copy the **Client ID** and **Client secret**.
6. Put them in `api/.env`:
   ```env
   GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
   GOOGLE_REDIRECT_URI=http://localhost:4000/api/v1/google/callback
   ```
7. Restart the API.

> ⚠️ **Watch the redirect URI for typos.** It must be a well-formed URL with a slash before
> `api/` — e.g. `https://your-host.com/api/v1/google/callback`, **not**
> `https://your-host.comapi/v1/google/callback`. A malformed value silently breaks the
> callback. (The current `api/.env` has exactly this missing-slash typo — fix it before
> deploying Google.)

### 3a. Getting the Google app approved (production + verification)

**Our situation:** we're not on Google Workspace, so the OAuth app is **External**. We need it
**Published** (to escape Testing mode's 7-day refresh-token revocation) **and verified** (to
drop the "unverified app" warning and the 100-user cap). Our only Google scope,
`.../auth/calendar.events`, is a **Sensitive** scope — so it needs Google's OAuth verification,
but **not** the heavier third-party security assessment (CASA) that *Restricted* scopes like
Gmail/Drive require. That keeps this relatively lightweight.

> **Two separate dials.** *Publishing status* (Testing → In production) and *verification status*
> (unverified → verified) are independent. **Publishing alone stops the 7-day clock immediately** —
> verification just removes the warning screen and the user cap. So you can publish today and let
> verification land later.

#### Prerequisites (this is where the real work is)

Google won't verify an app that doesn't have these, all on **a domain you own and have verified**
(use `mybizpush.com`):

1. **Verify domain ownership** in [Google Search Console](https://search.google.com/search-console)
   for `mybizpush.com` (and add it under the consent screen's **Authorized domains**).
2. **Homepage URL** — a real, reachable page on the domain (e.g. `https://mybizpush.com` or a
   product page). It must explain what the app does.
3. **Privacy policy URL** — hosted on the same domain, and it must mention how you use Google
   user data / the Calendar scope. (A generic privacy page that doesn't mention Google data is a
   common rejection reason.)
4. **App logo** — uploading one triggers a brand-verification check too, but it's expected.
5. **Use the same Google account** that owns/has Editor on the Cloud project for all of this.

#### Steps

1. Finish the **OAuth consent screen**: app name, user-support email, app logo, the homepage +
   privacy-policy URLs above, authorized domain `mybizpush.com`, and developer contact email.
2. Under **Scopes**, confirm only what we actually use is listed: `.../auth/calendar.events`,
   `openid`, `email`. (Fewer scopes = faster review. Don't add scopes "just in case.")
3. Click **Publish App** → confirm **Push to production**. ✅ **At this point the 7-day token
   expiry is gone.** The app is now "In production" but unverified: users see a "Google hasn't
   verified this app" interstitial (clickable through *Advanced → Go to … (unsafe)*), and you're
   capped at 100 users until verified.
4. Click **Prepare for verification** (or the **Submit for verification** prompt) and complete the
   form: justify each scope ("we create Google Calendar events with Meet links on the user's behalf
   when they schedule a meeting in MyBizPush Dev Space"), and provide a **demo video**.
5. **Demo video requirements** (record once, e.g. Loom/screen capture, unlisted YouTube is fine):
   - Show the **OAuth client ID / the app's URL in the address bar** during the grant.
   - Walk through the **consent screen** and each requested scope.
   - Show the feature that **uses** the scope (scheduling a meeting → a real Calendar event +
     Meet link appears). Reviewers reject videos that don't show the scope actually being used.
6. **Submit** and wait. Respond promptly to any Google follow-up email — most rejections are a
   privacy-policy wording fix or a clearer demo video, then a quick re-submit.

#### Timeline & expectations

- Sensitive-scope verification typically takes **a few business days to a few weeks**, mostly
  gated on back-and-forth, not Google's queue.
- **During the wait:** the app is published, so tokens are stable (no weekly reconnect). Teammates
  just click through the unverified-app warning once. With a team under 100 people, you're fully
  functional even before approval lands.
- **After approval:** warning screen gone, user cap lifted. Nothing in our code changes — same
  client ID/secret, same redirect URI.

#### What you do NOT need

- No CASA / third-party security assessment — that's only for *Restricted* scopes (Gmail, full
  Drive, etc.), which we don't use.
- No Google Workspace subscription.
- No code changes — verification is purely a Cloud Console + content (domain/privacy/video) task.

---

## 4. Wiring it up (local vs. deployed)

`.env` keys recap:

```env
# GitHub per-user OAuth
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_OAUTH_REDIRECT_URI=http://localhost:4000/api/v1/github/callback
GITHUB_ORG=mybizpush
GITHUB_OAUTH_BASE_URL=https://github.com/login/oauth

# Google Calendar + Meet
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:4000/api/v1/google/callback

# UI origin the callbacks redirect back to (and emails link to)
APP_URL=http://localhost:3000
```

**Deploying?** In each provider's console, **add** (don't replace, unless you're removing
local) the production callback URLs, then set the matching `*_REDIRECT_URI` and `APP_URL` in
the server's environment. The callback host is the **API's** public origin; `APP_URL` is the
**UI's** public origin. After OAuth, both callbacks redirect the browser to
`${APP_URL}/profile?<provider>=connected|error`.

---

## 5. Verify it works

1. Start the API and UI, sign in, and open **Profile** (or run through onboarding).
2. **GitHub:** click **Connect** on the GitHub card → authorize on github.com → you're sent
   back to Profile with a "GitHub connected" toast. The card shows `@your-login` and, if
   `GITHUB_ORG` is set, a green **"Verified member of `<org>`"** badge.
3. **Google:** click **Connect** on the Google Calendar & Meet card → consent → back to
   Profile showing **Connected · your-email**. Schedule a meeting → it should produce a real
   Meet link.

Quick API smoke test (with a logged-in session's bearer token):

```bash
curl -H "Authorization: Bearer <accessToken>" http://localhost:4000/api/v1/github/status
# → {"connected":true,"login":"...","avatarUrl":"...","orgMember":true,"org":"mybizpush"}

curl -H "Authorization: Bearer <accessToken>" http://localhost:4000/api/v1/google/status
# → {"connected":true,"email":"you@mybizpush.com"}
```

---

## 6. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `"GitHub integration is not configured"` (503) | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` missing or API not restarted after editing `.env`. |
| `"Google integration is not configured"` (503) | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` missing. |
| GitHub returns `redirect_uri mismatch` | The OAuth App's **Authorization callback URL** doesn't byte-for-byte match `GITHUB_OAUTH_REDIRECT_URI`. |
| Google returns `redirect_uri_mismatch` (Error 400) | The redirect URI isn't in the client's **Authorized redirect URIs**, or there's a typo / missing slash in `GOOGLE_REDIRECT_URI`. |
| Connected, but no green "Verified member" badge | User isn't an active member of `GITHUB_ORG`, or `GITHUB_ORG` is empty/misspelled. |
| Google: `access_blocked` / "app not verified" | App still in **Testing** and the user isn't a **Test user**. The fix is to **Publish** the app ([§3a](#3a-getting-the-google-app-approved-production--verification)); pre-verification, users click through *Advanced → Go to … (unsafe)*. |
| Google users get logged out / "reconnect" weekly | App is in **Testing** (7-day refresh-token revocation). **Publish App** (Testing → In production) — this alone stops the 7-day clock, even before verification completes. See [§3a](#3a-getting-the-google-app-approved-production--verification). |

---

See also `api/README.md` (**GitHub setup** and **Google Calendar / Meet setup** sections) for
the condensed version.
