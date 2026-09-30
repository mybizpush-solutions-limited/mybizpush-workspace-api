import { env } from "../../config/env";
import { destroyAsset, uploadBuffer, type ResourceType } from "../../lib/cloudinary";
import { notFound } from "../../lib/errors";
import { Report } from "../../models";
import { staffReportService, type StaffReportPayload } from "./staffReport.service";
import { renderStaffReportPdf } from "./staffReportPdf";

function serializeReport(r: Report) {
  return {
    id: r.id,
    projectId: r.projectId,
    userId: r.userId,
    month: r.month,
    kind: r.kind,
    name: r.name,
    type: r.type,
    size: Number(r.size),
    url: r.url,
    generatedById: r.generatedById,
    createdAt: r.createdAt,
  };
}

export const reportsService = {
  // JSON payload for an in-app preview of the staff monthly report.
  staff: (projectId: string, userId: string, month: string): Promise<StaffReportPayload> =>
    staffReportService.build(projectId, userId, month),

  // Render the letterheaded PDF without persisting anything.
  async staffPdf(projectId: string, userId: string, month: string) {
    const payload = await staffReportService.build(projectId, userId, month);
    return renderStaffReportPdf(payload);
  },

  // Render the PDF, upload it to Cloudinary and persist a Report row. Mirrors
  // the attachments service: if the DB write fails, the uploaded asset is
  // cleaned up.
  async saveStaff(projectId: string, userId: string, month: string, generatedById: string) {
    const payload = await staffReportService.build(projectId, userId, month);
    if (!payload.tasks.length && !payload.issues.length && !payload.timeline.length) {
      throw notFound(
        `No work recorded for this staff member on this project in ${payload.period.label}`,
      );
    }
    const { buffer, filename } = await renderStaffReportPdf(payload);

    const result = await uploadBuffer(buffer, {
      folder: `${env.CLOUDINARY_UPLOAD_FOLDER}/reports/${projectId}`,
      resourceType: "auto",
      tags: ["report", projectId, userId, month, generatedById],
      filename,
    });

    try {
      const row = await Report.create({
        projectId,
        userId,
        month,
        kind: "staff",
        name: filename,
        type: "application/pdf",
        size: buffer.length,
        url: result.secure_url,
        publicId: result.public_id,
        generatedById,
      });
      return serializeReport(row);
    } catch (err) {
      await destroyAsset(result.public_id, (result.resource_type as ResourceType) ?? "raw").catch(
        () => undefined,
      );
      throw err;
    }
  },

  // Saved report snapshots for a project, newest first.
  async listSaved(projectId: string) {
    const rows = await Report.findAll({
      where: { projectId },
      order: [["createdAt", "DESC"]],
    });
    return rows.map(serializeReport);
  },
};