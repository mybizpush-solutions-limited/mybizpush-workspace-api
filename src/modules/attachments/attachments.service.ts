import { Op } from "sequelize";
import { Attachment, type RecordType } from "../../models";
import { forbidden, notFound } from "../../lib/errors";
import { env } from "../../config/env";
import {
  ALLOWED_ATTACHMENT_EXTENSIONS,
  MAX_ATTACHMENT_MB,
  destroyAsset,
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

// Files on these belong to a private record. Its own endpoints decide who sees
// them; here, knowing the record's id isn't enough.
const PRIVATE_TYPES: RecordType[] = ["message", "query"];

export const attachmentsService = {
  async forItem(itemId: string, viewerId: string) {
    const rows = await Attachment.findAll({
      where: { itemId, [Op.or]: [{ itemType: { [Op.notIn]: PRIVATE_TYPES } }, { uploadedBy: viewerId }] },
      order: [["createdAt", "DESC"]],
    });
    return rows.map(serializeAttachment);
  },

  // Validate → upload to a per-item Cloudinary folder → persist the record.
  // If the DB write fails, the uploaded asset is cleaned up (hyparrow pattern).
  async create(input: { itemId: string; itemType: RecordType; file: UploadFile; uploaderId: string }) {
    const { file, itemId, itemType, uploaderId } = input;
    validateFileType(file.originalname, ALLOWED_ATTACHMENT_EXTENSIONS);
    validateFileSize(file.size, MAX_ATTACHMENT_MB);

    const folder = `${env.CLOUDINARY_UPLOAD_FOLDER}/${itemType}s/${itemId}`;
    const result = await uploadBuffer(file.buffer, {
      folder,
      resourceType: "auto",
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
      });
      return serializeAttachment(attachment);
    } catch (err) {
      await destroyAsset(result.public_id, (result.resource_type as ResourceType) ?? "image").catch(
        () => undefined,
      );
      throw err;
    }
  },

  async remove(id: string, viewerId: string) {
    const attachment = await Attachment.findByPk(id);
    if (!attachment) throw notFound("Attachment not found");
    if (PRIVATE_TYPES.includes(attachment.itemType) && attachment.uploadedBy !== viewerId) throw forbidden("You can't remove this file");
    if (attachment.publicId) {
      await destroyAsset(attachment.publicId, resourceTypeForMime(attachment.type)).catch(
        () => undefined,
      );
    }
    await attachment.destroy();
  },
};
