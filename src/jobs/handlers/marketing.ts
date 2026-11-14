import { campaignsService } from "../../modules/marketing/campaigns.service";
import { leadsService } from "../../modules/marketing/leads.service";
import { registerJob, registerSchedule } from "../workers";

registerJob<{ id: string }>("imports", "leads", async ({ id }) => {
  await leadsService.runImport(id);
});

registerJob<{ campaignId: string }>("campaigns", "start", async ({ campaignId }) => {
  await campaignsService.start(campaignId);
});
registerJob<{ campaignId: string }>("campaigns", "batch", async ({ campaignId }) => {
  await campaignsService.batch(campaignId);
});
registerJob("campaigns", "dispatch-due", async () => {
  await campaignsService.dispatchDue();
});
registerSchedule("campaigns", "dispatch-due", "* * * * *");
