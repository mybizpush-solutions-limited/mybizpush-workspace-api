import PDFDocument from "pdfkit";
import path from "node:path";

// Shared MyBizPush PDF chrome: brand assets, colours, page geometry, the
// letterhead, running header, footer, page furniture and small layout helpers.
// The staff report and meeting report renderers both draw on this so every
// generated document carries identical branding.

const API_ROOT = path.resolve(__dirname, "..", "..", "..");
const BRAND = path.join(API_ROOT, "assets", "brand");
export const LOGO = path.join(BRAND, "mybizpush_logo.png");
export const FONT_REG = path.join(BRAND, "Roboto-Regular.ttf");
export const FONT_BOLD = path.join(BRAND, "Roboto-Bold.ttf");

export const PURPLE = "#960095";
export const INK = "#1f2430";
export const GREY = "#5c6473";
export const LIGHT = "#f5eef6";
export const RULE = "#e6d6ea";
export const FAINT = "#8b93a3";

const CRIT = "#9d1f16";
const CRIT_BG = "#fbe9e7";

const M = 56; // page margin
const W = 595.28;
const H = 841.89;
export const CW = W - 2 * M;
const BOT = 76; // content bottom (footer zone below)

export { M, W };

export interface RenderedPdf {
  buffer: Buffer;
  filename: string;
}

export function createDoc(title: string): { doc: PDFKit.PDFDocument; chunks: Buffer[] } {
  const doc = new PDFDocument({
    size: "A4",
    bufferPages: true,
    margins: { top: 104, bottom: BOT, left: M, right: M },
    info: { Title: title, Author: "MyBizPush Solutions Limited" },
  });
  doc.registerFont("reg", FONT_REG);
  doc.registerFont("bold", FONT_BOLD);
  doc.font("reg");
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  return { doc, chunks };
}

export function finish(doc: PDFKit.PDFDocument, chunks: Buffer[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

// Letterhead — page 1 only, drawn as part of the content flow.
export function letterhead(doc: PDFKit.PDFDocument) {
  const top = 72;
  try {
    doc.image(LOGO, M, top - 6, { width: 34 });
  } catch {
    /* logo is decorative — never fail the report over it */
  }
  doc.font("bold").fontSize(16).fillColor(PURPLE).text("MyBizPush Solutions Limited", M + 44, top, {
    lineBreak: false,
  });
  doc
    .font("reg")
    .fontSize(8)
    .fillColor(GREY)
    .text("Innovative Tech Solutions for Your Business", M + 44, top + 19, { lineBreak: false });
  const rc = "RC 7350200";
  doc
    .font("reg")
    .fontSize(8)
    .fillColor(GREY)
    .text(rc, W - M - doc.widthOfString(rc), top + 2, { lineBreak: false });
  doc.moveTo(M, top + 38).lineTo(W - M, top + 38).lineWidth(2).strokeColor(PURPLE).stroke();
  doc
    .font("reg")
    .fontSize(7.5)
    .fillColor(FAINT)
    .text(
      "Suite 300, 3rd Floor, Copper House, Wuse Zone 5, Abuja  ·  info@mybizpush.com.ng  ·  +234 812 313 2609",
      M,
      top + 44,
      { lineBreak: false },
    );
  doc.y = top + 62;
  doc.x = M;
}

// Smaller running header for pages 2+.
export function runningHeader(doc: PDFKit.PDFDocument, docTitle: string) {
  const top = 36;
  doc.save();
  try {
    doc.image(LOGO, M, top - 4, { width: 25 });
  } catch {
    /* decorative */
  }
  doc
    .font("bold")
    .fontSize(11.5)
    .fillColor(PURPLE)
    .text("MyBizPush Solutions Limited", M + 33, top, { lineBreak: false });
  doc
    .font("reg")
    .fontSize(7.5)
    .fillColor(GREY)
    .text(docTitle, M + 33, top + 14, { lineBreak: false });
  const rc = "RC 7350200";
  doc
    .font("reg")
    .fontSize(8)
    .fillColor(GREY)
    .text(rc, W - M - doc.widthOfString(rc), top + 2, { lineBreak: false });
  doc.moveTo(M, top + 30).lineTo(W - M, top + 30).lineWidth(1.4).strokeColor(PURPLE).stroke();
  doc.restore();
}

export function footer(doc: PDFKit.PDFDocument, n: number, total: number) {
  const y = H - 50;
  doc.save();
  doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.8).strokeColor(RULE).stroke();
  doc.font("reg").fontSize(7.2).fillColor(GREY);
  doc.text(
    "Internal & Confidential  ·  Suite 300, 3rd Floor, Copper House, Wuse Zone 5, Abuja  ·  info@mybizpush.com.ng",
    M,
    y + 6,
    { lineBreak: false },
  );
  const pg = `Page ${n} of ${total}`;
  doc.text(pg, W - M - doc.widthOfString(pg), y + 6, { lineBreak: false });
  doc.restore();
}

export function decorate(doc: PDFKit.PDFDocument, docTitle: string) {
  const r = doc.bufferedPageRange();
  for (let i = 0; i < r.count; i++) {
    doc.switchToPage(r.start + i);
    if (i !== 0) runningHeader(doc, docTitle);
    footer(doc, i + 1, r.count);
  }
}

// ------------------------------------------------------------ page elements --
export function need(doc: PDFKit.PDFDocument, h: number) {
  if (doc.y + h > H - BOT) doc.addPage();
}

export function h1(doc: PDFKit.PDFDocument, t: string) {
  if (doc.y > H - BOT - 70) doc.addPage();
  doc.moveDown(0.5);
  const y = doc.y;
  doc.font("bold").fontSize(14.5);
  // The accent bar spans the heading's full wrapped height, so two-line
  // headings don't hang off a fixed-size bar.
  const barH = Math.max(16, doc.heightOfString(t, { width: CW - 12 }));
  doc.rect(M, y + 2, 4, barH).fill(PURPLE);
  doc.fillColor(INK).text(t, M + 12, y, { width: CW - 12 });
  doc.moveDown(0.4);
}

export function chip(doc: PDFKit.PDFDocument, x: number, y: number, text: string, fg: string, bg: string) {
  const w = doc.widthOfString(text) + 10;
  doc.roundedRect(x, y - 3, w, 13, 3).fill(bg);
  doc.font("bold").fontSize(7).fillColor(fg).text(text, x + 5, y, { lineBreak: false });
  return w;
}

export function confidentialChip(doc: PDFKit.PDFDocument, x: number, y: number) {
  return chip(doc, x, y, "INTERNAL & CONFIDENTIAL", CRIT, CRIT_BG);
}

// Manually truncate to fit a fixed column — `lineBreak: false` disables
// pdfkit's own width handling, so a long title would otherwise wrap onto the
// next row. Draw with the returned string and no width.
export function fit(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string {
  if (doc.widthOfString(text) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && doc.widthOfString(t.trimEnd() + "…") > maxWidth) t = t.slice(0, -1);
  return t.trimEnd() + "…";
}