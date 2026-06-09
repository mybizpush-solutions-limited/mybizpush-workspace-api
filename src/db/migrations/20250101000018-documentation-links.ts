import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Documentation/reference URLs linked to a task or issue (analogous to linked
// pull requests, but just a titled link).
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("documentation_links", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      item_id: { type: DataTypes.UUID, allowNull: false },
      item_type: { type: DataTypes.ENUM("task", "issue"), allowNull: false },
      title: { type: DataTypes.STRING, allowNull: false },
      url: { type: DataTypes.STRING, allowNull: false },
      added_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("documentation_links");
};
