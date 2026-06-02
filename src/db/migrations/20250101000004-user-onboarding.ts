import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Onboarding wizard support: an uploaded avatar and a flag that gates the
// post-signup wizard. New accounts start with onboarded=false and are routed
// through the wizard until they complete it.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.addColumn("users", "avatar_url", { type: DataTypes.STRING, allowNull: true }),
  );
  await ignoreDuplicate(
    qi.addColumn("users", "onboarded", {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    }),
  );
  // Existing seeded users have already "joined" their departments/projects, so
  // treat them as onboarded rather than forcing them back through the wizard.
  await qi.sequelize.query(`UPDATE "users" SET "onboarded" = true`);
};

export const down: Migration = async ({ context: qi }) => {
  await qi.removeColumn("users", "onboarded");
  await qi.removeColumn("users", "avatar_url");
};
