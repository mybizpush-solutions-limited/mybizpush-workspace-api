import { Op } from "sequelize";
import { z } from "zod";
import { env } from "../../config/env";
import { AppError, badRequest, notFound } from "../../lib/errors";
import { uploadBuffer } from "../../lib/cloudinary";
import { chatCompletion } from "../../lib/openrouter";
import { MeetingReport } from "../../models";
import { stripDashes } from "./narrative";
import { renderMeetingReportPdf } from "./meetingReportPdf";

// --------------------------------------------------------------- AI output ---
export interface MeetingReportData {
  title: string;
  date: string;
  attendees: string[];
  absent: string[];
  summary: string[];
  sections: { heading: string; paragraphs: string[] }[];
  decisions: string[];
  actionItems: { action: string; owner: string; due: string }[];
  generatedAt: string;
}

const sectionSchema = z.object({
  heading: z.string().min(1),
  paragraphs: z.array(z.string()).default([]),
});

const dataSchema = z.object({
  title: z.string().min(1).default("Meeting Report"),
  date: z.string().default(""),
  attendees: z.array(z.string()).default([]),
  absent: z.array(z.string()).default([]),
  summary: z.array(z.string()).default([]),
  sections: z.array(sectionSchema).default([]),
  decisions: z.array(z.string()).default([]),
  actionItems: z
    .array(
      z.object({
        action: z.string().min(1),
        owner: z.string().default(""),
        due: z.string().default(""),
      }),
    )
    .default([]),
});

// The model sometimes wraps JSON in a code fence or adds prose around it; dig
// out the outermost object before parsing.
function parseJsonLoose(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(text.slice(start, end + 1));
}

const SYSTEM = `You are the company secretary of MyBizPush Solutions Limited, an Abuja-based software company. You turn raw meeting transcripts into structured meeting reports.

You will be given the transcript of an internal MyBizPush meeting. Produce a complete, faithful record of what was discussed, using ONLY what the transcript contains. Do not invent names, numbers or events; where the transcript is unclear or silent, say so.

Return STRICT JSON only (no prose, no markdown fences) with exactly this shape:
{
  "title": "short official meeting title, e.g. 'General Staff Meeting'",
  "date": "meeting date as stated or inferable from the transcript, else ''",
  "attendees": ["names (with roles if stated) of everyone present"],
  "absent": ["names of people noted as absent or apologised"],
  "summary": ["2 to 4 plain paragraphs summarising the meeting"],
  "sections": [{"heading": "agenda item / discussion theme", "paragraphs": ["what was discussed, decided, debated and by whom"]}],
  "decisions": ["each decision taken, one per entry, stated plainly"],
  "actionItems": [{"action": "what must be done", "owner": "who is responsible, else ''", "due": "deadline if stated, else ''"}]
}

Rules:
- "sections" must cover EVERYTHING discussed, agenda item by agenda item, in order. Do not omit any topic, however minor.
- Capture who said what where it matters (attributions like "the COO noted...").
- Keep recorded figures exactly as stated in the transcript; mark inaudible or unclear figures as [confirm].
- Use no em dashes and no en dashes anywhere in the output. Use commas, colons or full stops instead.
- Output must be valid JSON (escape quotes properly).`;

// --------------------------------------------------------------- service -----
const MAX_TRANSCRIPT_CHARS = 200_000;

