import cron from "node-cron";
import { env } from "../../config/env";
import { meetingReportService } from "./meetingReport.service";

// Sweeps for pending (or stale processing) meeting reports every minute and
// processes them in the background. Complements the fire-and-forget kick that
// runs when a transcript is uploaded: this catches restarts, crashes and any
// generation that didn't start for any reason.
export function startMeetingReportsScheduler() {
  cron.schedule(env.MEETING_REPORT_POLL_CRON, () => {
    void meetingReportService.processPending().catch((err) =>
      console.error("[meeting-reports] sweeper failed:", err),
    );
  });
}