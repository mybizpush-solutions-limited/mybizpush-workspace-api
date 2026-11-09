import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { addRolePermissions, ignoreDuplicate } from "../migration-helpers";

// Leads, lists, suppression, campaigns, content planning and social accounts
// (API-CHANGES A601 to A604).
export const up: Migration = async ({ context: qi }) => {
  const stamps = () => ({ created_at: { type: DataTypes.DATE, allowNull: false }, updated_at: { type: DataTypes.DATE, allowNull: false } });
  const user = () => ({ type: DataTypes.UUID, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" });
  const product = () => ({ type: DataTypes.UUID, allowNull: false, references: { model: "products", key: "id" }, onDelete: "CASCADE" });

  await ignoreDuplicate(
    qi.createTable("leads", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      product_id: product(),
      email: { type: DataTypes.STRING(254), allowNull: false },
      name: { type: DataTypes.STRING(200), allowNull: false, defaultValue: "" },
      company: { type: DataTypes.STRING(200), allowNull: false, defaultValue: "" },
      phone: { type: DataTypes.STRING(40), allowNull: true },
      source: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "manual" },
      tags: { type: DataTypes.ARRAY(DataTypes.STRING(60)), allowNull: false, defaultValue: [] },
      consent: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "unknown" },
      consent_at: { type: DataTypes.DATE, allowNull: true },
      consent_source: { type: DataTypes.STRING(200), allowNull: true },
      status: { type: DataTypes.STRING(14), allowNull: false, defaultValue: "active" },
      owner_id: user(),
      custom: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      created_by: user(),
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("leads", ["product_id", "email"], { name: "leads_product_email", unique: true }));

  await ignoreDuplicate(
    qi.createTable("lead_lists", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      product_id: product(),
      name: { type: DataTypes.STRING(120), allowNull: false },
      description: { type: DataTypes.STRING(500), allowNull: false, defaultValue: "" },
      created_by: user(),
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("lead_lists", ["product_id"], { name: "lead_lists_product" }));

  await ignoreDuplicate(
    qi.createTable("lead_list_members", {
      list_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "lead_lists", key: "id" }, onDelete: "CASCADE" },
      lead_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "leads", key: "id" }, onDelete: "CASCADE" },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("lead_list_members", ["lead_id"], { name: "lead_list_members_lead" }));

  await ignoreDuplicate(
    qi.createTable("lead_segments", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      product_id: product(),
      name: { type: DataTypes.STRING(120), allowNull: false },
      rules: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      created_by: user(),
      ...stamps(),
    }),
  );

  await ignoreDuplicate(
    qi.createTable("suppressions", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      product_id: { type: DataTypes.UUID, allowNull: true, references: { model: "products", key: "id" }, onDelete: "CASCADE" },
      email: { type: DataTypes.STRING(254), allowNull: false },
      reason: { type: DataTypes.STRING(14), allowNull: false },
      note: { type: DataTypes.STRING(500), allowNull: true },
      created_by: user(),
      created_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("suppressions", ["email"], { name: "suppressions_email" }));
  // NULL product means every product, and unique indexes treat NULLs as distinct.
  await ignoreDuplicate(qi.sequelize.query(`CREATE UNIQUE INDEX suppressions_unique ON suppressions (COALESCE(product_id, '00000000-0000-0000-0000-000000000000'), email)`));

  await ignoreDuplicate(
    qi.createTable("campaigns", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      product_id: product(),
      name: { type: DataTypes.STRING(200), allowNull: false },
      subject: { type: DataTypes.STRING(300), allowNull: false, defaultValue: "" },
      preview_text: { type: DataTypes.STRING(300), allowNull: false, defaultValue: "" },
      from_name: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "" },
      from_email: { type: DataTypes.STRING(254), allowNull: false, defaultValue: "" },
      reply_to: { type: DataTypes.STRING(254), allowNull: true },
      body_html: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      body_text: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      audience: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      status: { type: DataTypes.STRING(18), allowNull: false, defaultValue: "draft" },
      scheduled_at: { type: DataTypes.DATE, allowNull: true },
      throttle_per_minute: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
      submitted_by: user(),
      submitted_at: { type: DataTypes.DATE, allowNull: true },
      reviewed_by: user(),
      reviewed_at: { type: DataTypes.DATE, allowNull: true },
      review_note: { type: DataTypes.STRING(1000), allowNull: true },
      started_at: { type: DataTypes.DATE, allowNull: true },
      finished_at: { type: DataTypes.DATE, allowNull: true },
      stats: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      created_by: user(),
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("campaigns", ["product_id", "status"], { name: "campaigns_product_status" }));
  await ignoreDuplicate(qi.addIndex("campaigns", ["status", "scheduled_at"], { name: "campaigns_status_scheduled" }));

  const campaignRef = { type: DataTypes.UUID, allowNull: false, references: { model: "campaigns", key: "id" }, onDelete: "CASCADE" };
  await ignoreDuplicate(
    qi.createTable("campaign_recipients", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      campaign_id: campaignRef,
      lead_id: { type: DataTypes.UUID, allowNull: true, references: { model: "leads", key: "id" }, onDelete: "SET NULL" },
      email: { type: DataTypes.STRING(254), allowNull: false },
      token: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "queued" },
      skip_reason: { type: DataTypes.STRING(20), allowNull: true },
      provider_id: { type: DataTypes.STRING(120), allowNull: true },
      sent_at: { type: DataTypes.DATE, allowNull: true },
      delivered_at: { type: DataTypes.DATE, allowNull: true },
      opened_at: { type: DataTypes.DATE, allowNull: true },
      open_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      clicked_at: { type: DataTypes.DATE, allowNull: true },
      click_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      unsubscribed_at: { type: DataTypes.DATE, allowNull: true },
      complained_at: { type: DataTypes.DATE, allowNull: true },
      error: { type: DataTypes.STRING(500), allowNull: true },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("campaign_recipients", ["campaign_id", "status"], { name: "campaign_recipients_campaign" }));
  await ignoreDuplicate(qi.addIndex("campaign_recipients", ["lead_id"], { name: "campaign_recipients_lead" }));
  await ignoreDuplicate(qi.addIndex("campaign_recipients", ["provider_id"], { name: "campaign_recipients_provider" }));

  await ignoreDuplicate(
    qi.createTable("campaign_links", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      campaign_id: campaignRef,
      url: { type: DataTypes.TEXT, allowNull: false },
      clicks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      unique_clicks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    }),
  );
  await ignoreDuplicate(qi.addIndex("campaign_links", ["campaign_id"], { name: "campaign_links_campaign" }));

  await ignoreDuplicate(
    qi.createTable("content_items", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      product_id: product(),
      title: { type: DataTypes.STRING(300), allowNull: false },
      type: { type: DataTypes.STRING(12), allowNull: false },
      platform: { type: DataTypes.STRING(12), allowNull: true },
      status: { type: DataTypes.STRING(18), allowNull: false, defaultValue: "idea" },
      brief: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      caption: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      writer_id: user(),
      designer_id: user(),
      reviewer_id: user(),
      publish_at: { type: DataTypes.DATE, allowNull: true },
      published_at: { type: DataTypes.DATE, allowNull: true },
      blog_post_id: { type: DataTypes.UUID, allowNull: true },
      url: { type: DataTypes.STRING(2000), allowNull: true },
      created_by: user(),
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("content_items", ["product_id", "status"], { name: "content_items_product_status" }));
  await ignoreDuplicate(qi.addIndex("content_items", ["publish_at"], { name: "content_items_publish_at" }));
  await ignoreDuplicate(qi.addIndex("content_items", ["updated_at"], { name: "content_items_updated_at" }));

  await ignoreDuplicate(
    qi.createTable("content_events", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      content_id: { type: DataTypes.UUID, allowNull: false, references: { model: "content_items", key: "id" }, onDelete: "CASCADE" },
      kind: { type: DataTypes.STRING(8), allowNull: false },
      from_status: { type: DataTypes.STRING(18), allowNull: true },
      to_status: { type: DataTypes.STRING(18), allowNull: true },
      decision: { type: DataTypes.STRING(18), allowNull: true },
      note: { type: DataTypes.TEXT, allowNull: true },
      actor_id: user(),
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("content_events", ["content_id"], { name: "content_events_content" }));
  await ignoreDuplicate(qi.addIndex("content_events", ["updated_at"], { name: "content_events_updated_at" }));

  await ignoreDuplicate(
    qi.createTable("social_accounts", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      product_id: product(),
      platform: { type: DataTypes.STRING(12), allowNull: false },
      handle: { type: DataTypes.STRING(120), allowNull: false },
      url: { type: DataTypes.STRING(2000), allowNull: true },
      owner_id: user(),
      notes: { type: DataTypes.STRING(1000), allowNull: false, defaultValue: "" },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("social_accounts", ["product_id"], { name: "social_accounts_product" }));
  await ignoreDuplicate(qi.addIndex("social_accounts", ["updated_at"], { name: "social_accounts_updated_at" }));

  // A product manager runs the product's marketing, so they can see and do what
  // they approve. Two people are still needed: nobody approves their own campaign.
  await addRolePermissions(qi, { product_manager: ["campaign.create", "campaign.import", "campaign.send", "campaign.view", "content.create", "content.publish"] });
};

export const down: Migration = async ({ context: qi }) => {
  for (const t of ["social_accounts", "content_events", "content_items", "campaign_links", "campaign_recipients", "campaigns", "suppressions", "lead_segments", "lead_list_members", "lead_lists", "leads"]) {
    await qi.dropTable(t);
  }
};
