import { Op } from "sequelize";
import { env } from "../../config/env";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { assertCanManageServers, type Auth } from "../../lib/permissions";
import { isSshConfigured, runRemote, workspacePublicKey } from "../../lib/ssh";
import {
  MUTATING_JOB_KINDS,
  Project,
  Server,
  ServerJob,
  ServerSnapshot,
  User,
  type ServerJobKind,
  type ServerMode,
} from "../../models";
import { bootstrapScript } from "./bootstrap";
import {
  findings,
  parseJobStatus,
  parseScanResult,
  parseStats,
  type Finding,
  type ScanResult,
  type ServerStats,
} from "./parse";

// ---- Serialization ------------------------------------------------------------

export interface SerializedJob {
  id: string;
  serverId: string;
  kind: ServerJobKind;
  status: string;
  trigger: string;
  triggeredBy: { id: string; name: string } | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  error: string;
  /** Only on the single-job read; lists leave it off. */
  log?: string;
  result: Record<string, unknown> | null;
}

export interface SerializedServer {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  hostKeyFingerprint: string | null;
  mode: ServerMode;
  provider: string;
  notes: string;
  maintenanceStart: string | null;
  maintenanceMinutes: number;
  inMaintenanceWindow: boolean;
  autoUpgrade: boolean;
  autoUpgradeDay: number;
  autoUpgradeHour: number;
  nextAutoUpgradeAt: string | null;
  status: string;
  lastError: string;
  lastSeenAt: string | null;
  lastStatsAt: string | null;
  projects: { id: string; name: string }[];
  stats: ServerStats | null;
  findings: Finding[];
  runningJob: SerializedJob | null;
  lastScan: (SerializedJob & { scan: ScanResult | null }) | null;
  createdAt: string;
}

function serializeJob(job: ServerJob, withLog = false): SerializedJob {
  const by = job.get("triggeredBy") as User | undefined;
  return {
    id: job.id,
    serverId: job.serverId,
    kind: job.kind,
    status: job.status,
    trigger: job.trigger,
    triggeredBy: by ? { id: by.id, name: by.name } : null,
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    exitCode: job.exitCode,
    error: job.error,
    ...(withLog ? { log: job.log } : {}),
    result: job.result ?? null,
  };
}

const withTriggeredBy = { model: User, as: "triggeredBy", attributes: ["id", "name"] };

// ---- Windows and schedules --------------------------------------------------------

function minutesOfDay(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

// The auto-reboot window, in UTC. Spans midnight correctly (e.g. 23:30 + 90).
export function inMaintenanceWindow(server: Pick<Server, "maintenanceStart" | "maintenanceMinutes">, now = new Date()): boolean {
  if (!server.maintenanceStart) return false;
  const start = minutesOfDay(server.maintenanceStart);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const since = (nowMin - start + 1440) % 1440;
  return since < server.maintenanceMinutes;
}

// Next weekly slot (UTC) at autoUpgradeDay/autoUpgradeHour strictly after `from`.
export function nextAutoUpgrade(server: Pick<Server, "autoUpgradeDay" | "autoUpgradeHour">, from = new Date()): Date {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), server.autoUpgradeHour, 0, 0));
  const dayDiff = (server.autoUpgradeDay - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + dayDiff);
  if (next <= from) next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

function assertScheduleClearOfWindow(server: Server): void {
  if (!server.autoUpgrade || !server.maintenanceStart) return;
  const probe = new Date(Date.UTC(2026, 0, 4 + server.autoUpgradeDay, server.autoUpgradeHour, 0));
  for (let m = 0; m < 60; m += 5) {
    if (inMaintenanceWindow(server, new Date(probe.getTime() + m * 60_000))) {
      throw badRequest("The automatic upgrade hour overlaps the maintenance window. Pick another hour.");
    }
  }
}

// ---- Loading ---------------------------------------------------------------------

async function loadServer(id: string, auth: Auth): Promise<Server> {
  await assertCanManageServers(auth);
  const server = await Server.findByPk(id, {
    include: [{ model: Project, as: "projects", attributes: ["id", "name"], through: { attributes: [] } }],
  });
  if (!server) throw notFound("Server not found");
  return server;
}

