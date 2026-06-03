import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Track the GitHub comment id a mirrored comment corresponds to (loop guard).
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.addColumn("comments", "github_comment_id", { type: DataTypes.STRING, allowNull: true }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.removeColumn("comments", "github_comment_id");
};
