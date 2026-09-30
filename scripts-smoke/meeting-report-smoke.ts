// Scratch smoke test: meeting report from a transcript, without DB/Cloudinary.
import fs from "node:fs";
import { draftMeetingReport } from "/Users/samsonite/Documents/Sam/mybizpush/dev-team/api/src/modules/reports/meetingReport.service";

const transcript = fs.readFileSync(
  "/Users/samsonite/Documents/Sam/mybizpush/staff-meeting-brief-2026-08-26.md",
  "utf8",
);

(async () => {
  const { data, buffer, filename } = await draftMeetingReport(
    transcript,
    "staff-meeting-brief-2026-08-26.md",
  );
  fs.writeFileSync("/tmp/meeting-report-test.pdf", buffer);
  console.log("OK", filename, `${(buffer.length / 1024).toFixed(0)} KB`);
  console.log("TITLE:", data.title);
  console.log("DATE:", data.date);
  console.log("ATTENDEES:", data.attendees.length, "| SECTIONS:", data.sections.length,
    "| DECISIONS:", data.decisions.length, "| ACTIONS:", data.actionItems.length);
  const all = JSON.stringify(data);
  console.log("HAS_EM_DASH:", /[\u2013\u2014]/.test(all));
})();