async function decorate(servers: Server[], full: boolean): Promise<SerializedServer[]> {
  if (servers.length === 0) return [];
  const ids = servers.map((s) => s.id);

  const pairs = servers.filter((s) => s.lastStatsAt).map((s) => ({ serverId: s.id, collectedAt: s.lastStatsAt! }));
  const snapshots = pairs.length ? await ServerSnapshot.findAll({ where: { [Op.or]: pairs } }) : [];
  const snapshotBy = new Map(snapshots.map((s) => [s.serverId, s]));

  const running = await ServerJob.findAll({ where: { serverId: ids, status: "running" }, include: [withTriggeredBy] });
  const runningBy = new Map(running.map((j) => [j.serverId, j]));

  // Latest finished scan per server. Few servers, so one small query each.
  const scans = await Promise.all(
    ids.map((serverId) =>
      ServerJob.findOne({
        where: { serverId, kind: "scan", status: "succeeded" },
        order: [["startedAt", "DESC"]],
        include: [withTriggeredBy],
      }),
    ),
  );
  const scanBy = new Map(scans.filter(Boolean).map((j) => [j!.serverId, j!]));

  const now = new Date();
  return servers.map((s) => {
    const snap = snapshotBy.get(s.id);
    const stats = snap ? (snap.data as unknown as ServerStats) : null;
    const scan = scanBy.get(s.id);
    const projects = (s.get("projects") as Project[] | undefined) ?? [];
    return {
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port,
      username: s.username,
      hostKeyFingerprint: s.hostKeyFingerprint,
      mode: s.mode,
      provider: s.provider,
      notes: s.notes,
      maintenanceStart: s.maintenanceStart,
      maintenanceMinutes: s.maintenanceMinutes,
      inMaintenanceWindow: inMaintenanceWindow(s, now),
      autoUpgrade: s.autoUpgrade,
      autoUpgradeDay: s.autoUpgradeDay,
      autoUpgradeHour: s.autoUpgradeHour,
      nextAutoUpgradeAt: s.nextAutoUpgradeAt?.toISOString() ?? null,
      status: s.status,
      lastError: s.lastError,
      lastSeenAt: s.lastSeenAt?.toISOString() ?? null,
      lastStatsAt: s.lastStatsAt?.toISOString() ?? null,
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
      // The list view only needs the headline numbers; trim the long lists.
      stats: stats && !full ? { ...stats, upgradable: [], listening: [] } : stats,
      findings: stats ? findings(stats, now) : [],
      runningJob: runningBy.get(s.id) ? serializeJob(runningBy.get(s.id)!) : null,
      lastScan: scan
        ? { ...serializeJob(scan), scan: full ? parseScanResult(String((scan.result as { raw?: string } | null)?.raw ?? "")) : null }
        : null,
      createdAt: s.createdAt.toISOString(),
    };
  });
}

// ---- Remote operations ---------------------------------------------------------------

const target = (s: Server) => ({
  host: s.host,
  port: s.port,
  username: s.username,
  hostKeyFingerprint: s.hostKeyFingerprint,
});

// Pin the host key the first time a server answers.
async function pinHostKey(server: Server, presented: string): Promise<void> {
  if (!server.hostKeyFingerprint && presented) server.hostKeyFingerprint = presented;
}

// Read the server's health and patch state and store a snapshot. Never throws
// for an unreachable server — that's recorded as its status instead.
export async function collectStats(server: Server): Promise<ServerSnapshot | null> {
  const now = new Date();
  try {
    const res = await runRemote(target(server), "stats");
    if (res.code !== 0 || !res.stdout.includes("mbp_version=")) {
      throw new Error(res.stderr.trim() || `stats exited with code ${res.code}`);
    }
    const stats = parseStats(res.stdout, now);
    const rootDisk = stats.disks.find((d) => d.mount === "/");
    const snapshot = await ServerSnapshot.create({
      serverId: server.id,
      collectedAt: now,
      pendingUpdates: stats.pendingUpdates,
      securityUpdates: stats.securityUpdates,
      rebootRequired: stats.rebootRequired || (stats.kernelLatest !== stats.kernelRunning && !!stats.kernelLatest),
      load1: stats.load[0],
      memUsedPct: stats.memory.usedPct,
      diskUsedPct: Math.max(rootDisk?.usedPct ?? 0, ...stats.disks.map((d) => d.usedPct)),
      data: stats as unknown as Record<string, unknown>,
    });
    await pinHostKey(server, res.hostKeyFingerprint);
    server.status = "ok";
    server.lastError = "";
    server.lastSeenAt = now;
    server.lastStatsAt = now;
    await server.save();
    return snapshot;
  } catch (err) {
    server.status = "error";
    server.lastError = (err as Error).message;
    await server.save();
    return null;
  }
}

