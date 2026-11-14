import { QueryTypes } from "sequelize";
import { env } from "../../config/env";
import { sequelize } from "../../db/sequelize";
import { OrganizationSetting } from "../../models";
import { bareDomain } from "../marketing/campaign.render";

export async function loadSettings(): Promise<OrganizationSetting> {
  const [row] = await OrganizationSetting.findOrCreate({ where: { id: 1 }, defaults: { id: 1 } });
  return row;
}

// The default sender (A1005). Settings override config, and config defaults to
// info@mybizpush.com.
export async function organizationSender(): Promise<{ name: string; email: string }> {
  const row = await loadSettings();
  return { name: row.senderName?.trim() || env.ORG_SENDER_NAME, email: row.senderEmail?.trim() || env.ORG_SENDER_EMAIL };
}

// A product's own domains: the sites registered for its projects. These are records
// the company already keeps, so nobody claims a domain just by typing an address.
export async function productOwnDomains(productId: string): Promise<string[]> {
  const rows = await sequelize.query<{ domain: string }>(
    `SELECT s.domain FROM analytics_sites s JOIN projects p ON p.id = s.project_id WHERE p.product_id = :productId`,
    { replacements: { productId }, type: QueryTypes.SELECT },
  );
  return [...new Set(rows.map((r) => bareDomain(r.domain)).filter(Boolean))];
}
