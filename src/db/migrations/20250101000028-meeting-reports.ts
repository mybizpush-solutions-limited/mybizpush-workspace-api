import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Generated meeting reports: an executive admin uploads a meeting transcript
// (.txt/.md) and the report model turns it into a letterheaded, confidential
// meeting report PDF. The PDF is uploaded to Cloudinary; this row carries the
// metadata/provenance so saved reports can be listed and re-opened.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("meeting_reports", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      title: { type: DataTypes.STRING(300), allowNull: false },
      // Free-text meeting date as stated in the transcript ("26 August 2026").
      meeting_date: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "" },
      name: { type: DataTypes.STRING(300), allowNull: false },
      type: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "application/pdf" },
      size: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      url: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      public_id: { type: DataTypes.STRING(400), allowNull: false, defaultValue: "" },
      generated_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("meeting_reports");
};