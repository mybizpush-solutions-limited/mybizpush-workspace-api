import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Managed Postgres databases per project, plus their backup history and backup
// schedules. A project routinely runs several (app, analytics, staging), so
// this is a one-to-many off projects rather than a column on the project.
//
// The only secret here is `connection_string`, stored AES-256-GCM encrypted
// (see lib/crypto.ts). Everything else on project_databases is derived from it
// so the console can show host/database/user without ever decrypting.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("project_databases", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      project_id: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING(160), allowNull: false },
      // Free-form-ish label ("production", "staging", …) used for the badge and
      // for the extra confirmation before destructive actions on production.
      environment: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "development" },
      // Where it's hosted ("neon", "supabase", "railway", …) — display only.
      provider: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "" },

      connection_string: { type: DataTypes.TEXT, allowNull: false },
      // Derived, non-secret projection of the connection string.
      host: { type: DataTypes.STRING(255), allowNull: false, defaultValue: "" },
      port: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5432 },
      database_name: { type: DataTypes.STRING(255), allowNull: false, defaultValue: "" },
      username: { type: DataTypes.STRING(255), allowNull: false, defaultValue: "" },
      ssl_mode: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "require" },

      // Last connection probe.
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "unknown" },
      last_checked_at: { type: DataTypes.DATE, allowNull: true },
      last_error: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      size_bytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      table_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      server_version: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "" },

      // How many succeeded backups to keep before pruning the oldest.
      retention_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 7 },
      notes: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      created_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("project_databases", ["project_id"]));

  await ignoreDuplicate(
    qi.createTable("database_backups", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      database_id: { type: DataTypes.UUID, allowNull: false },
      // Denormalised so the cross-project console can filter without a join.
      project_id: { type: DataTypes.UUID, allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "running" },
      trigger: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "manual" },
      format: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "custom" },
      // "cloudinary" or "local" — resolved at upload time, since a dump too big
      // for the Cloudinary plan falls back to the local volume.
      storage: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "local" },
      storage_note: { type: DataTypes.STRING(300), allowNull: false, defaultValue: "" },

      file_name: { type: DataTypes.STRING(300), allowNull: false, defaultValue: "" },
      file_size_bytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      checksum: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "" },
      cloudinary_public_id: { type: DataTypes.STRING(400), allowNull: false, defaultValue: "" },
      cloudinary_format: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "" },
      local_path: { type: DataTypes.STRING(700), allowNull: false, defaultValue: "" },

      started_at: { type: DataTypes.DATE, allowNull: false },
      finished_at: { type: DataTypes.DATE, allowNull: true },
      duration_ms: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      error: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      pg_dump_version: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "" },

      created_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("database_backups", ["database_id", "created_at"]));
  await ignoreDuplicate(qi.addIndex("database_backups", ["project_id"]));

  // One schedule per database. Expressed as frequency + wall-clock time in an
  // IANA timezone rather than raw cron: the people setting this up think in
  // "every night at 2am Lagos time", and we can compute next_run_at exactly.
  await ignoreDuplicate(
    qi.createTable("database_backup_schedules", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      database_id: { type: DataTypes.UUID, allowNull: false, unique: true },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      frequency: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "daily" },
      hour: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2 },
      minute: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      day_of_week: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 }, // Mon
      day_of_month: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "Africa/Lagos" },
      format: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "custom" },
      storage_target: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "cloudinary" },
      last_run_at: { type: DataTypes.DATE, allowNull: true },
      next_run_at: { type: DataTypes.DATE, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("database_backup_schedules", ["enabled", "next_run_at"]));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("database_backup_schedules");
  await qi.dropTable("database_backups");
  await qi.dropTable("project_databases");
};
