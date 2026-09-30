import type { MeetingReportData } from "./meetingReport.service";
import {
  confidentialChip,
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
  const y = doc.y;
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
      .text(fit(doc, v, CW - 110), M + 110, ry - 0.5, { lineBreak: false });
  });
  doc.y = y + boxH;
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

// Action points table: # | action | owner | due.
function actionTable(doc: PDFKit.PDFDocument, items: MeetingReportData["actionItems"]) {
  const dueX = W - M - 90;
  const ownerX = W - M - 210;
  const actionX = M + 22;

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
    // Two text lines of room per row; wraps stay inside the row.
    doc.y = y;
    need(doc, 30);
    y = doc.y;
    doc.font("bold").fontSize(9).fillColor(PURPLE).text(String(i + 1), M, y + 1, { lineBreak: false });
    const lines = doc
      .font("reg")
      .fontSize(8.8)
      .fillColor(INK)
      .text(a.action, actionX, y, { width: ownerX - actionX - 12, lineGap: 1.5, height: 26, ellipsis: true });
    void lines;
    doc.font("reg").fontSize(8.4).fillColor(GREY);
    doc.text(fit(doc, a.owner || "Unassigned", ownerX - actionX - 20), ownerX, y + 1, { lineBreak: false });
    doc.text(a.due || "—", dueX, y + 1, { lineBreak: false });
    const rowH = Math.max(24, (doc.y - y) + 8);
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