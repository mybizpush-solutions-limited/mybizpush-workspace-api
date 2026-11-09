import { Router, type Request } from "express";
import multer from "multer";
import { Op } from "sequelize";
import { z } from "zod";
import { env } from "../../config/env";
import { audit } from "../../lib/audit";
import { uploadBuffer } from "../../lib/cloudinary";
import { AppError, asyncHandler, badRequest, forbidden, notFound } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { BlacklistedEmail, User, isOrgManager, type OrganizationSetting } from "../../models";
import { can } from "../access/engine";
import { SENDER_DOMAIN_ERROR, senderDomainAllowed } from "../marketing/campaign.render";
import { loadSettings } from "./organization.service";

// Organization settings and blocked emails (API-CHANGES A903, A904).
export const organizationRouter = Router();
organizationRouter.use(requireAuth);

// The stored access level decides, not the one in the token, which can be minutes old.
async function assertAdmin(req: Request): Promise<void> {
  const userId = req.auth!.sub;
  if (await can({ sub: userId }, "role.manage")) return;
  const me = await User.findByPk(userId, { attributes: ["accessLevel"] });
  if (!me || !isOrgManager(me.accessLevel)) throw forbidden("You don't have permission to change organization settings");
}

const serialize = (s: OrganizationSetting) => ({
  senderName: s.senderName?.trim() || env.ORG_SENDER_NAME,
  senderEmail: s.senderEmail?.trim() || env.ORG_SENDER_EMAIL,
  name: s.name,
  logoUrl: s.logoUrl ?? null,
  timezone: s.timezone,
  workingDays: s.workingDays,
  emailDomain: env.ALLOWED_EMAIL_DOMAIN, // read only, from config
  updatedAt: s.updatedAt.toISOString(),
});

function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

organizationRouter.get("/settings", asyncHandler(async (_req, res) => {
  res.json({ settings: serialize(await loadSettings()) });
}));

organizationRouter.patch(
  "/settings",
  validateBody(
    z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        logoUrl: z.string().url().max(2000).nullable().optional(),
        timezone: z.string().trim().max(60).refine(isTimezone, "Not a known time zone").optional(),
        workingDays: z.array(z.number().int().min(0).max(6)).max(7).transform((d) => [...new Set(d)].sort()).optional(),
        senderName: z.string().trim().min(1).max(120).optional(),
        senderEmail: z.string().trim().toLowerCase().email().max(254).optional(),
      })
      .strict(), // emailDomain comes from config, so sending it is a mistake to report
  ),
  asyncHandler(async (req, res) => {
    await assertAdmin(req);
    if (req.body.senderEmail && !senderDomainAllowed(req.body.senderEmail, env.MARKETING_ALLOWED_FROM_DOMAINS)) {
      throw new AppError(400, `Campaigns can't send from ${req.body.senderEmail}. Use an allowed domain.`, SENDER_DOMAIN_ERROR);
    }
    const row = await loadSettings();
    const before = serialize(row);
    await row.update({ ...req.body, updatedBy: req.auth!.sub });
    await audit({ req, action: "organization.settings.update", target: { type: "organization" }, before, after: serialize(row) });
    res.json({ settings: serialize(row) });
  }),
);

const LOGO_TYPES = [".png", ".jpg", ".jpeg", ".webp"];
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// Permission comes before the upload is even looked at.
organizationRouter.post(
  "/logo",
  asyncHandler(async (req, _res, next) => {
    await assertAdmin(req);
    next();
  }),
  logoUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("An image is required (multipart field 'file')");
    const name = req.file.originalname.toLowerCase();
    if (!LOGO_TYPES.some((t) => name.endsWith(t))) throw badRequest(`The logo must be one of: ${LOGO_TYPES.join(", ")}`);
    const uploaded = await uploadBuffer(req.file.buffer, { folder: `${env.CLOUDINARY_UPLOAD_FOLDER}/organization`, resourceType: "image", tags: ["organization-logo"], publicId: "logo" });
    const row = await loadSettings();
    await row.update({ logoUrl: uploaded.secure_url, updatedBy: req.auth!.sub });
    await audit({ req, action: "organization.logo.update", target: { type: "organization" }, after: { logoUrl: uploaded.secure_url } });
    res.json({ settings: serialize(row) });
  }),
);

// ---- Blocked emails -----------------------------------------------------------
const serializeBlocked = (b: BlacklistedEmail) => ({ id: b.id, email: b.email, reason: b.reason ?? null, createdAt: b.createdAt.toISOString() });

organizationRouter.get("/blocked-emails", asyncHandler(async (req, res) => {
  await assertAdmin(req);
  const q = z.object({ q: z.string().trim().max(254).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() }).parse(req.query);
  const { rows, count } = await BlacklistedEmail.findAndCountAll({
    where: q.q ? { email: { [Op.iLike]: `%${q.q.replace(/[%_]/g, (c) => `\\${c}`)}%` } } : {},
    order: [["createdAt", "DESC"]],
    limit: q.limit ?? 50,
    offset: q.offset ?? 0,
  });
  res.json({ blockedEmails: rows.map(serializeBlocked), total: count });
}));

organizationRouter.post(
  "/blocked-emails",
  validateBody(z.object({ email: z.string().trim().toLowerCase().email().max(254), reason: z.string().trim().max(240).optional() })),
  asyncHandler(async (req, res) => {
    await assertAdmin(req);
    const existing = await BlacklistedEmail.findOne({ where: { email: req.body.email } });
    if (existing) throw new AppError(409, "That address is already blocked", "already_blocked");
    const row = await BlacklistedEmail.create({ email: req.body.email, reason: req.body.reason ?? null });
    await audit({ req, action: "blocked_email.add", target: { type: "blocked_email", id: row.id }, after: { email: row.email, reason: row.reason ?? null } });
    res.status(201).json({ blockedEmail: serializeBlocked(row) });
  }),
);

organizationRouter.delete("/blocked-emails/:id", asyncHandler(async (req, res) => {
  await assertAdmin(req);
  const row = await BlacklistedEmail.findByPk(req.params.id!);
  if (!row) throw notFound("That entry no longer exists");
  await row.destroy();
  await audit({ req, action: "blocked_email.remove", target: { type: "blocked_email", id: row.id }, before: { email: row.email, reason: row.reason ?? null } });
  res.status(204).end();
}));

// ---- Minimum client version (SYS-18). Public: the app checks before sign-in. ----
export const metaRouter = Router();
metaRouter.get("/client", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    minVersion: env.CLIENT_MIN_VERSION,
    latestVersion: env.CLIENT_LATEST_VERSION,
    updateUrl: { ios: env.CLIENT_UPDATE_URL_IOS, android: env.CLIENT_UPDATE_URL_ANDROID },
  });
});
