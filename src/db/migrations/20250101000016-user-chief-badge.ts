import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Cosmetic golden "Chief" badge, grantable independently of access level.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.addColumn("users", "chief_badge", {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.removeColumn("users", "chief_badge");
};
