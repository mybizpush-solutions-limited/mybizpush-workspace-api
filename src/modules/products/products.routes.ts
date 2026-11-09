import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { PRODUCT_STAGES } from "../../models";
import { productsService } from "./products.service";

export const productsRouter = Router();
productsRouter.use(requireAuth);

const tint = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #F5ECE4");

const blankIsNull = (v: unknown) => (typeof v === "string" && !v.trim() ? null : v);
const senderFields = {
  senderName: z.preprocess(blankIsNull, z.string().trim().max(120).nullable().optional()),
  senderEmail: z.preprocess(blankIsNull, z.string().trim().toLowerCase().email().max(254).nullable().optional()),
};

const createSchema = z.object({
  ...senderFields,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).optional(),
  stage: z.enum(PRODUCT_STAGES).optional(),
  ownerId: z.string().uuid().optional(),
  tint: tint.optional(),
  projectIds: z.array(z.string().uuid()).max(100).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(400).optional(),
  stage: z.enum(PRODUCT_STAGES).optional(),
  ownerId: z.string().uuid().optional(),
  tint: tint.nullable().optional(),
  logoUrl: z.string().url().nullable().optional(),
  ...senderFields,
});

const projectsSchema = z.object({ projectIds: z.array(z.string().uuid()).min(1).max(100) });
const membersSchema = z.object({
  members: z.array(z.object({ userId: z.string().uuid(), title: z.string().trim().max(80).optional() })).min(1).max(200),
});

productsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const products = req.query.mine === "true" ? await productsService.forUser(req.auth!.sub) : await productsService.list();
    res.json({ products });
  }),
);

productsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const [product, summary] = await Promise.all([productsService.byId(req.params.id!), productsService.summary(req.params.id!)]);
    res.json({ product, summary });
  }),
);

productsRouter.post(
  "/",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const product = await productsService.create(req.body, req.auth!);
    await audit({ req, action: "product.create", target: { type: "product", id: product.id }, after: { name: product.name, ownerId: product.ownerId, projectIds: product.projectIds, senderName: product.senderName, senderEmail: product.senderEmail } });
    res.status(201).json({ product });
  }),
);

productsRouter.patch(
  "/:id",
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const { before, after } = await productsService.update(req.params.id!, req.body, req.auth!);
    await audit({
      req,
      action: "product.update",
      target: { type: "product", id: after.id },
      before: { name: before.name, stage: before.stage, ownerId: before.ownerId, senderName: before.senderName, senderEmail: before.senderEmail },
      after: { name: after.name, stage: after.stage, ownerId: after.ownerId, senderName: after.senderName, senderEmail: after.senderEmail },
    });
    res.json({ product: after });
  }),
);

productsRouter.post(
  "/:id/projects",
  validateBody(projectsSchema),
  asyncHandler(async (req, res) => {
    const product = await productsService.linkProjects(req.params.id!, req.body.projectIds, req.auth!);
    await audit({ req, action: "product.projects.link", target: { type: "product", id: product.id }, after: { projectIds: req.body.projectIds } });
    res.json({ product });
  }),
);

productsRouter.delete(
  "/:id/projects/:projectId",
  asyncHandler(async (req, res) => {
    const product = await productsService.unlinkProject(req.params.id!, req.params.projectId!, req.auth!);
    await audit({ req, action: "product.projects.unlink", target: { type: "product", id: product.id }, before: { projectId: req.params.projectId } });
    res.json({ product });
  }),
);

productsRouter.post(
  "/:id/members",
  validateBody(membersSchema),
  asyncHandler(async (req, res) => {
    const product = await productsService.addMembers(req.params.id!, req.body.members, req.auth!);
    await audit({ req, action: "product.members.add", target: { type: "product", id: product.id }, scope: { type: "product", id: product.id }, after: { members: req.body.members } });
    res.json({ product });
  }),
);

productsRouter.delete(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    const product = await productsService.removeMember(req.params.id!, req.params.userId!, req.auth!);
    await audit({ req, action: "product.members.remove", target: { type: "user", id: req.params.userId }, scope: { type: "product", id: product.id } });
    res.json({ product });
  }),
);
