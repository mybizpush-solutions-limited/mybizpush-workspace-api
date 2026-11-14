import { queriesService } from "../../modules/performance/queries.service";
import { reportExports } from "../../modules/performance/report.exports";
import { targetsService } from "../../modules/performance/targets.service";
import { registerJob, registerSchedule } from "../workers";

registerJob<{ exportId: string }>("exports", "report", async ({ exportId }) => {
  await reportExports.run(exportId);
});

registerJob("maintenance", "report-exports-purge", async () => {
  await reportExports.purgeExpired();
});
registerSchedule("maintenance", "report-exports-purge", "40 3 * * *");

registerJob("reminders", "query-deadlines", async () => {
  await queriesService.remindDue();
});
registerSchedule("reminders", "query-deadlines", "10 * * * *");

registerJob("maintenance", "targets-sweep", async () => {
  await targetsService.sweep();
});
registerSchedule("maintenance", "targets-sweep", "25 * * * *");

registerJob<{ userIds: string[] }>("maintenance", "targets-refresh", async ({ userIds }) => {
  await targetsService.refreshForUsers(userIds);
});
