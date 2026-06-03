import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Optional second @domain email (e.g. an executive's role email). Either email
// can be used to sign in; both are shown on the profile.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.addColumn("users", "secondary_email", { type: DataTypes.STRING, allowNull: true, unique: true }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.removeColumn("users", "secondary_email");
};
