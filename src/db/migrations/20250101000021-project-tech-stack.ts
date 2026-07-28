import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// A short free-text description of what a project is built with. Fed into the
// AI agent-brief prompt so it stops inferring a stack (it was assuming Laravel)
// from nothing but the project name.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.addColumn("projects", "tech_stack", {
      type: DataTypes.STRING(400),
      allowNull: false,
      defaultValue: "",
    }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.removeColumn("projects", "tech_stack");
};
