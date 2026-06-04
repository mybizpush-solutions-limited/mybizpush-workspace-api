import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Team roles added by executive admins beyond the built-in ROLES list. The
// effective catalog everyone picks from is ROLES + the rows here.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("custom_roles", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING, allowNull: false, unique: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("custom_roles");
};
