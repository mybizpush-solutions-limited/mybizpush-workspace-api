import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler, badRequest } from "../../../lib/errors";
import { requireAuth } from "../../../middleware/auth";
import { rateLimit } from "../../../middleware/rateLimit";
import { validateBody } from "../../../middleware/validate";
import { commandsService, parseBody } from "./commands.service";
import { MAX_AUDIO_BYTES, transcribe, transcribeAvailable } from "./transcribe";

// /ai/parse, /ai/transcribe, /ai/execute (API-CHANGES A801 to A803). Mounted next to
// the existing assistant routes, which are unchanged.
export const aiCommandsRouter = Router();

// Limited per person, since the costs are per call and staff share office IPs.
const perUser = (name: string, max: number) => rateLimit({ windowSec: 60, max, keyPrefix: name, key: (req) => req.auth?.sub ?? req.ip ?? "unknown" });
const audio = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES } });

aiCommandsRouter.get("/operations", requireAuth, (_req, res) => {
  res.json({ ...commandsService.operations(), transcribeAvailable: transcribeAvailable() });
});

aiCommandsRouter.post("/parse", requireAuth, perUser("ai-parse", 30), validateBody(parseBody), asyncHandler(async (req, res) => {
  res.json({ command: await commandsService.parse(req.body, req.auth!.sub) });
}));

aiCommandsRouter.post("/transcribe", requireAuth, perUser("ai-transcribe", 20), audio.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest("Audio is required (multipart field 'file')");
  const language = typeof req.body.language === "string" && /^[a-zA-Z-]{2,12}$/.test(req.body.language) ? req.body.language : undefined;
  res.json(await transcribe(req.file, { language }));
}));

aiCommandsRouter.post(
  "/execute",
  requireAuth,
  validateBody(z.object({ commandId: z.string().uuid().optional(), operation: z.string().max(40), fields: z.record(z.unknown()), confirmed: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    res.status(201).json(await commandsService.execute(req.body, req.auth!.sub, req));
  }),
);
