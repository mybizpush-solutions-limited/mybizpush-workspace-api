import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Compulsory MFA and the 12-character password policy.
//
// password_meets_policy starts FALSE for everyone. bcrypt can't tell us how
// long or varied an existing password is, so the only moment we can judge it is
// at sign-in, when the plaintext exists; until then every account is treated as
// owing a password change. That is what makes "everyone rotates on their next
// sign-in" work without guessing.
//
// totp_last_step is the most recent 30-second step a code was accepted for —
// codes at or below it are refused, so a code seen over a shoulder or in a log
// can't be replayed inside its validity window.
export const up: Migration = async ({ context: qi }) => {
  const add = (column: string, spec: Parameters<typeof qi.addColumn>[2]) =>
    ignoreDuplicate(qi.addColumn("users", column, spec));

  await add("password_meets_policy", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await add("totp_secret_encrypted", { type: DataTypes.TEXT, allowNull: true });
  await add("totp_enabled", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await add("totp_confirmed_at", { type: DataTypes.DATE, allowNull: true });
  await add("totp_last_step", { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 });

  // Used codes are kept (used_at set) rather than deleted, so there's a record
  // of when an account was entered with a recovery code.
  await ignoreDuplicate(
    qi.createTable("mfa_recovery_codes", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      code_hash: { type: DataTypes.STRING, allowNull: false },
      used_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("mfa_recovery_codes", ["user_id"]));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("mfa_recovery_codes");
  for (const column of [
    "password_meets_policy",
    "totp_secret_encrypted",
    "totp_enabled",
    "totp_confirmed_at",
    "totp_last_step",
  ]) {
    await qi.removeColumn("users", column);
  }
};
