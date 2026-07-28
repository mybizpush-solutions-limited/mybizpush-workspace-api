import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// First-party website analytics. `analytics_sites` are the tracked properties
// (one per website, optionally tied to a project); `analytics_events` is the raw
// hit log written by the public collector; `analytics_daily` is the pre-rolled
// per-day/per-path aggregate the dashboards read so they never scan raw events.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("analytics_sites", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      project_id: { type: DataTypes.UUID, allowNull: true },
      name: { type: DataTypes.STRING, allowNull: false },
      domain: { type: DataTypes.STRING, allowNull: false },
      // The value pasted into the tracking snippet's data-site attribute.
      public_key: { type: DataTypes.STRING(32), allowNull: false, unique: true },
      // Hostnames allowed to report. Empty = accept any origin (useful while
      // setting a site up, or for sites behind previews with rotating domains).
      allowed_origins: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        allowNull: false,
        defaultValue: [],
      },
      created_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );

  await ignoreDuplicate(
    qi.createTable("analytics_events", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      site_id: { type: DataTypes.UUID, allowNull: false },
      ts: { type: DataTypes.DATE, allowNull: false },
      kind: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "pageview" },
      // Custom-event name; empty for pageviews.
      name: { type: DataTypes.STRING(80), allowNull: false, defaultValue: "" },
      path: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "/" },
      referrer_host: { type: DataTypes.STRING(255), allowNull: false, defaultValue: "" },
      referrer_path: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
      utm_source: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "" },
      utm_medium: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "" },
      utm_campaign: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "" },
      country: { type: DataTypes.STRING(2), allowNull: false, defaultValue: "" },
      device_type: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "" },
      browser: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "" },
      os: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "" },
      // Salted daily hash of site + IP + user-agent. No cookies, no raw IP.
      visitor_hash: { type: DataTypes.STRING(64), allowNull: false },
      session_id: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "" },
      duration_ms: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("analytics_events", ["site_id", "ts"]));
  await ignoreDuplicate(qi.addIndex("analytics_events", ["site_id", "path", "ts"]));
  await ignoreDuplicate(qi.addIndex("analytics_events", ["site_id", "visitor_hash", "ts"]));

  await ignoreDuplicate(
    qi.createTable("analytics_daily", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      site_id: { type: DataTypes.UUID, allowNull: false },
      day: { type: DataTypes.DATEONLY, allowNull: false },
      path: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "/" },
      pageviews: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      visitors: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      sessions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(
    qi.addIndex("analytics_daily", ["site_id", "day", "path"], {
      unique: true,
      name: "analytics_daily_site_day_path",
    }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("analytics_daily");
  await qi.dropTable("analytics_events");
  await qi.dropTable("analytics_sites");
};
