import "dotenv/config";
import { z } from "zod";

// Validate and freeze environment configuration at boot. Fail fast with a clear
// message if anything required is missing or malformed.
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),

  ALLOWED_EMAIL_DOMAIN: z.string().min(1).default("mybizpush.com"),
  JWT_ACCESS_SECRET: z.string().min(1),
  JWT_REFRESH_SECRET: z.string().min(1),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("30d"),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  CLOUDINARY_CLOUD_NAME: z.string().optional().default(""),
  CLOUDINARY_API_KEY: z.string().optional().default(""),
  CLOUDINARY_API_SECRET: z.string().optional().default(""),
  CLOUDINARY_UPLOAD_FOLDER: z.string().default("mybizpush-dev-space"),

  RESEND_API_KEY: z.string().optional().default(""),
  EMAIL_FROM: z.string().default("MyBizPush Dev Space <no-reply@mybizpush.com>"),

  OPENROUTER_API_KEY: z.string().optional().default(""),
  OPENROUTER_MODEL: z.string().default("openai/gpt-oss-20b"),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),

  // Public URL of the UI (used in emails, e.g. the password-reset link).
  APP_URL: z.string().url().default("http://localhost:3000"),

  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  // Shared secret for verifying inbound GitHub webhooks (X-Hub-Signature-256).
  GITHUB_WEBHOOK_SECRET: z.string().optional().default(""),

  // ---- GitHub App (org-wide integration) ----
  // The App authenticates org-wide via a signed JWT → installation token (no
  // personal access token needed). Create the App under the org, install it,
  // and supply its ID + private key (PEM). The installation ID is optional —
  // we auto-discover it from GITHUB_ORG when omitted.
  GITHUB_APP_ID: z.string().optional().default(""),
  // RSA private key (PEM). Paste with literal "\n" newlines or base64-encode it.
  GITHUB_APP_PRIVATE_KEY: z.string().optional().default(""),
  GITHUB_APP_INSTALLATION_ID: z.string().optional().default(""),

  // User authorization (connect account + verify org membership) uses the same
  // GitHub App's client credentials. Redirect URI must match the App's
  // "Callback URL". GitHub App user tokens need no scopes.
  GITHUB_CLIENT_ID: z.string().optional().default(""),
  GITHUB_CLIENT_SECRET: z.string().optional().default(""),
  GITHUB_OAUTH_REDIRECT_URI: z.string().url().default("http://localhost:4000/api/v1/github/callback"),
  // Org whose membership we verify on connect (e.g. "mybizpush"). Empty = skip.
  GITHUB_ORG: z.string().optional().default(""),
  // OAuth authorize/token endpoints (override for GitHub Enterprise).
  GITHUB_OAUTH_BASE_URL: z.string().url().default("https://github.com/login/oauth"),

  // Digest scheduler (cron expressions; toggle off in tests/CI).
  ENABLE_DIGEST_SCHEDULER: z
    .string()
    .default("true")
    .transform((s) => s !== "false"),
  DIGEST_DAILY_CRON: z.string().default("0 8 * * *"), // 08:00 every day
  DIGEST_WEEKLY_CRON: z.string().default("0 8 * * 1"), // 08:00 every Monday

  // Google OAuth (Calendar + Meet). Redirect URI must be registered in the
  // Google Cloud OAuth client's "Authorized redirect URIs".
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  GOOGLE_REDIRECT_URI: z.string().url().default("http://localhost:4000/api/v1/google/callback"),

  // Central account that OWNS every scheduled meeting (e.g. mybizpush@gmail.com).
  // A long-lived refresh token for that account (obtained once via the OAuth
  // consent flow / playground with the calendar.events scope). When set, all
  // Meet events are created on this account's calendar and attendees are invited
  // by email. Empty = fall back to a placeholder Meet link (dev only).
  GOOGLE_MEET_ORGANIZER_REFRESH_TOKEN: z.string().optional().default(""),
  GOOGLE_MEET_ORGANIZER_EMAIL: z.string().optional().default(""),

  // Slug of the department whose members may schedule meetings (in addition to
  // executives and project managers).
  HR_DEPARTMENT_SLUG: z.string().default("hr"),

  // ---- Website analytics ----
  // Rollup keeps the dashboards fast; prune keeps the raw event log bounded.
  ENABLE_ANALYTICS_SCHEDULER: z
    .string()
    .default("true")
    .transform((s) => s !== "false"),
  ANALYTICS_ROLLUP_CRON: z.string().default("*/15 * * * *"), // every 15 minutes
  ANALYTICS_PRUNE_CRON: z.string().default("30 3 * * *"), // 03:30 every day
  ANALYTICS_RETENTION_DAYS: z.coerce.number().int().positive().default(400),

  // ---- Database backups ------------------------------------------------
  // Key used to encrypt stored Postgres connection strings at rest
  // (AES-256-GCM). 32 bytes as hex (64 chars) or base64. Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // Empty = derive from JWT_ACCESS_SECRET, which works but ties the ciphertext
  // to that secret — rotating it would orphan every stored connection string.
  SECRET_ENCRYPTION_KEY: z.string().optional().default(""),

  // Absolute or relative path where dumps are written before upload, and where
  // they stay when Cloudinary can't take them. Must be a durable volume in prod.
  BACKUP_STORAGE_DIR: z.string().default(".backups"),
  // pg_dump binary (override if it isn't on PATH, e.g. a versioned install).
  PG_DUMP_PATH: z.string().default("pg_dump"),
  // Hard stop for a single dump, so a wedged connection can't pin a worker.
  BACKUP_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  // Dumps larger than this stay on the local volume instead of going to
  // Cloudinary (whose raw-file cap is 10MB free / ~100MB on paid plans).
  BACKUP_CLOUDINARY_MAX_MB: z.coerce.number().int().positive().default(90),
  // Keep the local copy after a successful Cloudinary upload (belt and braces).
  BACKUP_KEEP_LOCAL_COPY: z
    .string()
    .default("false")
    .transform((s) => s === "true"),
  // How long a generated download link stays valid.
  BACKUP_DOWNLOAD_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Ticker that runs due backup schedules.
  ENABLE_BACKUP_SCHEDULER: z
    .string()
    .default("true")
    .transform((s) => s !== "false"),
  BACKUP_SCHEDULER_CRON: z.string().default("* * * * *"), // every minute
  // Default IANA timezone new schedules are expressed in.
  BACKUP_DEFAULT_TIMEZONE: z.string().default("Africa/Lagos"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:\n", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