// Transcript text → model → validated, dash-free data → rendered PDF buffer.
// Split out from `create` so scripts can exercise generation without the
// database/Cloudinary round-trip.
export async function draftMeetingReport(
  transcript: string,
  originalname: string,
): Promise<{ data: MeetingReportData; buffer: Buffer; filename: string }> {
  const clean = transcript.trim();
  if (clean.length < 80) {
    throw badRequest("That file does not look like a meeting transcript");
  }
  // Very long transcripts are truncated; the model is told the record may be
  // partial rather than inventing coverage.
  const clipped = clean.length > MAX_TRANSCRIPT_CHARS;
  const transcriptText = clipped
    ? `${clean.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[TRANSCRIPT TRUNCATED: the remainder was not available to the secretary.]`
    : clean;

  const raw = await chatCompletion(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Meeting transcript follows:\n\n${transcriptText}` },
    ],
    { model: env.OPENROUTER_REPORT_MODEL, temperature: 0.3, reasoningEffort: "high" },
  );

  let data: MeetingReportData;
  try {
    data = dataSchema.parse(parseJsonLoose(raw)) as MeetingReportData;
  } catch (err) {
    throw new AppError(
      502,
      "The model returned an unusable meeting report; try again",
      "openrouter_bad_output",
      String(err).slice(0, 400),
    );
  }

  // House style: no em/en dashes anywhere in the generated document.
  const stripAll = (s: string) => stripDashes(s);
  data = {
    title: stripAll(data.title),
    date: stripAll(data.date),
    attendees: data.attendees.map(stripAll),
    absent: data.absent.map(stripAll),
    summary: data.summary.map(stripAll),
    sections: data.sections.map((s) => ({
      heading: stripAll(s.heading),
      paragraphs: s.paragraphs.map(stripAll),
    })),
    decisions: data.decisions.map(stripAll),
    actionItems: data.actionItems.map((a) => ({
      action: stripAll(a.action),
      owner: stripAll(a.owner),
      due: stripAll(a.due),
    })),
    generatedAt: new Date().toISOString(),
  };

  const { buffer, filename } = await renderMeetingReportPdf(data, originalname);
  return { data, buffer, filename };
}

// ------------------------------------------------- background processing -----
// In-process guard so the fire-and-forget kick and the cron sweeper never
// process the same row twice.
const inFlight = new Set<string>();

function serialize(r: MeetingReport) {
  return {
    id: r.id,
    title: r.title,
    meetingDate: r.meetingDate,
    fileName: r.name,
    type: r.type,
    size: Number(r.size),
    url: r.url,
    status: r.status,
    error: r.error || null,
    processedAt: r.processedAt,
    generatedById: r.generatedById,
    createdAt: r.createdAt,
  };
}

export const meetingReportService = {
  // Accept an uploaded transcript, store it, and hand the row over to
  // background processing. Returns immediately with a pending row; the UI
  // polls the list and the finished report appears when the model is done.
  async create(input: { buffer: Buffer; originalname: string; generatedById: string }) {
    if (!env.OPENROUTER_API_KEY) {
      throw new AppError(503, "OpenRouter is not configured", "openrouter_unconfigured");
    }
    const transcript = input.buffer.toString("utf8").replace(/\r\n/g, "\n").trim();
    if (transcript.length < 80) {
      throw badRequest("That file does not look like a meeting transcript");
    }
    const row = await MeetingReport.create({
      // Provisional title until the model names the meeting properly.
      title: input.originalname.replace(/\.[^.]+$/, "").slice(0, 300) || "Meeting Report",
      transcript,
      sourceName: input.originalname.slice(0, 300),
      status: "pending",
      generatedById: input.generatedById,
    });
    // Fire-and-forget: the sweeper cron covers crash/restart recovery.
    void meetingReportService.process(row.id);
    return serialize(row);
  },

  // Run the generation for one row: transcript → model → PDF → Cloudinary.
  async process(id: string): Promise<void> {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      const row = await MeetingReport.findByPk(id);
      if (!row || row.status === "done" || row.status === "processing") return;
      await row.update({ status: "processing", error: "" });
      if (!env.OPENROUTER_API_KEY) {
        throw new AppError(503, "OpenRouter is not configured", "openrouter_unconfigured");
      }

      const { data, buffer, filename } = await draftMeetingReport(
        row.transcript ?? "",
        row.sourceName || row.name,
      );

      const result = await uploadBuffer(buffer, {
        folder: `${env.CLOUDINARY_UPLOAD_FOLDER}/meeting-reports`,
        resourceType: "auto",
        tags: ["meeting-report", row.generatedById ?? ""],
        filename,
      });

      await row.update({
        title: data.title,
        meetingDate: data.date,
        name: filename,
        type: "application/pdf",
        size: buffer.length,
        url: result.secure_url,
        publicId: result.public_id,
        status: "done",
        error: "",
        processedAt: new Date(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[meeting-reports] processing ${id} failed:`, message);
      await MeetingReport.update(
        { status: "failed", error: message.slice(0, 1000) },
        { where: { id } },
      );
    } finally {
      inFlight.delete(id);
    }
  },

  // Retry a failed report (resets to pending and re-processes).
  async retry(id: string) {
    const row = await MeetingReport.findByPk(id);
    if (!row) throw notFound("Meeting report not found");
    if (row.status !== "failed") throw badRequest("Only a failed report can be retried");
    await row.update({ status: "pending", error: "" });
    void meetingReportService.process(id);
    return serialize(row);
  },

  // Cron sweeper: picks up rows still pending (or stale "processing" after a
  // crash/restart) and processes them — a few per tick at most.
  async processPending(): Promise<number> {
    const staleBefore = new Date(Date.now() - 5 * 60_000);
    const rows = await MeetingReport.findAll({
      where: {
        [Op.or]: [
          { status: "pending" },
          { status: "processing", createdAt: { [Op.lt]: staleBefore } },
        ],
      },
      order: [["createdAt", "ASC"]],
      limit: 5,
    });
    for (const row of rows) await meetingReportService.process(row.id);
    return rows.length;
  },

  // Saved meeting reports, newest first.
  async list() {
    const rows = await MeetingReport.findAll({ order: [["createdAt", "DESC"]] });
    return rows.map(serialize);
  },
};