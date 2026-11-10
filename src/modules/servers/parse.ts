// Parsers for what the on-host mbp-* scripts print (key=value lines; repeated
// keys are lists), plus the findings the console flags from a snapshot.

type Lines = Map<string, string[]>;

function toLines(text: string): Lines {
  const out: Lines = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const list = out.get(key) ?? [];
    list.push(line.slice(eq + 1));
    out.set(key, list);
  }
  return out;
}

const one = (l: Lines, k: string) => l.get(k)?.[0] ?? "";
const num = (l: Lines, k: string) => {
  const n = Number(one(l, k));
  return Number.isFinite(n) ? n : 0;
};
const epochIso = (s: string) => (/^\d+$/.test(s) ? new Date(Number(s) * 1000).toISOString() : null);
const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 1000) / 10 : 0);

export interface ServerStats {
  version: number;
  mode: string;
  hostname: string;
  os: string;
  kernelRunning: string;
  kernelLatest: string;
  uptimeSeconds: number;
  bootedAt: string;
  load: [number, number, number];
  cpuCount: number;
  memory: { totalKb: number; availableKb: number; usedPct: number };
  swap: { totalKb: number; freeKb: number; usedPct: number };
  disks: { mount: string; sizeKb: number; usedKb: number; usedPct: number }[];
  pendingUpdates: number;
  securityUpdates: number;
  upgradable: { name: string; from: string; to: string; security: boolean }[];
  held: { name: string; installed: string; candidate: string; upgradeAvailable: boolean }[];
  rebootRequired: boolean;
  rebootPackages: string[];
  unattended: { enabled: boolean; autoReboot: boolean; autoRebootTime: string; lastRunAt: string | null };
  aptListsUpdatedAt: string | null;
  lastAptActivity: string;
  failedUnits: string[];
  dockerVersion: string;
  containers: { name: string; state: string; status: string; image: string }[];
  listening: { proto: string; address: string; process: string }[];
  ufw: string;
  fail2ban: { jail: string; banned: number; total: number }[];
  sshFailures24h: number;
  sshd: { permitRootLogin: string; passwordAuthentication: string };
}

export function parseStats(text: string, now = new Date()): ServerStats {
  const l = toLines(text);
  const memTotal = num(l, "mem_total_kb");
  const memAvail = num(l, "mem_available_kb");
  const swapTotal = num(l, "swap_total_kb");
  const swapFree = num(l, "swap_free_kb");
  const uptime = num(l, "uptime_seconds");

  return {
    version: num(l, "mbp_version"),
    mode: one(l, "mode"),
    hostname: one(l, "hostname"),
    os: one(l, "os"),
    kernelRunning: one(l, "kernel_running"),
    kernelLatest: one(l, "kernel_latest"),
    uptimeSeconds: uptime,
    bootedAt: new Date(now.getTime() - uptime * 1000).toISOString(),
    load: [num(l, "load1"), num(l, "load5"), num(l, "load15")],
    cpuCount: num(l, "cpu_count"),
    memory: { totalKb: memTotal, availableKb: memAvail, usedPct: pct(memTotal - memAvail, memTotal) },
    swap: { totalKb: swapTotal, freeKb: swapFree, usedPct: pct(swapTotal - swapFree, swapTotal) },
    disks: (l.get("disk") ?? []).map((d) => {
      const [mount = "", size = "0", used = "0"] = d.split("|");
      return { mount, sizeKb: Number(size), usedKb: Number(used), usedPct: pct(Number(used), Number(size)) };
    }),
    pendingUpdates: num(l, "pending_updates"),
    securityUpdates: num(l, "security_updates"),
    upgradable: (l.get("upgradable") ?? []).map((u) => {
      const [name = "", from = "", to = "", sec = "0"] = u.split("|");
      return { name, from, to, security: sec === "1" };
    }),
    held: (l.get("held") ?? []).map((h) => {
      const [name = "", installed = "", candidate = ""] = h.split("|");
      return {
        name,
        installed,
        candidate,
        upgradeAvailable: Boolean(candidate && installed && candidate !== "(none)" && candidate !== installed),
      };
    }),
    rebootRequired: one(l, "reboot_required") === "1",
    rebootPackages: one(l, "reboot_pkgs").split(/\s+/).filter(Boolean),
    unattended: {
      enabled: one(l, "unattended_enabled") === "1",
      autoReboot: one(l, "auto_reboot") === "true",
      autoRebootTime: one(l, "auto_reboot_time"),
      lastRunAt: epochIso(one(l, "unattended_last_run")),
    },
    aptListsUpdatedAt: epochIso(one(l, "apt_lists_updated")),
    lastAptActivity: one(l, "last_apt_activity"),
    failedUnits: l.get("failed_unit") ?? [],
    dockerVersion: one(l, "docker_version"),
    containers: (l.get("container") ?? []).map((c) => {
      const [name = "", state = "", status = "", image = ""] = c.split("|");
      return { name, state, status, image };
    }),
    listening: (l.get("listen") ?? []).map((p) => {
      const [proto = "", address = "", process = ""] = p.split("|");
      return { proto, address, process };
    }),
    ufw: one(l, "ufw"),
    fail2ban: (l.get("f2b") ?? []).map((f) => {
      const [jail = "", banned = "0", total = "0"] = f.split("|");
      return { jail, banned: Number(banned) || 0, total: Number(total) || 0 };
    }),
    sshFailures24h: num(l, "ssh_failures_24h"),
    sshd: {
      permitRootLogin: one(l, "sshd_permitrootlogin"),
      passwordAuthentication: one(l, "sshd_passwordauthentication"),
    },
  };
}

