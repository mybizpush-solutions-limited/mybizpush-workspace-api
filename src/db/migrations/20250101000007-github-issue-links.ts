import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Mirror between an app issue and a GitHub issue (two-way sync).
export const up: Migration = async ({ context: qi }) => {
  const now = qi.sequelize.literal("now()");
  await ignoreDuplicate(
    qi.createTable("github_issue_links", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      item_id: { type: DataTypes.UUID, allowNull: false },
      item_type: { type: DataTypes.ENUM("task", "issue"), allowNull: false },
      owner: { type: DataTypes.STRING, allowNull: false },
      repo: { type: DataTypes.STRING, allowNull: false },
      full_name: { type: DataTypes.STRING, allowNull: false },
      number: { type: DataTypes.INTEGER, allowNull: false },
      url: { type: DataTypes.STRING, allowNull: false },
      state: { type: DataTypes.STRING, allowNull: false, defaultValue: "open" },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
    }),
  );
  await ignoreDuplicate(qi.addIndex("github_issue_links", ["item_id"]));
  await ignoreDuplicate(qi.addIndex("github_issue_links", ["url"]));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("github_issue_links");
};
