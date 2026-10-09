import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// The server console: every VPS we run, which projects live on it, its health
// snapshots, and the jobs (update / upgrade / scan / reboot) run against it.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("servers", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING, allowNull: false },
      host: { type: DataTypes.STRING, allowNull: false },
      port: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 22 },
      username: { type: DataTypes.STRING, allowNull: false, defaultValue: "mbp-ops" },
      // Pinned on first successful connect; a later mismatch refuses to connect.
      host_key_fingerprint: { type: DataTypes.STRING, allowNull: true },
      // "read-only": stats and scans only — no update, upgrade or reboot.
      mode: { type: DataTypes.STRING, allowNull: false, defaultValue: "managed" },
      provider: { type: DataTypes.STRING, allowNull: false, defaultValue: "" },
      notes: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      // Window (UTC) when the server may auto-reboot for security patches. No
      // job starts inside it, manual or scheduled.
      maintenance_start: { type: DataTypes.STRING(5), allowNull: true },
      maintenance_minutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
      auto_upgrade: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      auto_upgrade_day: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      auto_upgrade_hour: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      next_auto_upgrade_at: { type: DataTypes.DATE, allowNull: true },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: "unknown" },
      last_error: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      last_seen_at: { type: DataTypes.DATE, allowNull: true },
      last_stats_at: { type: DataTypes.DATE, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("servers", ["host", "port"], { unique: true }));

  await ignoreDuplicate(
    qi.createTable("server_projects", {
      server_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: "servers", key: "id" },
        onDelete: "CASCADE",
      },
      project_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: "projects", key: "id" },
        onDelete: "CASCADE",
      },
    }),
  );
  await ignoreDuplicate(
    qi.addConstraint("server_projects", {
      fields: ["server_id", "project_id"],
      type: "primary key",
      name: "server_projects_pkey",
    }),
  );

  await ignoreDuplicate(
    qi.createTable("server_snapshots", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      server_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: "servers", key: "id" },
        onDelete: "CASCADE",
      },
      collected_at: { type: DataTypes.DATE, allowNull: false },
      // Headline numbers as columns, for trend charts without unpacking JSON.
      pending_updates: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      security_updates: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      reboot_required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      load1: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
      mem_used_pct: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
      disk_used_pct: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
      data: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    }),
  );
  await ignoreDuplicate(qi.addIndex("server_snapshots", ["server_id", "collected_at"]));

  await ignoreDuplicate(
    qi.createTable("server_jobs", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      server_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: "servers", key: "id" },
        onDelete: "CASCADE",
      },
      kind: { type: DataTypes.STRING, allowNull: false },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: "running" },
      trigger: { type: DataTypes.STRING, allowNull: false, defaultValue: "manual" },
      triggered_by_id: { type: DataTypes.UUID, allowNull: true },
      // The server's own start stamp, so a status poll can tell this job's
      // output from a newer job's.
      remote_started: { type: DataTypes.STRING, allowNull: true },
      started_at: { type: DataTypes.DATE, allowNull: false },
      finished_at: { type: DataTypes.DATE, allowNull: true },
      exit_code: { type: DataTypes.INTEGER, allowNull: true },
      log: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      result: { type: DataTypes.JSONB, allowNull: true },
      error: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("server_jobs", ["server_id", "started_at"]));
  await ignoreDuplicate(qi.addIndex("server_jobs", ["status"]));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("server_jobs");
  await qi.dropTable("server_snapshots");
  await qi.dropTable("server_projects");
  await qi.dropTable("servers");
};
