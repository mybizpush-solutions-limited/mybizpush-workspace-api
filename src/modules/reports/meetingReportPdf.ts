import type { MeetingReportData } from "./meetingReport.service";
import {
  confidentialChip,
  createDoc,
  CW,
  decorate,
  FAINT,
  finish,
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

// Renders a meeting report (generated from a transcript) as an A4 PDF in
// MyBizPush house branding. No watermark (it is a report, not a record of
// proceedings for circulation), but prominently marked Internal &
// Confidential: the cover chip plus the standard footer on every page.

function cover(doc: PDFKit.PDFDocument, data: MeetingReportData) {
  doc.moveDown(0.8);
  const eyebrowY = doc.y;
  doc
    .font("bold")
    .fontSize(8.5)
    .fillColor(PURPLE)
    .text("M E E T I N G   R E P O R T", M, eyebrowY, { lineBreak: false });
  confidentialChip(doc, W - M - doc.widthOfString("INTERNAL & CONFIDENTIAL") - 10, eyebrowY - 3);
  doc.moveDown(0.7);
  doc.font("bold").fontSize(21).fillColor(INK).text(data.title, M, doc.y, { width: CW });
  doc
    .font("reg")
    .fontSize(10.5)
    .fillColor(GREY)
    .text(data.date ? data.date : "Meeting report from transcript", M, doc.y + 4);

  need(doc, 130);
  doc.moveDown(0.6);
  const attendees = data.attendees.length
    ? data.attendees.join(", ")
    : "Attendees not identified in the transcript";
  const rows: [string, string][] = [
    ["Meeting", data.title],
    ["Date", data.date || "Not stated"],
    ["Attendees", attendees],
    [
      "Generated",
      new Date(data.generatedAt).toLocaleString("en-GB", { timeZone: "Africa/Lagos" }) + " (WAT)",
    ],
  ];
  // Values wrap within the box instead of being truncated with an ellipsis —
  // an attendee cut off mid-name defeats the purpose of the list. The box grows
  // to fit the tallest wrapped value.
  const valueX = M + 96;
  const valueW = CW - 96 - 14;
  doc.font("reg").fontSize(9);
  const heights = rows.map(([, v]) =>
    Math.max(doc.heightOfString(v, { width: valueW, lineGap: 2 }), 11),
  );
  const boxH = heights.reduce((acc, h) => acc + h + 10, 8);
  need(doc, boxH + 10);
  const by = doc.y;
  doc.rect(M, by, CW, boxH).fill(LIGHT);
  let ry = by + 8;
  rows.forEach(([k, v], i) => {
    doc.font("bold").fontSize(8.5).fillColor(PURPLE).text(k.toUpperCase(), M + 14, ry, {
      lineBreak: false,
    });
    doc
      .font("reg")
      .fontSize(9)
      .fillColor(INK)
      .text(v, valueX, ry - 0.5, { width: valueW, lineGap: 2 });
    ry += heights[i]! + 10;
  });
  doc.y = by + boxH;
  doc.x = M;
}

function paragraphs(doc: PDFKit.PDFDocument, items: string[]) {
  for (const p of items) {
    need(doc, 50);
    doc.font("reg").fontSize(9.5).fillColor(INK).text(p.trim(), M, doc.y, { width: CW, lineGap: 3 });
    doc.moveDown(0.3);
  }
}

function numbered(doc: PDFKit.PDFDocument, items: string[]) {
  for (let i = 0; i < items.length; i++) {
    need(doc, 30);
    const y = doc.y;
    doc.font("bold").fontSize(9).fillColor(PURPLE).text(`${i + 1}.`, M, y, { lineBreak: false });
    doc
      .font("reg")
      .fontSize(9.5)
      .fillColor(INK)
      .text(items[i]!.trim(), M + 18, y, { width: CW - 18, lineGap: 2.5 });
  }
}

// Action points table: # | action | owner | due. Every column wraps within its
// own fixed width — nothing is truncated, and rows grow to fit the tallest
// column so text can never collide with a neighbouring column or the next row.
function actionTable(doc: PDFKit.PDFDocument, items: MeetingReportData["actionItems"]) {
  const dueW = 104;
  const ownerW = 132;
  const dueX = W - M - dueW;
  const ownerX = dueX - ownerW;
  const actionX = M + 22;
  const actionW = ownerX - actionX - 14;

  need(doc, 30);
  const hy = doc.y;
  doc.font("bold").fontSize(7.5).fillColor(FAINT);
  doc.text("#", M, hy, { lineBreak: false });
  doc.text("ACTION", actionX, hy, { lineBreak: false });
  doc.text("OWNER", ownerX, hy, { lineBreak: false });
  doc.text("DUE", dueX, hy, { lineBreak: false });
  doc.moveTo(M, hy + 12).lineTo(W - M, hy + 12).lineWidth(0.8).strokeColor(RULE).stroke();
  let y = hy + 16;

  if (!items.length) {
    doc
      .font("reg")
      .fontSize(8.5)
      .fillColor(FAINT)
      .text("No action points were recorded in the transcript.", M, y);
    return;
  }

  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    const actionText = a.action.trim();
    const ownerText = a.owner || "Unassigned";
    const dueText = a.due || "—";
    // Measure every column's wrapped height at its final width up front, so the
    // whole row can be kept together on one page.
    doc.font("reg").fontSize(8.8);
    const actionH = doc.heightOfString(actionText, { width: actionW, lineGap: 1.5 });
    doc.font("reg").fontSize(8.4);
    const ownerH = doc.heightOfString(ownerText, { width: ownerW - 8, lineGap: 1 });
    const dueH = doc.heightOfString(dueText, { width: dueW, lineGap: 1 });
    const rowH = Math.max(24, actionH, ownerH + 3, dueH + 3) + 8;

    doc.y = y;
    need(doc, rowH);
    y = doc.y;

    doc
      .font("bold")
      .fontSize(9)
      .fillColor(PURPLE)
      .text(String(i + 1), M, y + 1, { lineBreak: false });
    doc
      .font("reg")
      .fontSize(8.8)
      .fillColor(INK)
      .text(actionText, actionX, y, { width: actionW, lineGap: 1.5 });
    doc
      .font("reg")
      .fontSize(8.4)
      .fillColor(GREY)
      .text(ownerText, ownerX, y + 1, { width: ownerW - 8, lineGap: 1 });
    doc
      .font("reg")
      .fontSize(8.4)
      .fillColor(GREY)
      .text(dueText, dueX, y + 1, { width: dueW, lineGap: 1 });
    doc.moveTo(M, y + rowH - 4).lineTo(W - M, y + rowH - 4).lineWidth(0.5).strokeColor("#efe6f2").stroke();
    y += rowH;
  }
  doc.y = y;
}

export async function renderMeetingReportPdf(
  data: MeetingReportData,
  sourceName: string,
): Promise<RenderedPdf> {
  const docTitle = `Meeting Report: ${data.title}`;
  const { doc, chunks } = createDoc(docTitle);

  letterhead(doc);
  cover(doc, data);

  if (data.summary.length) {
    h1(doc, "Summary of proceedings");
    paragraphs(doc, data.summary);
  }

  for (const s of data.sections) {
    h1(doc, s.heading);
    paragraphs(doc, s.paragraphs);
  }

  if (data.decisions.length) {
    h1(doc, "Decisions taken");
    numbered(doc, data.decisions);
  }

  h1(doc, "Action points");
  actionTable(doc, data.actionItems);

  doc.moveDown(0.6);
  doc
    .font("reg")
    .fontSize(7.4)
    .fillColor(FAINT)
    .text(
      `Compiled from the uploaded transcript (${sourceName}) on ${new Date(
        data.generatedAt,
      ).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}. This report reflects what the transcript contains; where the record is silent, the report says so rather than filling the gap. Internal & Confidential: circulation is limited to MyBizPush staff named in the document.`,
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
  const filename = `MyBizPush-Meeting-Report-${slug(data.title)}.pdf`;
  return { buffer, filename };
}