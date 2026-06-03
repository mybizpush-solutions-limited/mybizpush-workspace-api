import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// CI + review enrichment cached on linked pull requests, refreshed on link and
// via the check_run / pull_request_review webhooks.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(qi.addColumn("pull_requests", "check_state", { type: DataTypes.STRING, allowNull: true }));
  await ignoreDuplicate(qi.addColumn("pull_requests", "review_decision", { type: DataTypes.STRING, allowNull: true }));
  await ignoreDuplicate(qi.addColumn("pull_requests", "head_sha", { type: DataTypes.STRING, allowNull: true }));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.removeColumn("pull_requests", "check_state");
  await qi.removeColumn("pull_requests", "review_decision");
  await qi.removeColumn("pull_requests", "head_sha");
};
