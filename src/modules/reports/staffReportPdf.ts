import type { StaffReportPayload, ReportRow, TimelineEntry } from "./staffReport.service";
import {
  chip,
  createDoc,
  CW,
  decorate,
  FAINT,
  finish,
  fit,
  GREY,
  h1,
  INK,
  letterhead,
  LIGHT,
  M,
  need,
  PURPLE,
  RenderedPdf,
  RULE,
  W,
} from "./pdfChrome";

// Renders a staff monthly report as an A4 PDF in MyBizPush house branding
// (see pdfChrome.ts for the shared letterhead/header/footer machinery). Output
// is a Buffer so routes can stream it or upload it to Cloudinary.

const STATUS_STYLES: Record<string, { fg: string; bg: string; label: string }> = {
  done: { fg: "#1f6b3c", bg: "#e6f3ea", label: "Done" },
  in_progress: { fg: "#6a0d69", bg: LIGHT, label: "In progress" },
  in_review: { fg: "#8a5c0d", bg: "#fbf1de", label: "In review" },
  blocked: { fg: "#9d1f16", bg: "#fbe9e7", label: "Blocked" },
  todo: { fg: "#4b5262", bg: "#eef0f4", label: "To do" },
};

const SEVERITY_STYLES: Record<string, { fg: string; bg: string; label: string }> = {
  critical: { fg: "#9d1f16", bg: "#fbe9e7", label: "Critical" },
  major: { fg: "#8a5c0d", bg: "#fbf1de", label: "Major" },
  minor: { fg: "#4b5262", bg: "#eef0f4", label: "Minor" },
};

// Non-indexed fallback so `?? fallback` always yields a concrete style even
// under noUncheckedIndexedAccess.
const FALLBACK_STYLE = { fg: "#4b5262", bg: "#eef0f4", label: "To do" };

// Eyebrow + staff name + cover metadata box (page 1, under the letterhead).
function cover(doc: PDFKit.PDFDocument, p: StaffReportPayload) {
  doc.moveDown(0.8);
  const eyebrowY = doc.y;
  doc
    .font("bold")
    .fontSize(8.5)
    .fillColor(PURPLE)
    .text("S T A F F   M O N T H L Y   R E P O R T", M, eyebrowY, { lineBreak: false });
  doc.moveDown(0.7);
  doc.font("bold").fontSize(21).fillColor(INK).text(p.staff.name, M, doc.y);
  doc
    .font("reg")
    .fontSize(10.5)
    .fillColor(GREY)
    .text(
      `${p.staff.roles.length ? p.staff.roles.join(", ") + " · " : ""}Project: ${p.project.name}`,
      M,
      doc.y + 4,
    );

  need(doc, 120);
  doc.moveDown(0.6);
  const y = doc.y;
  const rows: [string, string][] = [
    ["Project", p.project.name],
    [
      "Staff",
      `${p.staff.name}${p.staffDepartments.length ? ` (${p.staffDepartments.join(", ")})` : ""}`,
    ],
    ["Reporting period", p.period.label],
    [
      "Generated",
      new Date(p.generatedAt).toLocaleString("en-GB", { timeZone: "Africa/Lagos" }) + " (WAT)",
    ],
  ];
  const boxH = rows.length * 20 + 18;
  doc.rect(M, y, CW, boxH).fill(LIGHT);
  rows.forEach(([k, v], i) => {
    const ry = y + 12 + i * 20;
    doc.font("bold").fontSize(8.5).fillColor(PURPLE).text(k.toUpperCase(), M + 14, ry, {
      lineBreak: false,
    });
    doc
      .font("reg")
      .fontSize(9)
      .fillColor(INK)
      .text(fit(doc, v, CW - 144), M + 130, ry - 0.5, { lineBreak: false });
  });
  doc.y = y + boxH;
  doc.x = M;
}

