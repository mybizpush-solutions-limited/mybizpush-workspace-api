import { Campaign, ContentEvent, ContentItem, Lead, LeadList, type LeadConsent } from "../../models";
import { sequelize } from "../sequelize";
import type { SeedContext } from "./context";
import { dayAt, hash } from "./time";

// Lead addresses use the reserved .example domain so nothing can ever be delivered.
const LEADS: [name: string, company: string, list: string, tags: string[]][] = [
  ["Adaeze Nwankwo", "Kudi Foods", "lagos", ["restaurant", "customer-story"]],
  ["Babatunde Cole", "Cole and Sons Pharmacy", "lagos", ["pharmacy"]],
  ["Ngozi Ibe", "Glow Beauty Lounge", "lagos", ["beauty"]],
  ["Olumide Ajayi", "Ajayi Logistics", "lagos", ["logistics", "high-intent"]],
  ["Fatima Sani", "Sani Fabrics", "webinar", ["retail"]],
  ["Kelechi Uzo", "Uzo Electronics", "lagos", ["retail", "high-intent"]],
  ["Temitope Bello", "Bello Bakery", "webinar", ["restaurant"]],
  ["Chinedu Eze", "FreshCart Grocers", "lagos", ["retail"]],
  ["Aisha Lawal", "Lawal Clinic", "webinar", ["health"]],
  ["Ifeanyi Okafor", "Okafor Auto Parts", "lagos", ["auto"]],
  ["Halimat Yusuf", "Yusuf Events", "webinar", ["events", "high-intent"]],
  ["Segun Adeyemi", "Adeyemi Realty", "lagos", ["real-estate"]],
  ["Blessing Udo", "Udo Fashion House", "webinar", ["fashion"]],
  ["Ibrahim Garba", "Garba Farms", "webinar", ["agriculture"]],
  ["Ronke Shittu", "Shittu Laundry", "lagos", ["services"]],
  ["Emmanuel Okon", "Okon Hardware", "lagos", ["retail"]],
];

const LISTS = {
  lagos: { name: "Lagos SMEs", description: "Small and medium businesses in Lagos from events and referrals." },
  webinar: { name: "Webinar signups November", description: "Registrants for the selling on autopilot webinar." },
};

const CONTENT = [
  { title: "How Lagos SMEs automate WhatsApp follow ups", type: "blog" as const, platform: "website" as const, status: "in_progress", writer: "bolu", designer: null, publishIn: 5 },
  { title: "Growth plan pricing carousel", type: "social_post" as const, platform: "instagram" as const, status: "in_design", writer: "seyi", designer: "bisi", publishIn: 3 },
  { title: "Customer story: Kudi Foods", type: "video" as const, platform: "youtube" as const, status: "in_review", writer: "bolu", designer: "tobi", publishIn: 8 },
  { title: "November product update newsletter", type: "newsletter" as const, platform: "email" as const, status: "scheduled", writer: "amaka", designer: "bisi", publishIn: 2 },
  { title: "Black Friday teaser", type: "social_post" as const, platform: "x" as const, status: "published", writer: "seyi", designer: "bisi", publishIn: -3 },
  { title: "Webinar: selling on autopilot recap", type: "blog" as const, platform: "website" as const, status: "idea", writer: "bolu", designer: null, publishIn: null },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export async function seedMarketing(ctx: SeedContext): Promise<void> {
  const product = ctx.product("mybizpush");
  const marketer = ctx.id("amaka");
  const lists = new Map<string, string>();
  for (const [key, spec] of Object.entries(LISTS)) {
    const [list] = await LeadList.findOrCreate({ where: { productId: product.id, name: spec.name }, defaults: { productId: product.id, ...spec, createdBy: marketer } });
    lists.set(key, list.id);
  }

  for (const [name, company, listKey, tags] of LEADS) {
    const email = `${name.split(" ")[0]!.toLowerCase()}@${slug(company)}.example`;
    const consent: LeadConsent = hash(email) % 4 === 0 ? "unknown" : "granted";
    const [lead] = await Lead.findOrCreate({
      where: { productId: product.id, email },
      defaults: {
        productId: product.id,
        email,
        name,
        company,
        source: listKey === "webinar" ? "form" : pickSource(email),
        tags,
        consent,
        consentAt: consent === "granted" ? dayAt(-(hash(email) % 30) - 1, "12:00") : null,
        consentSource: consent === "granted" ? (listKey === "webinar" ? "Webinar registration form" : "Signed up at a MyBizPush event") : null,
        ownerId: ctx.id(hash(email) % 2 ? "kemi" : "yusuf"),
        createdBy: marketer,
        createdAt: dayAt(-(hash(email) % 40) - 1, "11:00"),
      },
    });
    await sequelize.query(`INSERT INTO lead_list_members (list_id, lead_id, created_at) VALUES (:listId, :leadId, now()) ON CONFLICT DO NOTHING`, {
      replacements: { listId: lists.get(listKey)!, leadId: lead.id },
    });
  }

  await Campaign.findOrCreate({
    where: { productId: product.id, name: "December promo: 3 months free on Growth" },
    defaults: {
      productId: product.id,
      name: "December promo: 3 months free on Growth",
      subject: "Three months of Growth, on us",
      previewText: "Automate follow ups and never miss a customer message again.",
      fromName: product.senderName ?? "MyBizPush",
      fromEmail: product.senderEmail ?? "",
      bodyHtml: "<h1>Three months of Growth, on us</h1><p>Hi {{first_name}}, reply to every customer in seconds with automated WhatsApp follow ups.</p><p><a href=\"https://mybizpush.com/pricing\">Claim your offer</a></p><p><a href=\"{{unsubscribe_url}}\">Unsubscribe</a></p>",
      bodyText: "Hi {{first_name}}, reply to every customer in seconds with automated WhatsApp follow ups. Claim your offer: https://mybizpush.com/pricing\n\nUnsubscribe: {{unsubscribe_url}}",
      audience: { listIds: [lists.get("lagos")!], includeUnknownConsent: false },
      status: "draft",
      createdBy: marketer,
    },
  });

  for (const spec of CONTENT) {
    const [item, created] = await ContentItem.findOrCreate({
      where: { productId: product.id, title: spec.title },
      defaults: {
        productId: product.id,
        title: spec.title,
        type: spec.type,
        platform: spec.platform,
        status: spec.status,
        brief: `${spec.title}. Audience: small business owners in Nigeria. Goal: drive Growth plan trials.`,
        caption: spec.type === "social_post" ? "Your customers are waiting. Reply in seconds, not hours." : "",
        writerId: ctx.id(spec.writer),
        designerId: spec.designer ? ctx.id(spec.designer) : null,
        reviewerId: ctx.id("chiamaka"),
        publishAt: spec.publishIn !== null ? dayAt(spec.publishIn, "10:00") : null,
        publishedAt: spec.status === "published" ? dayAt(spec.publishIn!, "10:00") : null,
        createdBy: ctx.id("chiamaka"),
        createdAt: dayAt(-9, "10:00"),
      },
    });
    if (created) await ContentEvent.create({ contentId: item.id, kind: "created", toStatus: spec.status, actorId: ctx.id("chiamaka"), createdAt: dayAt(-9, "10:00") });
  }
}

function pickSource(email: string): "event" | "referral" | "manual" {
  return (["event", "referral", "manual"] as const)[hash(email) % 3]!;
}
