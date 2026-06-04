import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Emails an executive has banned from signing up again (set when blacklisting a
// user). Plain user-deletion does NOT add a row here, so the email stays reusable.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("blacklisted_emails", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      email: { type: DataTypes.STRING, allowNull: false, unique: true },
      reason: { type: DataTypes.STRING, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("blacklisted_emails");
};
