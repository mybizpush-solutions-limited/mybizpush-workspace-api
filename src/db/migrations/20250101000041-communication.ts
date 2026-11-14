import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { addEnumValues, addRolePermissions, ignoreDuplicate } from "../migration-helpers";

// Chat, announcements and notification preferences (API-CHANGES A301 to A305).
export const up: Migration = async ({ context: qi }) => {
  for (const table of ["comments", "attachments", "activity", "notifications"]) {
    await addEnumValues(qi, table, "item_type", ["conversation", "message"]);
  }
  await addEnumValues(qi, "notifications", "kind", ["message", "announcement", "meeting", "query", "target", "appraisal", "campaign", "content", "integration_failure"]);

  const stamps = () => ({ created_at: { type: DataTypes.DATE, allowNull: false }, updated_at: { type: DataTypes.DATE, allowNull: false } });
  const user = () => ({ type: DataTypes.UUID, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" });

  const notifications = await qi.describeTable("notifications");
  if (!notifications.data) await qi.addColumn("notifications", "data", { type: DataTypes.JSONB, allowNull: true });
  const prefs = await qi.describeTable("notification_preferences");
  const addPref = async (name: string, spec: Parameters<typeof qi.addColumn>[2]) => {
    if (!prefs[name]) await qi.addColumn("notification_preferences", name, spec);
  };
  await addPref("quiet_enabled", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await addPref("quiet_start", { type: DataTypes.STRING(5), allowNull: false, defaultValue: "22:00" });
  await addPref("quiet_end", { type: DataTypes.STRING(5), allowNull: false, defaultValue: "07:00" });
  await addPref("quiet_timezone", { type: DataTypes.STRING(60), allowNull: false, defaultValue: "Africa/Lagos" });
  const attachments = await qi.describeTable("attachments");
  if (!attachments.uploaded_by) await qi.addColumn("attachments", "uploaded_by", user());

  await ignoreDuplicate(
    qi.createTable("conversations", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      type: { type: DataTypes.STRING(10), allowNull: false },
      scope: { type: DataTypes.STRING(14), allowNull: true },
      scope_id: { type: DataTypes.UUID, allowNull: true },
      name: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "" },
      description: { type: DataTypes.STRING(1000), allowNull: false, defaultValue: "" },
      avatar_url: { type: DataTypes.STRING, allowNull: true },
      posting: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "everyone" },
      direct_key: { type: DataTypes.STRING(80), allowNull: true, unique: true },
      created_by: user(),
      member_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      last_seq: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      last_message_id: { type: DataTypes.UUID, allowNull: true },
      last_message_at: { type: DataTypes.DATE, allowNull: true },
      last_sender_id: { type: DataTypes.UUID, allowNull: true },
      last_message_type: { type: DataTypes.STRING(10), allowNull: true },
      last_preview: { type: DataTypes.STRING(200), allowNull: true },
      archived_at: { type: DataTypes.DATE, allowNull: true },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("conversations", ["updated_at"], { name: "conversations_updated_at" }));
  await ignoreDuplicate(qi.addIndex("conversations", ["scope", "scope_id"], { name: "conversations_scope" }));

  await ignoreDuplicate(
    qi.createTable("conversation_members", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      conversation_id: { type: DataTypes.UUID, allowNull: false, references: { model: "conversations", key: "id" }, onDelete: "CASCADE" },
      user_id: { type: DataTypes.UUID, allowNull: false, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
      role: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "member" },
      source: { type: DataTypes.STRING(8), allowNull: false, defaultValue: "manual" },
      last_read_seq: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      last_read_at: { type: DataTypes.DATE, allowNull: true },
      notify: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "mentions" },
      muted_until: { type: DataTypes.DATE, allowNull: true },
      pinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      left_at: { type: DataTypes.DATE, allowNull: true },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("conversation_members", ["conversation_id", "user_id"], { name: "conversation_members_unique", unique: true }));
  await ignoreDuplicate(qi.addIndex("conversation_members", ["user_id", "left_at"], { name: "conversation_members_user" }));
  await ignoreDuplicate(qi.addIndex("conversation_members", ["updated_at"], { name: "conversation_members_updated_at" }));

  await ignoreDuplicate(
    qi.createTable("messages", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      conversation_id: { type: DataTypes.UUID, allowNull: false, references: { model: "conversations", key: "id" }, onDelete: "CASCADE" },
      seq: { type: DataTypes.BIGINT, autoIncrement: true, allowNull: false },
      sender_id: user(),
      type: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "text" },
      body: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      meta: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      parent_id: { type: DataTypes.UUID, allowNull: true, references: { model: "messages", key: "id" }, onDelete: "SET NULL" },
      reply_to_id: { type: DataTypes.UUID, allowNull: true, references: { model: "messages", key: "id" }, onDelete: "SET NULL" },
      thread_reply_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      thread_last_reply_at: { type: DataTypes.DATE, allowNull: true },
      thread_participant_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
      mentions: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
      pinned_at: { type: DataTypes.DATE, allowNull: true },
      edited_at: { type: DataTypes.DATE, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
      deleted_by: user(),
      client_sent_at: { type: DataTypes.DATE, allowNull: true },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("messages", ["conversation_id", "seq"], { name: "messages_conversation_seq" }));
  await ignoreDuplicate(qi.addIndex("messages", ["parent_id", "seq"], { name: "messages_parent_seq" }));
  await ignoreDuplicate(qi.addIndex("messages", ["updated_at"], { name: "messages_updated_at" }));
  await ignoreDuplicate(qi.sequelize.query(`CREATE INDEX messages_search ON messages USING GIN (to_tsvector('simple', body))`));
  await ignoreDuplicate(qi.sequelize.query(`CREATE INDEX messages_mentions ON messages USING GIN (mentions)`));

  await ignoreDuplicate(
    qi.createTable("message_reactions", {
      message_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "messages", key: "id" }, onDelete: "CASCADE" },
      user_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
      emoji: { type: DataTypes.STRING(16), allowNull: false, primaryKey: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );

  await ignoreDuplicate(
    qi.createTable("announcements", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      title: { type: DataTypes.STRING(200), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      audience_type: { type: DataTypes.STRING(14), allowNull: false },
      audience_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "draft" },
      require_ack: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      pinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      publish_at: { type: DataTypes.DATE, allowNull: true },
      published_at: { type: DataTypes.DATE, allowNull: true },
      expires_at: { type: DataTypes.DATE, allowNull: true },
      created_by: user(),
      published_by: user(),
      recipient_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      acknowledged_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("announcements", ["status", "publish_at"], { name: "announcements_status_publish" }));
  await ignoreDuplicate(qi.addIndex("announcements", ["updated_at"], { name: "announcements_updated_at" }));

  await ignoreDuplicate(
    qi.createTable("announcement_receipts", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      announcement_id: { type: DataTypes.UUID, allowNull: false, references: { model: "announcements", key: "id" }, onDelete: "CASCADE" },
      user_id: { type: DataTypes.UUID, allowNull: false, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
      read_at: { type: DataTypes.DATE, allowNull: true },
      acknowledged_at: { type: DataTypes.DATE, allowNull: true },
      last_reminded_at: { type: DataTypes.DATE, allowNull: true },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("announcement_receipts", ["announcement_id", "user_id"], { name: "announcement_receipts_unique", unique: true }));
  await ignoreDuplicate(qi.addIndex("announcement_receipts", ["user_id", "updated_at"], { name: "announcement_receipts_user" }));

  await ignoreDuplicate(
    qi.createTable("notification_category_preferences", {
      user_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
      category: { type: DataTypes.STRING(20), allowNull: false, primaryKey: true },
      in_app: { type: DataTypes.BOOLEAN, allowNull: false },
      push: { type: DataTypes.BOOLEAN, allowNull: false },
      email: { type: DataTypes.BOOLEAN, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );

  await addRolePermissions(qi, {
    department_head: ["channel.create", "channel.edit", "channel.manage_members"],
    team_lead: ["channel.create", "channel.edit", "channel.manage_members"],
    product_manager: ["channel.edit", "channel.manage_members", "channel.archive", "message.moderate"],
    project_manager: ["channel.edit", "channel.manage_members"],
  });
};

export const down: Migration = async ({ context: qi }) => {
  for (const t of ["notification_category_preferences", "announcement_receipts", "announcements", "message_reactions", "messages", "conversation_members", "conversations"]) {
    await qi.dropTable(t);
  }
  await qi.removeColumn("attachments", "uploaded_by").catch(() => undefined);
  await qi.removeColumn("notifications", "data").catch(() => undefined);
  for (const c of ["quiet_enabled", "quiet_start", "quiet_end", "quiet_timezone"]) {
    await qi.removeColumn("notification_preferences", c).catch(() => undefined);
  }
};
