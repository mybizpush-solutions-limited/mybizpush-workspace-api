import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Meeting report generation moved to background: transcripts are stored on the
// row, processed asynchronously (fire-and-forget + a cron sweeper), and the row
// tracks pending/processing/done/failed so the UI can show progress and let
// people come back to the result later.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(qi.addColumn("meeting_reports", "status", {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: "pending",
  }));
  await ignoreDuplicate(qi.addColumn("meeting_reports", "error", {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: "",
  }));
  // The uploaded transcript is kept on the row so processing can happen
  // asynchronously (and be retried) without re-uploading.
  await ignoreDuplicate(qi.addColumn("meeting_reports", "transcript", {
    type: DataTypes.TEXT,
    allowNull: true,
  }));
  await ignoreDuplicate(qi.addColumn("meeting_reports", "source_name", {
    type: DataTypes.STRING(300),
    allowNull: false,
    defaultValue: "",
  }));
  await ignoreDuplicate(qi.addColumn("meeting_reports", "processed_at", {
    type: DataTypes.DATE,
    allowNull: true,
  }));
};

export const down: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(qi.removeColumn("meeting_reports", "status"));
  await ignoreDuplicate(qi.removeColumn("meeting_reports", "error"));
  await ignoreDuplicate(qi.removeColumn("meeting_reports", "transcript"));
  await ignoreDuplicate(qi.removeColumn("meeting_reports", "source_name"));
  await ignoreDuplicate(qi.removeColumn("meeting_reports", "processed_at"));
};