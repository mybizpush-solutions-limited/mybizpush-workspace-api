# OAuth setup — GitHub & Google

A step-by-step guide to creating the credentials MyBizPush Dev Space needs for its
two integrations:

- **GitHub** — a **GitHub App** installed on your org: reads PRs/repos org-wide, lets each
  teammate connect their account, verifies they're in your org, and receives one webhook.
- **Google** — Calendar + Meet, so meetings scheduled in the app create real Calendar events with Meet links.

Both expose a per-user "Connect" button (in the onboarding wizard's *Connect your tools*
step, or later from **Profile**). You, the admin, create the credentials **once** and put
them in `api/.env`; the GitHub App is additionally installed on the org so it can read
org data server-side.

> All env vars below live in `api/.env` (copy from `api/.env.example`). They're optional —
> the API boots without them — but the relevant "Connect" button returns a *"not configured"*
> error until they're set.

---

## At a glance

| Integration | Env vars you'll set | Where you get them |
| --- | --- | --- |
| GitHub App (org reads + identity) | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_ORG` | Org → Settings → Developer settings → **GitHub Apps** |
| GitHub App (user connect + org check) | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URI` | Same App's settings page |
| GitHub App (webhook) | `GITHUB_WEBHOOK_SECRET` | A random secret you set on the App's webhook |
| Google (Calendar + Meet) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google Cloud Console → **APIs & Services → Credentials** |

**Default callback URLs (local dev):**

- GitHub: `http://localhost:4000/api/v1/github/callback`
- Google: `http://localhost:4000/api/v1/google/callback`

For a deployed API, swap `http://localhost:4000` for your API's public origin (e.g.
`https://api.yourdomain.com`) **everywhere** — in the provider's console *and* in `.env`.

---

## 1. GitHub App (org integration — reads, identity, webhook)

One **GitHub App**, installed on the org, powers everything: it reads PRs/repos org-wide
via an installation token (no personal access token), provides the identity for the
per-user "Connect GitHub" flow, verifies org membership, and delivers one org-wide webhook.

### 1a. Create the App

1. Go to **Org → Settings → Developer settings → GitHub Apps → New GitHub App**.
   (Direct link: `https://github.com/organizations/<org>/settings/apps` — or your personal
   **Settings → Developer settings → GitHub Apps** if you don't own the org yet; you can
   transfer it later.)
2. **Basics:**
   - **GitHub App name:** `MyBizPush Dev Space`
   - **Homepage URL:** your UI URL — `http://localhost:3000` for local dev (this is `APP_URL`).
3. **Identifying and authorizing users** (this drives the "Connect GitHub" button):
   - **Callback URL:** **must exactly match** `GITHUB_OAUTH_REDIRECT_URI` →
     `http://localhost:4000/api/v1/github/callback`
   - Leave **"Request user authorization (OAuth) during installation"** unchecked, and
     **"Expire user authorization tokens"** unchecked (so connected accounts stay connected).
4. **Webhook:**
   - **Active:** checked. **Webhook URL:** `https://<your-api-host>/api/v1/github/webhook`
     (for local dev, expose `:4000` with a tunnel, e.g. `cloudflared`/`ngrok`, or leave the
     webhook inactive and rely on the live PR fetch).
   - **Webhook secret:** invent one (`openssl rand -hex 32`) → this is `GITHUB_WEBHOOK_SECRET`.
