import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// A read-only share key lets another one of our apps (e.g. the Hyparrow admin
// dashboard) render a site's numbers without holding a Dev Space session.
// Null = sharing is off, which is the default.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.addColumn("analytics_sites", "share_key", {
      type: DataTypes.STRING(32),
      allowNull: true,
      unique: true,
    }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.removeColumn("analytics_sites", "share_key");
};
