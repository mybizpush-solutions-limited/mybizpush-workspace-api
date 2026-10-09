import { createHash } from "node:crypto";
import { Client, utils, type ParsedKey } from "ssh2";
import { env } from "../config/env";
import { AppError } from "./errors";

// Agentless SSH for the server console. One workspace key (SERVER_SSH_PRIVATE_KEY)
// reaches every server as mbp-ops, where a forced command limits it to the
// mbp-* verbs installed by the bootstrap script — see modules/servers/bootstrap.ts.

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  /** Pinned "SHA256:…" host key fingerprint; null on first contact (trust on first use). */
  hostKeyFingerprint: string | null;
}

export interface SshResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** The fingerprint the server presented — pinned by the caller on first contact. */
  hostKeyFingerprint: string;
}

export class HostKeyMismatchError extends AppError {
  constructor(expected: string, got: string) {
    super(
      409,
      `The server's host key changed (expected ${expected}, got ${got}). ` +
        "If the server was rebuilt this is expected: re-trust it in the server's settings. " +
        "If not, someone may be intercepting the connection.",
      "host_key_mismatch",
    );
  }
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

let cachedKey: { pem: string; parsed: ParsedKey } | null = null;

function privateKey(): { pem: string; parsed: ParsedKey } | null {
  const raw = env.SERVER_SSH_PRIVATE_KEY.trim();
  if (!raw) return null;
  if (cachedKey) return cachedKey;
  // Env files flatten newlines; accept the escaped form too.
  const pem = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  const parsed = utils.parseKey(pem);
  if (parsed instanceof Error) {
    throw new AppError(500, `SERVER_SSH_PRIVATE_KEY can't be read: ${parsed.message}`, "bad_ssh_key");
  }
  cachedKey = { pem: pem.endsWith("\n") ? pem : `${pem}\n`, parsed: Array.isArray(parsed) ? parsed[0]! : parsed };
  return cachedKey;
}

export function isSshConfigured(): boolean {
  try {
    return privateKey() !== null;
  } catch {
    return false;
  }
}

// The line that goes in each server's authorized_keys (before the bootstrap
// adds its from=/restrict/command= options).
export function workspacePublicKey(): string | null {
  const key = privateKey();
  if (!key) return null;
  return `${key.parsed.type} ${key.parsed.getPublicSSH().toString("base64")} mybizpush-workspace`;
}

// Same format ssh-keygen -l prints, so an operator can compare by eye.
export function fingerprint(hostKey: Buffer): string {
  return `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")}`;
}

// Run one mbp verb. The remote side ignores anything but the exact verb, so
// `command` is never a shell line.
export function runRemote(target: SshTarget, command: string, timeoutMs = env.SERVER_SSH_TIMEOUT_MS): Promise<SshResult> {
  const key = privateKey();
  if (!key) {
    return Promise.reject(
      new AppError(503, "SERVER_SSH_PRIVATE_KEY isn't set on the API, so servers can't be reached", "ssh_not_configured"),
    );
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let presented = "";
    let mismatch: HostKeyMismatchError | null = null;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new AppError(504, `No answer from ${target.host} within ${Math.round(timeoutMs / 1000)}s`, "ssh_timeout"))),
      timeoutMs,
    );

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) return finish(() => reject(err));
          let stdout = "";
          let stderr = "";
          stream
            .on("data", (d: Buffer) => {
              if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString("utf8");
            })
            .on("close", (code: number | null) =>
              finish(() => resolve({ stdout, stderr, code, hostKeyFingerprint: presented })),
            );
          stream.stderr.on("data", (d: Buffer) => {
            if (stderr.length < 64 * 1024) stderr += d.toString("utf8");
          });
        });
      })
      .on("error", (err) =>
        finish(() => reject(mismatch ?? new AppError(502, `SSH to ${target.host} failed: ${err.message}`, "ssh_failed"))),
      )
      .connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey: key.pem,
        readyTimeout: timeoutMs,
        keepaliveInterval: 10_000,
        hostVerifier: (hostKey: Buffer) => {
          presented = fingerprint(hostKey);
          if (target.hostKeyFingerprint && target.hostKeyFingerprint !== presented) {
            mismatch = new HostKeyMismatchError(target.hostKeyFingerprint, presented);
            return false;
          }
          return true;
        },
      });
  });
}
