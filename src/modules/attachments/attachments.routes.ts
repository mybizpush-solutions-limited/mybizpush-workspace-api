import { Router } from "express";
import multer from "multer";
import { asyncHandler, badRequest } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { MAX_ATTACHMENT_MB } from "../../lib/cloudinary";
import type { ItemType } from "../../models";
import { attachmentsService } from "./attachments.service";

export const attachmentsRouter = Router();
attachmentsRouter.use(requireAuth);

// Files are buffered in memory then streamed to Cloudinary by the service.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_MB * 1024 * 1024 },
});

function parseItem(itemId: unknown, itemType: unknown): { itemId: string; itemType: ItemType } {
  if (typeof itemId !== "string" || !itemId) throw badRequest("itemId is required");
  if (itemType !== "task" && itemType !== "issue") throw badRequest("itemType must be 'task' or 'issue'");
  return { itemId, itemType };
}

attachmentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const itemId = typeof req.query.itemId === "string" ? req.query.itemId : undefined;
    if (!itemId) throw badRequest("itemId query param is required");
    res.json({ attachments: await attachmentsService.forItem(itemId) });
  }),
);

attachmentsRouter.post(
  "/",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("A file is required (multipart field 'file')");
    const { itemId, itemType } = parseItem(req.body.itemId, req.body.itemType);
    const attachment = await attachmentsService.create({
      itemId,
      itemType,
      uploaderId: req.auth!.sub,
      file: {
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      },
    });
    res.status(201).json({ attachment });
  }),
);

attachmentsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await attachmentsService.remove(req.params.id!);
    res.status(204).end();
  }),
);