const VERB: Record<ServerJobKind, string> = {
  update: "update",
  upgrade: "upgrade",
  upgrade_docker: "upgrade-docker",
  reboot: "reboot",
  scan: "scan",
};

export async function startJob(
  server: Server,
  kind: ServerJobKind,
  trigger: "manual" | "scheduled",
  userId: string | null,
): Promise<ServerJob> {
  if (server.mode === "read-only" && MUTATING_JOB_KINDS.includes(kind)) {
    throw forbidden(`${server.name} is read-only in the workspace: it can be monitored and scanned, not changed`);
  }
  if (inMaintenanceWindow(server)) {
    throw conflict(`${server.name} is inside its maintenance window (automatic security reboots). Try again after it closes.`);
  }
  const busy = await ServerJob.findOne({ where: { serverId: server.id, status: "running" } });
  if (busy) throw conflict(`A ${busy.kind.replace("_", " ")} is already running on ${server.name}`);

  const res = await runRemote(target(server), VERB[kind]);
  const started = res.stdout.match(/started=(\d+)/)?.[1];
  if (!started) {
    const other = res.stdout.match(/busy=(\S*)/)?.[1];
    if (other !== undefined) throw conflict(`${server.name} is already running a ${other || "job"} started outside the workspace`);
    throw badRequest(`${server.name} refused the job: ${(res.stderr || res.stdout).trim() || `exit ${res.code}`}`);
  }
  await pinHostKey(server, res.hostKeyFingerprint);
  server.lastSeenAt = new Date();
  await server.save();

  const job = await ServerJob.create({
    serverId: server.id,
    kind,
    trigger,
    triggeredById: userId,
    remoteStarted: started,
    startedAt: new Date(),
  });
  console.info(`[servers] ${kind} started on ${server.name} (${trigger}${userId ? ` by ${userId}` : ""})`);
  return job;
}

// How long an unreachable running job is given before it's written off.
const LOST_AFTER_MS = 3 * 60 * 60 * 1000;

export async function pollJob(job: ServerJob): Promise<ServerJob> {
  const server = await Server.findByPk(job.serverId);
  if (!server) {
    await job.destroy();
    return job;
  }
  let status;
  try {
    const res = await runRemote(target(server), "job-status");
    status = parseJobStatus(res.stdout);
  } catch (err) {
    // A rebooting server is briefly unreachable; only give up after a while.
    if (Date.now() - job.startedAt.getTime() > LOST_AFTER_MS) {
      job.status = "lost";
      job.error = `Server unreachable: ${(err as Error).message}`;
      job.finishedAt = new Date();
      await job.save();
    }
    return job;
  }

  if (status.started !== job.remoteStarted) {
    job.status = "lost";
    job.error = "Another job replaced this one on the server before it was read back.";
    job.finishedAt = new Date();
    await job.save();
    return job;
  }

  job.log = status.log;
  if (status.state === "finished" || status.state === "lost") {
    job.exitCode = status.exitCode;
    job.status = status.state === "lost" ? "lost" : status.exitCode === 0 ? "succeeded" : "failed";
    if (status.state === "lost") job.error = "The job stopped without recording an exit code (killed or the server rebooted).";
    job.finishedAt = new Date();
    // Keep the raw text; parsing happens on read so parser fixes apply retroactively.
    if (status.result) job.result = { raw: status.result };
    await job.save();
    // Package state just changed; refresh the snapshot rather than waiting.
    if (job.kind !== "reboot") void collectStats(server);
  } else {
    await job.save();
  }
  return job;
}

