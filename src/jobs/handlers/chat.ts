import { announcementsService } from "../../modules/announcements/announcements.service";
import { chatService, fanOutMessage } from "../../modules/chat/chat.service";
import { registerJob, registerSchedule } from "../workers";

registerJob<{ messageId: string }>("push", "message-fanout", async ({ messageId }) => {
  await fanOutMessage(messageId);
});

registerJob("reminders", "announcements-publish", async () => {
  await announcementsService.publishDue();
});
registerSchedule("reminders", "announcements-publish", "* * * * *");

registerJob("maintenance", "chat-scope-sync", async () => {
  await chatService.syncScopes();
});
registerSchedule("maintenance", "chat-scope-sync", "17 * * * *");
