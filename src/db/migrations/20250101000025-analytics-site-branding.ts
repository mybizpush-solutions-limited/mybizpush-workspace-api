import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Cached branding scraped from each tracked site's homepage, so the sites list
// shows real favicons and preview images instead of one identical placeholder.
// URLs only — we never proxy or store the image bytes.
export const up: Migration = async ({ context: qi }) => {
  for (const [column, type] of [
    ["favicon_url", DataTypes.STRING(1000)],
    ["og_image_url", DataTypes.STRING(1000)],
    ["site_title", DataTypes.STRING(300)],
    ["site_description", DataTypes.STRING(600)],
  ] as const) {
    await ignoreDuplicate(
      qi.addColumn("analytics_sites", column, { type, allowNull: false, defaultValue: "" }),
    );
  }
  // When we last successfully scraped. Null = never; drives the refresh cadence.
  await ignoreDuplicate(
    qi.addColumn("analytics_sites", "branding_fetched_at", {
      type: DataTypes.DATE,
      allowNull: true,
    }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  for (const column of [
    "favicon_url",
    "og_image_url",
    "site_title",
    "site_description",
    "branding_fetched_at",
  ]) {
    await qi.removeColumn("analytics_sites", column);
  }
};