// ---- Service API --------------------------------------------------------------------

export interface ServerInput {
  name: string;
  host: string;
  port?: number;
  mode?: ServerMode;
  provider?: string;
  notes?: string;
  maintenanceStart?: string | null;
  maintenanceMinutes?: number;
  autoUpgrade?: boolean;
  autoUpgradeDay?: number;
  autoUpgradeHour?: number;
  projectIds?: string[];
}

async function setProjects(server: Server, projectIds: string[] | undefined): Promise<void> {
  if (!projectIds) return;
  const projects = await Project.findAll({ where: { id: projectIds } });
  await (server as unknown as { setProjects(p: Project[]): Promise<void> }).setProjects(projects);
}

export const serversService = {
  async config(auth: Auth) {
    await assertCanManageServers(auth);
    let publicKey: string | null = null;
    let keyError = "";
    try {
      publicKey = workspacePublicKey();
    } catch (err) {
      keyError = (err as Error).message;
    }
    return {
      sshConfigured: isSshConfigured(),
      publicKey,
      keyError,
      sourceIp: env.SERVER_SSH_SOURCE_IP,
      statsIntervalMinutes: env.SERVER_STATS_INTERVAL_MINUTES,
      scanHourUtc: env.SERVER_SCAN_HOUR_UTC,
    };
  },

  async list(auth: Auth): Promise<SerializedServer[]> {
    await assertCanManageServers(auth);
    const servers = await Server.findAll({
      order: [["name", "ASC"]],
      include: [{ model: Project, as: "projects", attributes: ["id", "name"], through: { attributes: [] } }],
    });
    return decorate(servers, false);
  },

  async get(id: string, auth: Auth): Promise<SerializedServer> {
    return (await decorate([await loadServer(id, auth)], true))[0]!;
  },

  async create(input: ServerInput, auth: Auth): Promise<SerializedServer> {
    await assertCanManageServers(auth);
    const port = input.port ?? 22;
    if (await Server.findOne({ where: { host: input.host, port } })) {
      throw conflict(`${input.host}:${port} is already in the console`);
    }
    const server = Server.build({
      name: input.name,
      host: input.host,
      port,
      mode: input.mode ?? "managed",
      provider: input.provider ?? "",
      notes: input.notes ?? "",
      maintenanceStart: input.maintenanceStart ?? null,
      maintenanceMinutes: input.maintenanceMinutes ?? 60,
      autoUpgrade: input.autoUpgrade ?? false,
      autoUpgradeDay: input.autoUpgradeDay ?? 0,
      autoUpgradeHour: input.autoUpgradeHour ?? 1,
      createdBy: auth.sub,
    });
    if (server.mode === "read-only") server.autoUpgrade = false;
    assertScheduleClearOfWindow(server);
    server.nextAutoUpgradeAt = server.autoUpgrade ? nextAutoUpgrade(server) : null;
    await server.save();
    await setProjects(server, input.projectIds);
    return this.get(server.id, auth);
  },

  async update(id: string, patch: Partial<ServerInput>, auth: Auth): Promise<SerializedServer> {
    const server = await loadServer(id, auth);
    const hostChanged = (patch.host && patch.host !== server.host) || (patch.port && patch.port !== server.port);
    Object.assign(server, {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.host !== undefined && { host: patch.host }),
      ...(patch.port !== undefined && { port: patch.port }),
      ...(patch.mode !== undefined && { mode: patch.mode }),
      ...(patch.provider !== undefined && { provider: patch.provider }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
      ...(patch.maintenanceStart !== undefined && { maintenanceStart: patch.maintenanceStart }),
      ...(patch.maintenanceMinutes !== undefined && { maintenanceMinutes: patch.maintenanceMinutes }),
      ...(patch.autoUpgrade !== undefined && { autoUpgrade: patch.autoUpgrade }),
      ...(patch.autoUpgradeDay !== undefined && { autoUpgradeDay: patch.autoUpgradeDay }),
      ...(patch.autoUpgradeHour !== undefined && { autoUpgradeHour: patch.autoUpgradeHour }),
    });
    // A different address is a different machine until it proves otherwise.
    if (hostChanged) server.hostKeyFingerprint = null;
    if (server.mode === "read-only") server.autoUpgrade = false;
    assertScheduleClearOfWindow(server);
    server.nextAutoUpgradeAt = server.autoUpgrade ? nextAutoUpgrade(server) : null;
    await server.save();
    await setProjects(server, patch.projectIds);
    return this.get(server.id, auth);
  },

  async remove(id: string, auth: Auth): Promise<void> {
    const server = await loadServer(id, auth);
    await server.destroy();
  },

  // Forget the pinned host key (after a rebuild). The next connect pins anew.
  async retrust(id: string, auth: Auth): Promise<SerializedServer> {
    const server = await loadServer(id, auth);
    server.hostKeyFingerprint = null;
    await server.save();
    return this.get(id, auth);
  },

  async bootstrap(id: string, auth: Auth): Promise<{ fileName: string; script: string }> {
    const server = await loadServer(id, auth);
    const publicKey = workspacePublicKey();
    if (!publicKey) throw badRequest("Set SERVER_SSH_PRIVATE_KEY on the API first; the script embeds its public half");
    if (!env.SERVER_SSH_SOURCE_IP) throw badRequest("Set SERVER_SSH_SOURCE_IP on the API first (the central VPS's public IP)");
    return {
      fileName: "mbp-bootstrap.sh",
      script: bootstrapScript({
        serverName: server.name,
        mode: server.mode,
        rebootTime: server.maintenanceStart ?? "",
        sourceIp: env.SERVER_SSH_SOURCE_IP,
        publicKey,
      }),
    };
  },

  // Connect now and take a snapshot. Also how a new server's host key is pinned.
  async refresh(id: string, auth: Auth): Promise<SerializedServer> {
    const server = await loadServer(id, auth);
    await collectStats(server);
    return this.get(id, auth);
  },

  async runJob(id: string, kind: ServerJobKind, auth: Auth): Promise<SerializedJob> {
    const server = await loadServer(id, auth);
    const job = await startJob(server, kind, "manual", auth.sub);
    return serializeJob((await ServerJob.findByPk(job.id, { include: [withTriggeredBy] }))!);
  },

  async jobs(id: string, auth: Auth, limit = 50): Promise<SerializedJob[]> {
    await loadServer(id, auth);
    const jobs = await ServerJob.findAll({
      where: { serverId: id },
      order: [["startedAt", "DESC"]],
      limit,
      include: [withTriggeredBy],
    });
    return jobs.map((j) => serializeJob(j));
  },

  // A running job is polled on read too, so the UI's live log doesn't wait for
  // the scheduler tick.
  async job(jobId: string, auth: Auth): Promise<SerializedJob & { scan: ScanResult | null }> {
    await assertCanManageServers(auth);
    let job = await ServerJob.findByPk(jobId, { include: [withTriggeredBy] });
    if (!job) throw notFound("Job not found");
    if (job.status === "running") {
      await pollJob(job);
      job = (await ServerJob.findByPk(jobId, { include: [withTriggeredBy] }))!;
    }
    const raw = (job.result as { raw?: string } | null)?.raw;
    return { ...serializeJob(job, true), scan: job.kind === "scan" && raw ? parseScanResult(raw) : null };
  },

  // Headline numbers over time, for the trend charts.
  async history(id: string, auth: Auth, hours = 48) {
    await loadServer(id, auth);
    const since = new Date(Date.now() - hours * 3_600_000);
    const rows = await ServerSnapshot.findAll({
      where: { serverId: id, collectedAt: { [Op.gte]: since } },
      attributes: ["collectedAt", "load1", "memUsedPct", "diskUsedPct", "pendingUpdates", "securityUpdates"],
      order: [["collectedAt", "ASC"]],
    });
    return rows.map((r) => ({
      at: r.collectedAt.toISOString(),
      load1: r.load1,
      memUsedPct: r.memUsedPct,
      diskUsedPct: r.diskUsedPct,
      pendingUpdates: r.pendingUpdates,
      securityUpdates: r.securityUpdates,
    }));
  },
};
