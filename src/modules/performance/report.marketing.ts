import { Op, QueryTypes } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { Campaign, ContentItem, Lead } from "../../models";
import type { Range } from "./reports.service";

// The marketing part of reports. Null means the whole organization.
export async function marketingTotals(productId: string | null, range: Range) {
  const inProduct = productId ? { productId } : {};
  const [stats] = await sequelize.query<{ sent: string; delivered: string; opened: string; clicked: string }>(
    `SELECT COUNT(*) FILTER (WHERE r.status IN ('sent','delivered','bounced')) AS sent,
            COUNT(*) FILTER (WHERE r.status = 'delivered') AS delivered,
            COUNT(*) FILTER (WHERE r.opened_at IS NOT NULL) AS opened,
            COUNT(*) FILTER (WHERE r.clicked_at IS NOT NULL) AS clicked
       FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
      WHERE r.created_at BETWEEN :from AND :to ${productId ? "AND c.product_id = :productId" : ""}`,
    { replacements: { from: range.from, to: range.to, productId }, type: QueryTypes.SELECT },
  );
  const [campaigns, leads, planned, published] = await Promise.all([
    Campaign.count({ where: { ...inProduct, createdAt: { [Op.between]: [range.from, range.to] } } }),
    Lead.count({ where: { ...inProduct } }),
    ContentItem.count({ where: { ...inProduct, publishAt: { [Op.between]: [range.from, range.to] }, status: { [Op.notIn]: ["cancelled"] } } }),
    ContentItem.count({ where: { ...inProduct, status: "published", publishedAt: { [Op.between]: [range.from, range.to] } } }),
  ]);
  return {
    campaignStats: { sent: Number(stats?.sent ?? 0), delivered: Number(stats?.delivered ?? 0), opened: Number(stats?.opened ?? 0), clicked: Number(stats?.clicked ?? 0) },
    marketing: { campaigns, leads },
    content: { planned, published },
    contentFor: async (staffId: string) => ({
      items: await ContentItem.count({
        where: { ...inProduct, createdAt: { [Op.between]: [range.from, range.to] }, [Op.or]: [{ writerId: staffId }, { designerId: staffId }, { reviewerId: staffId }] },
      }),
    }),
    campaignsBy: async (staffId: string) => ({
      created: await Campaign.count({ where: { ...inProduct, createdBy: staffId, createdAt: { [Op.between]: [range.from, range.to] } } }),
    }),
  };
}