// ---- Findings ---------------------------------------------------------------

export type FindingSeverity = "critical" | "warning" | "info";
export interface Finding {
  key: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
}

// Ports that should never answer on a public interface.
const DATABASE_PORTS = new Set(["5432", "3306", "6379", "27017", "9200", "5984"]);

function isPublicBind(address: string): boolean {
  const host = address.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  return host === "0.0.0.0" || host === "*" || host === "::" || host === "";
}

export function findings(s: ServerStats, now = new Date()): Finding[] {
  const out: Finding[] = [];
  const add = (key: string, severity: FindingSeverity, title: string, detail: string) =>
    out.push({ key, severity, title, detail });

  if (s.securityUpdates > 0) {
    add(
      "security_updates",
      "critical",
      `${s.securityUpdates} security update${s.securityUpdates === 1 ? "" : "s"} pending`,
      "Run Upgrade, or let unattended-upgrades pick them up on its next run.",
    );
  } else if (s.pendingUpdates > 0) {
    add("updates", "info", `${s.pendingUpdates} non-security update${s.pendingUpdates === 1 ? "" : "s"} pending`, "Safe to batch into a routine upgrade.");
  }

  // The PCI lesson: installed isn't applied. A kernel on disk newer than the
  // running one means fixes are sitting inert until a reboot.
  if (s.kernelLatest && s.kernelRunning && s.kernelLatest !== s.kernelRunning) {
    add(
      "kernel_outdated",
      "critical",
      "Running an older kernel than the one installed",
      `Running ${s.kernelRunning}; ${s.kernelLatest} is installed. Patches in it aren't active until a reboot.`,
    );
  } else if (s.rebootRequired) {
    add(
      "reboot_required",
      "critical",
      "Reboot required",
      s.rebootPackages.length ? `To activate: ${s.rebootPackages.join(", ")}.` : "Installed updates need a reboot to take effect.",
    );
  }

  const heldBehind = s.held.filter((h) => h.upgradeAvailable);
  if (heldBehind.length) {
    const docker = heldBehind.every((h) => /^(docker|containerd)/.test(h.name));
    add(
      "held_packages",
      docker ? "warning" : "critical",
      `${heldBehind.length} held package${heldBehind.length === 1 ? "" : "s"} with an update waiting`,
      `${heldBehind.map((h) => `${h.name} ${h.installed} → ${h.candidate}`).join(", ")}. Held packages don't count as pending updates, so ordinary patch checks miss them.`,
    );
  }

  // The bootstrap only changes patch settings on managed servers.
  const fixHint =
    s.mode === "read-only"
      ? "This server is read-only in the workspace, so change it on the server by hand."
      : "Set a maintenance window and re-run the bootstrap script.";
  if (!s.unattended.enabled) {
    add("unattended_off", "critical", "Automatic security updates are off", `unattended-upgrades isn't enabled. ${fixHint}`);
  } else if (!s.unattended.autoReboot) {
    add(
      "autoreboot_off",
      "warning",
      "Security patches install but never activate on their own",
      `Automatic reboot is off, so kernel and libc fixes wait for a manual reboot. ${fixHint}`,
    );
  }

  if (s.aptListsUpdatedAt) {
    const ageDays = (now.getTime() - new Date(s.aptListsUpdatedAt).getTime()) / 86_400_000;
    if (ageDays > 3) {
      add("apt_stale", "warning", "Package lists are stale", `Last refreshed ${Math.floor(ageDays)} days ago, so pending-update counts may be understated.`);
    }
  }

  for (const d of s.disks) {
    if (d.usedPct >= 95) add(`disk:${d.mount}`, "critical", `Disk ${d.mount} is ${d.usedPct}% full`, "Services fail and Postgres stops accepting writes when a disk fills.");
    else if (d.usedPct >= 85) add(`disk:${d.mount}`, "warning", `Disk ${d.mount} is ${d.usedPct}% full`, "Prune old Docker images and logs before it fills.");
  }
  if (s.memory.usedPct >= 92) add("memory", "warning", `Memory ${s.memory.usedPct}% used`, "Close to running out; the kernel will start killing processes.");
  if (s.cpuCount > 0 && s.load[1] > s.cpuCount * 1.5) {
    add("load", "warning", "Sustained high load", `5-minute load ${s.load[1]} on ${s.cpuCount} CPU${s.cpuCount === 1 ? "" : "s"}.`);
  }

  if (s.failedUnits.length) add("failed_units", "warning", `${s.failedUnits.length} failed service${s.failedUnits.length === 1 ? "" : "s"}`, s.failedUnits.join(", "));

  const exposedDb = s.listening.filter((p) => {
    const port = p.address.match(/:(\d+)$/)?.[1] ?? "";
    return DATABASE_PORTS.has(port) && isPublicBind(p.address);
  });
  if (exposedDb.length) {
    add(
      "db_exposed",
      "critical",
      "Database port listening on all interfaces",
      `${exposedDb.map((p) => `${p.address} (${p.process || "unknown"})`).join(", ")}. Docker-published ports bypass UFW, so a firewall rule alone may not be protecting it.`,
    );
  }

  if (s.ufw && s.ufw !== "active") add("ufw", "warning", "Firewall (UFW) is not active", `UFW reports "${s.ufw}".`);
  if (s.sshd.permitRootLogin === "yes") add("ssh_root", "warning", "SSH allows root login", "Set PermitRootLogin no (or prohibit-password).");
  if (s.sshd.passwordAuthentication === "yes") add("ssh_password", "warning", "SSH accepts passwords", "Key-only login removes the brute-force surface.");
  if (s.sshFailures24h >= 500) add("ssh_failures", "info", `${s.sshFailures24h} failed SSH logins in 24h`, "Normal background noise for a public IP, but check fail2ban is banning.");

  const order: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---- Jobs ---------------------------------------------------------------------

export interface JobStatus {
  state: "none" | "running" | "finished" | "lost";
  kind: string;
  started: string;
  exitCode: number | null;
  result: string;
  log: string;
}

export function parseJobStatus(text: string): JobStatus {
  // Sections are delimited by marker lines; either may be empty or absent.
  const lines = text.split("\n");
  const ri = lines.indexOf("@@result");
  const li = lines.indexOf("@@log");
  const head = lines.slice(0, ri >= 0 ? ri : li >= 0 ? li : lines.length).join("\n");
  const result = ri >= 0 ? lines.slice(ri + 1, li >= 0 ? li : undefined).join("\n") : "";
  const log = li >= 0 ? lines.slice(li + 1).join("\n") : "";
  const l = toLines(head);
  const state = one(l, "state") as JobStatus["state"];
  const exit = one(l, "exit");
  return {
    state: state || "none",
    kind: one(l, "kind"),
    started: one(l, "started"),
    exitCode: exit === "" ? null : Number(exit),
    result,
    log,
  };
}

export interface ScanResult {
  hardeningIndex: number | null;
  lynisVersion: string;
  lynisMissing: boolean;
  warnings: { id: string; text: string; detail: string }[];
  suggestions: { id: string; text: string; detail: string }[];
}

// Lynis report entries look like "TEST-ID|message|details|solution|".
function lynisEntry(raw: string) {
  const [id = "", text = "", detail = ""] = raw.split("|");
  return { id, text, detail: detail === "-" ? "" : detail };
}

export function parseScanResult(text: string): ScanResult {
  const l = toLines(text);
  const hi = one(l, "hardening_index");
  return {
    hardeningIndex: /^\d+$/.test(hi) ? Number(hi) : null,
    lynisVersion: one(l, "lynis_version"),
    lynisMissing: one(l, "lynis_missing") === "1",
    warnings: (l.get("warning") ?? []).map(lynisEntry),
    suggestions: (l.get("suggestion") ?? []).map(lynisEntry),
  };
}
