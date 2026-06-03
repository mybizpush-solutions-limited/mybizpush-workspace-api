import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Profile images for projects and departments (Cloudinary URLs).
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(qi.addColumn("projects", "avatar_url", { type: DataTypes.STRING, allowNull: true }));
  await ignoreDuplicate(qi.addColumn("departments", "avatar_url", { type: DataTypes.STRING, allowNull: true }));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.removeColumn("projects", "avatar_url");
  await qi.removeColumn("departments", "avatar_url");
};
