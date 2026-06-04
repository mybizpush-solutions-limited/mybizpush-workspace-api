import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Add the "chief" access level (ranks between admin and executive_admin).
// Postgres enum value adds are idempotent with IF NOT EXISTS (PG 12+).
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.sequelize.query(
      `ALTER TYPE "enum_users_access_level" ADD VALUE IF NOT EXISTS 'chief' BEFORE 'executive_admin'`,
    ),
  );
};

// Postgres can't drop an enum value cleanly; leave it in place on rollback.
export const down: Migration = async () => {
  /* no-op */
};
