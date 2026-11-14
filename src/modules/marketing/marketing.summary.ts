import { Op, QueryTypes } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { Campaign, ContentItem, LeadList } from "../../models";
import { serializeCampaign } from "./campaigns.service";

// The Marketing tab on a product (MKT-01, P6-APP-4).
export async function marketingSummary(productId: string) {
  const [leadRow] = await sequelize.query<{ total: string; active: string; unsubscribed: string; bounced: string }>(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'active') AS active,
            COUNT(*) FILTER (WHERE status = 'unsubscribed') AS unsubscribed, COUNT(*) FILTER (WHERE status = 'bounced') AS bounced
       FROM leads WHERE product_id = :productId`,
    { replacements: { productId }, type: QueryTypes.SELECT },
  );
  const count = (status: string | string[]) => Campaign.count({ where: { productId, status } });
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [lists, draft, pendingApproval, scheduled, sent, recent, planned, inReview, published30d] = await Promise.all([
    LeadList.count({ where: { productId } }),
    count("draft"),
    count("pending_approval"),
    count("scheduled"),
    count("sent"),
    Campaign.findAll({ where: { productId }, order: [["updatedAt", "DESC"]], limit: 5 }),
    ContentItem.count({ where: { productId, status: { [Op.notIn]: ["published", "cancelled"] } } }),
    ContentItem.count({ where: { productId, status: "in_review" } }),
    ContentItem.count({ where: { productId, status: "published", publishedAt: { [Op.gte]: since } } }),
  ]);
  return {
    leads: { total: Number(leadRow?.total ?? 0), active: Number(leadRow?.active ?? 0), unsubscribed: Number(leadRow?.unsubscribed ?? 0), bounced: Number(leadRow?.bounced ?? 0) },
    lists,
    campaigns: { draft, pendingApproval, scheduled, sent },
    recent: recent.map((c) => serializeCampaign(c, false)),
    content: { planned, inReview, published30d },
  };
}
