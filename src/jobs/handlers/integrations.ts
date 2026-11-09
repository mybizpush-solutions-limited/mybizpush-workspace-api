import { calendarSync } from "../../modules/integrations/calendar.sync";
import { gmailService } from "../../modules/integrations/gmail.service";
import { registerJob, registerSchedule } from "../workers";

registerJob("maintenance", "calendar-sync", async () => {
  await calendarSync.sweep();
});
registerSchedule("maintenance", "calendar-sync", "*/15 * * * *");

registerJob("maintenance", "gmail-replies", async () => {
  await gmailService.checkReplies();
});
registerSchedule("maintenance", "gmail-replies", "7,22,37,52 * * * *");