// 3-per-row metric boxes.
function metrics(doc: PDFKit.PDFDocument, p: StaffReportPayload) {
  const s = p.summary;
  const cells: { value: string; label: string }[] = [
    { value: String(s.tasks.completedInMonth), label: "Tasks completed" },
    { value: String(s.tasks.openTouchedInMonth), label: "Tasks open" },
    { value: `${s.completionRate}%`, label: "Completion rate" },
    { value: String(s.tasks.overdue), label: "Overdue" },
    { value: String(s.issues.completedInMonth), label: "Issues closed" },
    { value: String(s.issues.overdue), label: "Issues overdue" },
    { value: String(p.commits.length), label: "Git commits" },
    { value: String(s.activityEvents), label: "Activity events" },
  ];
  const rows = Math.ceil(cells.length / 3);
  need(doc, rows * 52 + 8);
  doc.moveDown(0.5);
  const gap = 10;
  const bw = (CW - 2 * gap) / 3;
  const y0 = doc.y; // freeze the baseline — doc.text would otherwise advance it
  cells.forEach((c, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = M + col * (bw + gap);
    const y = y0 + row * 52;
    doc.rect(x, y, bw, 44).fill("#faf8fb");
    doc.roundedRect(x, y, bw, 44, 3).lineWidth(1).strokeColor(RULE).stroke();
    doc.font("bold").fontSize(16).fillColor(INK).text(c.value, x + 12, y + 8, { lineBreak: false });
    doc
      .font("bold")
      .fontSize(6.8)
      .fillColor(GREY)
      .text(c.label.toUpperCase(), x + 12, y + 29, { lineBreak: false });
  });
  doc.y = y0 + rows * 52 + 6;
  doc.x = M;
}

// Manually truncate to fit a fixed column — `lineBreak: false` disables
// pdfkit's own width handling, so a long title would otherwise wrap onto the
// next row. Draw with the returned string and no width.

