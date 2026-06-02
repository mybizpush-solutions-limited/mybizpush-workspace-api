import { Router } from "express";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { Label } from "../../models";
import { serializeLabel } from "../shared/serializers";

export const labelsRouter = Router();
labelsRouter.use(requireAuth);

labelsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const labels = await Label.findAll({ order: [["name", "ASC"]] });
    res.json({ labels: labels.map(serializeLabel) });
  }),
);
