import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Generated report snapshots — currently the letterheaded staff monthly report
// PDFs. The PDF itself is uploaded to Cloudinary; this row carries the
// metadata/provenance (who it is about, which month, who generated it) so
// saved reports can be listed, re-downloaded and audited per project.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("reports", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      project_id: { type: DataTypes.UUID, allowNull: false },
      // The staff member the report is about.
      user_id: { type: DataTypes.UUID, allowNull: false },
      // Calendar month the report covers, "YYYY-MM" (e.g. "2026-09").
      month: { type: DataTypes.STRING(7), allowNull: false },
      // Report flavor — "staff" for now; future kinds (lane/department) reuse
      // this table.
      kind: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "staff" },

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
  await ignoreDuplicate(qi.addIndex("reports", ["project_id", "month"]));
  await ignoreDuplicate(qi.addIndex("reports", ["user_id", "month"]));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("reports");
};