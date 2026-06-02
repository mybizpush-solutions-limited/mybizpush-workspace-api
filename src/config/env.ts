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

  // GitHub PR enrichment (optional token for private repos / higher rate limits).
  GITHUB_TOKEN: z.string().optional().default(""),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  // Shared secret for verifying inbound GitHub webhooks (X-Hub-Signature-256).
  GITHUB_WEBHOOK_SECRET: z.string().optional().default(""),

  // GitHub per-user OAuth (connect account + verify org membership). The
  // redirect URI must match the GitHub OAuth App's "Authorization callback URL".
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
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:\n", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
