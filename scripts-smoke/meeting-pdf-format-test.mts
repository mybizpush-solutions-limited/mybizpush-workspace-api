// Scratch check for the meeting-report PDF layout: renders with the long values
// that broke the old layout (long attendee list, wide owner/due columns) and
// writes /tmp/mr2.pdf for inspection. Run: npx tsx scripts-smoke/meeting-pdf-format-test.mts
import fs from "node:fs";
import { renderMeetingReportPdf } from "../src/modules/reports/meetingReportPdf";
import type { MeetingReportData } from "../src/modules/reports/meetingReport.service";

const data: MeetingReportData = {
  title: "General Management and Staff Meeting",
  date: "Late September 2026 (exact date not stated; described as the last general meeting for the month of September 2026)",
  attendees: [
    "Ms. Chama (led Christian opening prayer)",
    "Bashir (led Muslim opening prayer)",
    "Mr. Samson (Head of Chiefs, delivered the CEO's address)",
    "Miss Ann (read the minutes of the 2nd September meeting)",
    "Mr. Richard (designs completed)",
    "Mr. Bashan (TechBrass website update)",
    "Mr. Gift (Chief Financial Officer)",
    "Mr. Stephen (Chief Operating Officer)",
    "The admin (attendance and compilation of social media handles)",
    "All staff of MyBizPush Solutions Limited were present; the CEO sent apologies",
  ],
  absent: ["The CEO (apology conveyed; might join later or might not join at all)"],
  summary: [
    "The meeting opened with Christian and Muslim prayers led by Ms. Chama and Bashir respectively. The admin took attendance and confirmed that all staff were present except the CEO, whose apology was conveyed. Miss Ann read the minutes of the 2nd September meeting and the minutes were adopted after a mover and a seconder were called for.",
    "Project managers gave updates on client projects, the CTO briefed the meeting on the PCI DSS certification, and the chiefs addressed staff conduct, warning that attendance, punctuality and ownership of tasks will be taken very seriously from October.",
  ],
  sections: [
    {
      heading:
        "Reading and adoption of minutes of the meeting held on 2nd September 2026",
      paragraphs: [
        "Miss Ann read the minutes of the management and staff meeting held on 2nd September 2026 from 3 PM to 4 PM via Google Meets, hosted by the CEO. The minutes recorded project updates, marketing reports and the CEO's announcements, including organisational changes and a training programme for all staff.",
      ],
    },
  ],
  decisions: [
    "The minutes of the management and staff meeting held on 2nd September 2026 were adopted, with a mover and a seconder.",
    "The minutes are to be corrected to record that Mr. Gift transitioned from Chief Operating Officer to Chief Financial Officer, not from Chief Marketing Officer.",
    "All project managers are to prepare their project portfolios, including detailed budget, progress and blocker reports, and submit them to the admin before the end of the week.",
  ],
  actionItems: [
    {
      action:
        "Prepare project portfolios with detailed reports on budgets, progress and blockers, and forward them to the admin",
      owner: "All project managers",
      due: "Before the end of this week",
    },
    {
      action:
        "Compile and forward all links and names of the company's social media handles and websites to the admin for review",
      owner: "The custodians of the handles and websites (names not stated in the transcript)",
      due: "—",
    },
    {
      action:
        "Be in contact with the Chief Technical Officer regarding the TechBrass website so the CTO is aware of the work and can ensure it follows best practices",
      owner: "Mr. Bashan",
      due: "—",
    },
    {
      action: "Join the project managers' meeting from next week",
      owner: "Head of creatives and head of marketing and strategies",
      due: "Next week",
    },
    {
      action: "Confirm the marketers' reporting line, which remained unresolved as at this meeting",
      owner: "The chiefs (not explicitly assigned in the transcript)",
      due: "",
    },
  ],
  generatedAt: new Date().toISOString(),
};

const { buffer, filename } = await renderMeetingReportPdf(data, "gen-meet-30-09-26.txt");
fs.writeFileSync("/tmp/mr2.pdf", buffer);
console.log("wrote /tmp/mr2.pdf as", filename, buffer.length, "bytes");