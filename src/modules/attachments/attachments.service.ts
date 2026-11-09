import { Attachment, type RecordType } from "../../models";
import { forbidden, notFound } from "../../lib/errors";
import { assertCanSeeRecord, canSeeAnyRecord, canSeeRecord, recordExists } from "../access/visibility";
import { env } from "../../config/env";
import {
  ALLOWED_ATTACHMENT_EXTENSIONS,
  MAX_ATTACHMENT_MB,
  destroyAsset,
  fileLink,
  resourceTypeForMime,
  uploadBuffer,
  validateFileSize,
  validateFileType,
  type ResourceType,
} from "../../lib/cloudinary";
import { serializeAttachment } from "../shared/serializers";

interface UploadFile {
  buffer: Buffer;
  originalname: string;
  size: number;
  mimetype: string;
}

// Files people mail out have to work for anyone who opens the email. Everything else
// is delivered only through a link made for someone who can see the record.
export const isPrivateFileType = (itemType: RecordType) => itemType !== "campaign";

// Messages and queries: only the uploader removes a file.
const UPLOADER_ONLY: RecordType[] = ["message", "query"];

// Who may reach a file: anyone who can see its record. A file uploaded ahead of its
// record (a message about to be sent) belongs to its uploader until the record exists.
async function mayReach(a: Attachment, viewerId: string): Promise<boolean> {
  if (await canSeeRecord(viewerId, a.itemType, a.itemId)) return true;
  return a.uploadedBy === viewerId && !(await recordExists(a.itemType, a.itemId));
}

export const attachmentsService = {
  async forItem(itemId: string, viewerId: string) {
    const rows = await Attachment.findAll({ where: { itemId }, order: [["createdAt", "DESC"]] });
    const visible = await canSeeAnyRecord(viewerId, itemId);
    const reachable = visible ? rows : (await Promise.all(rows.map(async (a) => ((await mayReach(a, viewerId)) ? a : null)))).filter((a): a is Attachment => !!a);
    if (!visible && !reachable.length) throw notFound("Not found");
    return reachable.map(serializeAttachment);
  },

  // A fresh link for one file, such as when a stored one has expired.
  async link(id: string, viewerId: string) {
    const a = await Attachment.findByPk(id);
    if (!a || !(await mayReach(a, viewerId))) throw notFound("Attachment not found");
    return { id: a.id, ...fileLink(a) };
  },

  // Validate → upload to a per-item Cloudinary folder → persist the record.
  // If the DB write fails, the uploaded asset is cleaned up (hyparrow pattern).
  async create(input: { itemId: string; itemType: RecordType; file: UploadFile; uploaderId: string }) {
    const { file, itemId, itemType, uploaderId } = input;
    // A record that exists follows its own rule; one about to exist is the uploader's.
    if (await recordExists(itemType, itemId)) await assertCanSeeRecord(uploaderId, itemType, itemId);
    validateFileType(file.originalname, ALLOWED_ATTACHMENT_EXTENSIONS);
    validateFileSize(file.size, MAX_ATTACHMENT_MB);

    const delivery = isPrivateFileType(itemType) ? ("authenticated" as const) : ("upload" as const);
    const folder = `${env.CLOUDINARY_UPLOAD_FOLDER}/${itemType}s/${itemId}`;
    const result = await uploadBuffer(file.buffer, {
      folder,
      resourceType: "auto",
      delivery,
      tags: [itemType, itemId, uploaderId],
      filename: file.originalname,
    });

    try {
      const attachment = await Attachment.create({
        itemId,
        itemType,
        name: file.originalname,
        size: file.size,
        type: file.mimetype,
        url: result.secure_url,
        publicId: result.public_id,
        uploadedBy: uploaderId,
        delivery,
        resourceType: result.resource_type ?? null,
        format: result.format ?? null,
      });
      return serializeAttachment(attachment);
    } catch (err) {
      await destroyAsset(result.public_id, (result.resource_type as ResourceType) ?? "image", delivery).catch(
        () => undefined,
      );
      throw err;
    }
  },

  async remove(id: string, viewerId: string) {
    const attachment = await Attachment.findByPk(id);
    if (!attachment || !(await mayReach(attachment, viewerId))) throw notFound("Attachment not found");
    if (UPLOADER_ONLY.includes(attachment.itemType) && attachment.uploadedBy !== viewerId) throw forbidden("You can't remove this file");
    if (attachment.publicId) {
      const kind = (attachment.resourceType as ResourceType | null) ?? resourceTypeForMime(attachment.type);
      await destroyAsset(attachment.publicId, kind, attachment.delivery === "authenticated" ? "authenticated" : "upload").catch(
        () => undefined,
      );
    }
    await attachment.destroy();
  },
};
