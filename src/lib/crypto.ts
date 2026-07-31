import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env";
import { AppError } from "./errors";

// Symmetric encryption for secrets we must be able to read back — right now the
// Postgres connection strings behind the database console. Hashing isn't an
// option there (we need the original to run pg_dump), so the next best thing is
// authenticated encryption with a key that lives only in the environment.
//
// Format: v1.<iv>.<authTag>.<ciphertext>, all base64url. The version prefix
// leaves room to rotate the scheme later without guessing at old payloads.

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM's standard nonce length
const PREFIX = "v1";

let cachedKey: Buffer | null = null;
let warned = false;

// Accept a 32-byte key as hex or base64. Falling back to the JWT secret keeps
// existing deployments booting, but it's a real coupling — rotating
// JWT_ACCESS_SECRET would make every stored connection string undecryptable —
// so it's loud about it once at first use.
function key(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = env.SECRET_ENCRYPTION_KEY.trim();
  if (!raw) {
    if (!warned) {
      console.warn(
        "[crypto] SECRET_ENCRYPTION_KEY is not set — deriving the encryption key from " +
          "JWT_ACCESS_SECRET. Set a dedicated key before storing production credentials; " +
          "rotating the JWT secret would otherwise orphan them.",
      );
      warned = true;
    }
    cachedKey = createHash("sha256").update(env.JWT_ACCESS_SECRET).digest();
    return cachedKey;
  }

  const decoded = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new AppError(
      500,
      "SECRET_ENCRYPTION_KEY must decode to 32 bytes (64 hex chars, or base64)",
      "bad_encryption_key",
    );
  }
  cachedKey = decoded;
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    PREFIX,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string): string {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== PREFIX || !iv || !tag || !ciphertext) {
    throw new AppError(500, "Stored secret is malformed", "bad_ciphertext");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key, or the payload was tampered with — both mean "we can't use this".
    throw new AppError(
      500,
      "Could not decrypt the stored credential — the encryption key may have changed",
      "decrypt_failed",
    );
  }
}
