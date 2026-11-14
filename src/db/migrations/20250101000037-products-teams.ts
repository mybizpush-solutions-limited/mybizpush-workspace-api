import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Products (the business umbrella: people, projects, marketing, social) and
// teams (cross-department working groups). API-CHANGES A101, A102.
// Existing projects keep product_id null until an admin links them (PRD-03).
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("products", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(120), allowNull: false },
      slug: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      description: { type: DataTypes.STRING(400), allowNull: false, defaultValue: "" },
      logo_url: { type: DataTypes.STRING, allowNull: true },
      // Light wash behind the logo in avatar stacks (design: product tints).
      tint: { type: DataTypes.STRING(9), allowNull: true },
      stage: { type: DataTypes.ENUM("in_development", "live", "paused"), allowNull: false, defaultValue: "in_development" },
      owner_id: { type: DataTypes.UUID, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(
    qi.createTable("product_members", {
      product_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "products", key: "id" }, onDelete: "CASCADE" },
      user_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
      // Short label shown in people lists ("Marketing lead"); access comes from
      // role assignments, not from this text.
      title: { type: DataTypes.STRING(80), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  const projectCols = await qi.describeTable("projects");
  if (!projectCols.product_id) {
    await qi.addColumn("projects", "product_id", {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "products", key: "id" },
      onDelete: "SET NULL",
    });
  }
  await ignoreDuplicate(qi.addIndex("projects", ["product_id"], { name: "projects_product" }));

  await ignoreDuplicate(
    qi.createTable("teams", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(120), allowNull: false },
      slug: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      description: { type: DataTypes.STRING(400), allowNull: false, defaultValue: "" },
      lead_id: { type: DataTypes.UUID, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(
    qi.createTable("team_members", {
      team_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "teams", key: "id" }, onDelete: "CASCADE" },
      user_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
    }),
  );
  await ignoreDuplicate(
    qi.createTable("team_projects", {
      team_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "teams", key: "id" }, onDelete: "CASCADE" },
      project_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "projects", key: "id" }, onDelete: "CASCADE" },
    }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("team_projects");
  await qi.dropTable("team_members");
  await qi.dropTable("teams");
  await qi.removeColumn("projects", "product_id").catch(() => undefined);
  await qi.dropTable("product_members");
  await qi.dropTable("products");
  await qi.sequelize.query('DROP TYPE IF EXISTS "enum_products_stage";');
};
