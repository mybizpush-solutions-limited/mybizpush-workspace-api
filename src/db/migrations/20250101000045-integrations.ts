import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Gmail, GitHub on products, and Google Calendar conflicts (A701, A702, A704).
export const up: Migration = async ({ context: qi }) => {
  const stamps = () => ({ created_at: { type: DataTypes.DATE, allowNull: false }, updated_at: { type: DataTypes.DATE, allowNull: false } });

  const google = await qi.describeTable("google_accounts");
  // Mailbox access is a far bigger key than the identity link, so it's held apart
  // and encrypted, and it can be dropped without losing the identity link.
  if (!google.gmail_refresh_token) await qi.addColumn("google_accounts", "gmail_refresh_token", { type: DataTypes.TEXT, allowNull: true });
  if (!google.gmail_email) await qi.addColumn("google_accounts", "gmail_email", { type: DataTypes.STRING, allowNull: true });
  if (!google.gmail_scopes) await qi.addColumn("google_accounts", "gmail_scopes", { type: DataTypes.STRING(500), allowNull: true });

  const meetings = await qi.describeTable("meetings");
  if (!meetings.google_snapshot) await qi.addColumn("meetings", "google_snapshot", { type: DataTypes.JSONB, allowNull: true });
  if (!meetings.sync_conflict) await qi.addColumn("meetings", "sync_conflict", { type: DataTypes.JSONB, allowNull: true });
  // What both sides agree on today, so a later change in Google can be told apart.
  await qi.sequelize.query(
    `UPDATE meetings SET google_snapshot = jsonb_build_object('title', title, 'startsAt', to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'endsAt', to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
      WHERE google_event_id IS NOT NULL AND google_snapshot IS NULL`,
  );

  await ignoreDuplicate(
    qi.createTable("email_thread_links", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      thread_id: { type: DataTypes.STRING(64), allowNull: false },
      record_type: { type: DataTypes.STRING(8), allowNull: false },
      record_id: { type: DataTypes.UUID, allowNull: false },
      subject: { type: DataTypes.STRING(500), allowNull: false, defaultValue: "" },
      snippet: { type: DataTypes.STRING(500), allowNull: false, defaultValue: "" },
      participants: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      message_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      last_message_at: { type: DataTypes.DATE, allowNull: true },
      has_new_reply: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      linked_by: { type: DataTypes.UUID, allowNull: false, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
      last_check_failed_at: { type: DataTypes.DATE, allowNull: true },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("email_thread_links", ["thread_id", "record_type", "record_id", "linked_by"], { name: "email_thread_links_unique", unique: true }));
  await ignoreDuplicate(qi.addIndex("email_thread_links", ["record_type", "record_id"], { name: "email_thread_links_record" }));
  await ignoreDuplicate(qi.addIndex("email_thread_links", ["updated_at"], { name: "email_thread_links_updated_at" }));

  await ignoreDuplicate(
    qi.createTable("product_repos", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      product_id: { type: DataTypes.UUID, allowNull: false, references: { model: "products", key: "id" }, onDelete: "CASCADE" },
      owner: { type: DataTypes.STRING, allowNull: false },
      repo: { type: DataTypes.STRING, allowNull: false },
      full_name: { type: DataTypes.STRING, allowNull: false },
      html_url: { type: DataTypes.STRING, allowNull: true },
      description: { type: DataTypes.TEXT, allowNull: true },
      is_private: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      added_by: { type: DataTypes.UUID, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("product_repos", ["product_id", "full_name"], { name: "product_repos_unique", unique: true }));
  await ignoreDuplicate(qi.addIndex("product_repos", ["updated_at"], { name: "product_repos_updated_at" }));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("product_repos");
  await qi.dropTable("email_thread_links");
  for (const c of ["sync_conflict", "google_snapshot"]) await qi.removeColumn("meetings", c).catch(() => undefined);
  for (const c of ["gmail_scopes", "gmail_email", "gmail_refresh_token"]) await qi.removeColumn("google_accounts", c).catch(() => undefined);
};