5. **Permissions:**
   - **Repository permissions → Pull requests: Read-only**, **Contents: Read-only** (or
     **Metadata: Read-only** at minimum for public repos).
   - **Organization permissions → Members: Read-only** (lets the App verify org membership
     server-side, independent of what each user grants).
   - **Account permissions → Email addresses: Read-only** (optional — resolves the connected
     user's profile).
6. **Subscribe to events:** **Pull request**.
7. **Where can this App be installed?** *Only on this account*.
8. **Create GitHub App.**

### 1b. Get the credentials

On the new App's settings page:

- Copy the **App ID** → `GITHUB_APP_ID`.
- Copy the **Client ID** → `GITHUB_CLIENT_ID`.
- **Generate a new client secret** → `GITHUB_CLIENT_SECRET` (copy immediately).
- Scroll to **Private keys → Generate a private key** → downloads a `.pem` → `GITHUB_APP_PRIVATE_KEY`.

The private key is multi-line PEM. Two ways to put it in a single-line `.env`:

```env
# Option A — paste with literal \n between the lines:
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n...\n-----END RSA PRIVATE KEY-----\n"

# Option B — base64 the whole file (the API auto-detects and decodes it):
#   base64 -i your-app.private-key.pem | tr -d '\n'
GITHUB_APP_PRIVATE_KEY=LS0tLS1CRUdJTiBSU0Eg...
```

### 1c. Install it on the org

1. App settings → **Install App** → choose the org → **All repositories** (or select the ones
   you'll link to projects) → **Install**.
2. Set the rest of `.env`:
   ```env
   GITHUB_APP_ID=123456
   GITHUB_APP_PRIVATE_KEY=...            # from 1b
   GITHUB_CLIENT_ID=Iv23xxxxxxxxxxxx
   GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   GITHUB_OAUTH_REDIRECT_URI=http://localhost:4000/api/v1/github/callback
   GITHUB_ORG=mybizpush
   GITHUB_WEBHOOK_SECRET=<the-secret-from-step-4>
   # GITHUB_APP_INSTALLATION_ID is auto-discovered from GITHUB_ORG; pin it only if needed.
   ```
   - `GITHUB_ORG` is the org login slug (the bit in `github.com/<org>`). It's used both to
     auto-discover the installation **and** as the org whose membership is verified on connect.
     Leave it empty to skip the membership badge.
3. Restart the API.

### Notes

- **Installation token, not a PAT.** The App mints a short-lived (~1h) installation token from
  a signed JWT and caches it; you never manage a personal access token. `GITHUB_TOKEN` remains
  only as a legacy fallback for PR reads before the App is configured.
- **Server-side membership check.** With **Members: Read-only**, the App confirms membership via
  the installation token (`GET /orgs/<org>/members/<login>`) — it doesn't depend on the scopes a
  user grants, and works even for users with *Private* org visibility.
- **One webhook for the whole org**, configured on the App — no per-repo webhook setup.
- **No public review/verification** needed while it's installed on *Only this account*.

---

## 2. Google OAuth (Calendar + Meet)

Scopes requested: `https://www.googleapis.com/auth/calendar.events`, `openid`, `email`.

### Steps

1. Open the **Google Cloud Console** → https://console.cloud.google.com and select (or create)
   a project.
2. **Enable the API:** APIs & Services → **Library** → search **Google Calendar API** → **Enable**.
3. **Configure the OAuth consent screen** (APIs & Services → **OAuth consent screen**):
   - **User type: External.** (We are **not** on Google Workspace, so Internal isn't available.)
     External apps start in **Testing** status, which revokes refresh tokens after 7 days — not
     acceptable for us, so we **publish + verify** the app (see [§2a](#2a-getting-the-google-app-approved-production--verification) below).
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

### 2a. Getting the Google app approved (production + verification)

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

## 3. Wiring it up (local vs. deployed)

`.env` keys recap:

```env
# GitHub App
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_OAUTH_REDIRECT_URI=http://localhost:4000/api/v1/github/callback
GITHUB_ORG=mybizpush
GITHUB_WEBHOOK_SECRET=

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

## 4. Verify it works

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

## 5. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `"GitHub integration is not configured"` (503) | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` missing or API not restarted after editing `.env`. |
| `"Google integration is not configured"` (503) | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` missing. |
| GitHub returns `redirect_uri mismatch` | The GitHub App's **Callback URL** doesn't byte-for-byte match `GITHUB_OAUTH_REDIRECT_URI`. |
| `"GitHub App is not installed on the org"` (502) | The App isn't installed on `GITHUB_ORG`, or `GITHUB_ORG` is misspelled. Install it under App settings → **Install App**. |
| `"Failed to mint a GitHub App installation token"` (502) | `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` wrong, or the PEM lost its newlines — re-paste with literal `\n` or base64-encode it. |
| Google returns `redirect_uri_mismatch` (Error 400) | The redirect URI isn't in the client's **Authorized redirect URIs**, or there's a typo / missing slash in `GOOGLE_REDIRECT_URI`. |
| Connected, but no green "Verified member" badge | User isn't an active member of `GITHUB_ORG`, or `GITHUB_ORG` is empty/misspelled. |
| Google: `access_blocked` / "app not verified" | App still in **Testing** and the user isn't a **Test user**. The fix is to **Publish** the app ([§2a](#2a-getting-the-google-app-approved-production--verification)); pre-verification, users click through *Advanced → Go to … (unsafe)*. |
| Google users get logged out / "reconnect" weekly | App is in **Testing** (7-day refresh-token revocation). **Publish App** (Testing → In production) — this alone stops the 7-day clock, even before verification completes. See [§2a](#2a-getting-the-google-app-approved-production--verification). |

---

See also `api/README.md` (**GitHub setup** and **Google Calendar / Meet setup** sections) for
the condensed version.