// A table of tasks or issues: status chip | title | priority/severity | due.
function itemTable(doc: PDFKit.PDFDocument, rows: ReportRow[], type: "task" | "issue") {
  const dueX = W - M - 62;
  const priX = W - M - 148;
  const titleX = M + 96;

  need(doc, 24);
  doc.moveDown(0.4);
  const hy = doc.y;
  doc.font("bold").fontSize(7.5).fillColor(FAINT);
  doc.text("STATUS", M, hy, { lineBreak: false });
  doc.text(type === "task" ? "TASK" : "ISSUE", titleX, hy, { lineBreak: false });
  doc.text(type === "task" ? "PRIORITY" : "SEVERITY", priX, hy, { lineBreak: false });
  doc.text("DUE", dueX, hy, { lineBreak: false });
  doc.moveTo(M, hy + 12).lineTo(W - M, hy + 12).lineWidth(0.8).strokeColor(RULE).stroke();
  doc.y = hy + 16;

  if (!rows.length) {
    doc
      .font("reg")
      .fontSize(8.5)
      .fillColor(FAINT)
      .text(`No ${type}s in this period for this staff member.`, M, doc.y);
    doc.moveDown(0.4);
    return;
  }

  for (const r of rows) {
    need(doc, 26);
    const y = doc.y;
    const st = STATUS_STYLES[r.status] ?? FALLBACK_STYLE;
    const tag = type === "task" ? st : (r.severity ? SEVERITY_STYLES[r.severity] : undefined) ?? st;
    chip(doc, M, y + 2, (r.overdue ? "Overdue · " : "") + tag.label, tag.fg, tag.bg);
    doc
      .font("reg")
      .fontSize(8.8)
      .fillColor(INK)
      .text(fit(doc, r.title, priX - titleX - 12), titleX, y + 1, { lineBreak: false });
    doc.font("reg").fontSize(8).fillColor(GREY);
    doc.text(type === "task" ? r.priority : (r.severity ?? r.priority), priX, y + 1.5, {
      lineBreak: false,
    });
    doc.text(
      r.dueDate
        ? new Date(r.dueDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
        : "—",
      dueX,
      y + 1.5,
      { lineBreak: false },
    );
    doc.moveTo(M, y + 18).lineTo(W - M, y + 18).lineWidth(0.5).strokeColor("#efe6f2").stroke();
    doc.y = y + 22;
  }
}

function timeline(doc: PDFKit.PDFDocument, entries: TimelineEntry[]) {
  need(doc, 40);
  doc.moveDown(0.4);
  if (!entries.length) {
    doc
      .font("reg")
      .fontSize(8.5)
      .fillColor(FAINT)
      .text("No recorded activity in this period.", M, doc.y);
    return;
  }
  for (const e of entries) {
    need(doc, 24);
    const y = doc.y;
    const when = new Date(e.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    doc.font("bold").fontSize(7.5).fillColor(PURPLE).text(when, M, y + 1, { lineBreak: false });
    const verb =
      e.kind === "status_changed"
        ? `moved to ${e.to ?? "?"}`
        : e.kind === "assigned"
          ? "assigned"
          : e.kind === "created"
            ? "created"
            : e.kind === "commented"
              ? "commented on"
              : e.kind.replace(/_/g, " ");
    const who = e.actor ?? "System";
    doc
      .font("reg")
      .fontSize(8.6)
      .fillColor(INK)
      .text(fit(doc, `${who} ${verb}: ${e.itemTitle}`, CW - 52), M + 52, y, { lineBreak: false });
    doc.y = y + 14;
  }
}

// The AI-written overview (GLM 5.3 flash, high reasoning). Skipped entirely
// when the narrative is unavailable.
function overview(doc: PDFKit.PDFDocument, p: StaffReportPayload) {
  const text = (p.narrative ?? "").trim();
  if (!text) return;
  need(doc, 80);
  h1(doc, "Overview");
  for (const paraText of text.split(/\n\s*\n/)) {
    need(doc, 50);
    doc
      .font("reg")
      .fontSize(9.5)
      .fillColor(INK)
      .text(paraText.trim(), M, doc.y, { width: CW, lineGap: 3 });
    doc.moveDown(0.3);
  }
}

// The staff member's commits across every repo linked to the project.
function commitsSection(doc: PDFKit.PDFDocument, p: StaffReportPayload) {
  h1(
    doc,
    `GitHub commits: ${p.commits.length} across ${p.commitRepos.length} ${
      p.commitRepos.length === 1 ? "repo" : "repos"
    }`,
  );
  if (!p.commits.length) {
    doc
      .font("reg")
      .fontSize(8.5)
      .fillColor(FAINT)
      .text(
        `No commits matched ${p.staff.name} in ${p.period.label} across the project's linked repos.`,
        M,
        doc.y,
      );
    return;
  }
  const shown = p.commits.slice(0, 40);
  let y = doc.y;
  for (const { repo, count } of p.commitRepos) {
    doc.y = y; // keep the cursor in sync so need() sees the real position
    need(doc, 40);
    y = doc.y;
    doc.font("bold").fontSize(9).fillColor(PURPLE).text(`${repo} (${count})`, M, y, {
      lineBreak: false,
    });
    y += 16;
    for (const c of shown.filter((x) => x.repo === repo)) {
      doc.y = y;
      need(doc, 18);
      y = doc.y; // fresh top-margin if a page break just happened
      const when = c.date
        ? new Date(c.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
        : "";
      doc.font("reg").fontSize(7.5).fillColor(FAINT).text(`${when}  ${c.sha}`, M + 4, y, {
        lineBreak: false,
      });
      doc
        .font("reg")
        .fontSize(8.6)
        .fillColor(INK)
        .text(fit(doc, c.message, CW - 92), M + 88, y, { lineBreak: false });
      y += 13;
    }
    y += 6;
  }
  doc.y = y;
  const more = p.commits.length - shown.length;
  if (more > 0) {
    doc
      .font("reg")
      .fontSize(7.4)
      .fillColor(FAINT)
      .text(`Plus ${more} older commit${more === 1 ? "" : "s"} not listed here.`, M, doc.y);
  }
}

export async function renderStaffReportPdf(p: StaffReportPayload): Promise<RenderedPdf> {
  const docTitle = `Staff Monthly Report: ${p.staff.name}, ${p.period.label}`;
  const { doc, chunks } = createDoc(docTitle);

  letterhead(doc);
  cover(doc, p);
  overview(doc, p);

  h1(doc, "Summary");
  metrics(doc, p);

  h1(
    doc,
    `Tasks: ${p.summary.tasks.completedInMonth} completed, ${p.summary.tasks.openTouchedInMonth} open`,
  );
  itemTable(doc, p.tasks, "task");

  h1(
    doc,
    `Issues: ${p.summary.issues.completedInMonth} closed, ${p.summary.issues.openTouchedInMonth} open`,
  );
  itemTable(doc, p.issues, "issue");

  commitsSection(doc, p);

  h1(doc, "Activity timeline");
  timeline(doc, p.timeline);

  doc.moveDown(0.6);
  doc
    .font("reg")
    .fontSize(7.4)
    .fillColor(FAINT)
    .text(
      `Compiled from the MyBizPush Dev Space database on ${new Date(p.generatedAt).toLocaleDateString(
        "en-GB",
        { day: "numeric", month: "long", year: "numeric" },
      )}. Tasks and issues are those currently assigned to ${p.staff.name} on ${p.project.name}; "completed in month" reflects recorded status changes to Done during ${p.period.label}. Commits are matched across the project's linked GitHub repos by the staff member's linked GitHub account, git author email or author name. Where the record is empty, this report says so rather than filling the gap.`,
      M,
      doc.y,
      { width: CW, lineGap: 1.5 },
    );

  decorate(doc, docTitle);
  const buffer = await finish(doc, chunks);
  const slug = (s: string) =>
    s
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  const filename = `MyBizPush-Staff-Report-${slug(p.project.name)}-${slug(p.staff.name)}-${p.month}.pdf`;
  return { buffer, filename };
}