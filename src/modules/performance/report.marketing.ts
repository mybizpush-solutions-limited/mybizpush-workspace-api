import type { Range } from "./reports.service";

// The marketing part of reports. Zero until the marketing tables arrive (A602,
// A603); this keeps the report shape stable for the app in the meantime.
export async function marketingTotals(_productId: string | null, _range: Range) {
  return {
    campaignStats: { sent: 0, delivered: 0, opened: 0, clicked: 0 },
    marketing: { campaigns: 0, leads: 0 },
    content: { planned: 0, published: 0 },
    contentFor: async (_staffId: string) => ({ items: 0 }),
    campaignsBy: async (_staffId: string) => ({ created: 0 }),
  };
}
