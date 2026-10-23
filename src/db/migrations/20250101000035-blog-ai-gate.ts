import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// How strict the automated review is before an author may send a post to a
// publisher. The lowest severity that still blocks submission: "low" means any
// finding at all has to be fixed first, "off" turns the gate off.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.addColumn("blog_channels", "ai_gate_severity", {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "low",
    }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.removeColumn("blog_channels", "ai_gate_severity");
};
