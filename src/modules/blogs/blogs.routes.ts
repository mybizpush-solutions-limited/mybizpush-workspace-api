import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler, badRequest } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { BLOG_EDITOR_ROLES } from "../../models";
import { blogsService } from "./blogs.service";

export const blogsRouter = Router();
blogsRouter.use(requireAuth);

const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const channelSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["hyparrow"]).optional(),
  apiBaseUrl: z.string().trim().url().max(500),
  // Optional on update — omitting it keeps the stored token.
  serviceToken: z.string().trim().min(8).max(500).optional(),
  siteUrl: z.string().trim().url().max(500).or(z.literal("")).optional(),
});

const editorSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(BLOG_EDITOR_ROLES),
});

const postSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  subtitle: z.string().trim().max(500).optional(),
  slug: z
    .string()
    .trim()
    .max(300)
    .regex(/^[a-z0-9-]*$/, "Slug can only contain lowercase letters, numbers and hyphens")
    .optional(),
  content: z.string().max(200_000).optional(),
  imageUrl: z.string().trim().url().or(z.literal("")).optional(),
  status: z.enum(["draft", "pending", "approved", "rejected"]).optional(),
  seoTitle: z.string().trim().max(300).optional(),
  seoDescription: z.string().trim().max(500).optional(),
});

// ---- Channels ---------------------------------------------------------------

// Every project whose blog this user may work on, with their role on each.
blogsRouter.get(
  "/projects",
  asyncHandler(async (req, res) => {
    res.json({ projects: await blogsService.myProjects(req.auth!) });
  }),
);

blogsRouter.get(
  "/projects/:projectId/channel",
  asyncHandler(async (req, res) => {
    res.json({ channel: await blogsService.getChannel(req.params.projectId!, req.auth!) });
  }),
);

blogsRouter.put(
  "/projects/:projectId/channel",
  validateBody(channelSchema),
  asyncHandler(async (req, res) => {
    const channel = await blogsService.upsertChannel(req.params.projectId!, req.body, req.auth!);
    res.json({ channel });
  }),
);

blogsRouter.delete(
  "/projects/:projectId/channel",
  asyncHandler(async (req, res) => {
    await blogsService.deleteChannel(req.params.projectId!, req.auth!);
    res.status(204).end();
  }),
);

// ---- Editors ----------------------------------------------------------------

blogsRouter.get(
  "/projects/:projectId/editors",
  asyncHandler(async (req, res) => {
    res.json({ editors: await blogsService.listEditors(req.params.projectId!, req.auth!) });
  }),
);

blogsRouter.post(
  "/projects/:projectId/editors",
  validateBody(editorSchema),
  asyncHandler(async (req, res) => {
    const editor = await blogsService.assignEditor(
      req.params.projectId!,
      req.body.userId,
      req.body.role,
      req.auth!,
    );
    res.status(201).json({ editor });
  }),
);

blogsRouter.delete(
  "/projects/:projectId/editors/:userId",
  asyncHandler(async (req, res) => {
    await blogsService.removeEditor(req.params.projectId!, req.params.userId!, req.auth!);
    res.status(204).end();
  }),
);

// ---- Posts ------------------------------------------------------------------

blogsRouter.get(
  "/projects/:projectId/posts",
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.json(await blogsService.listPosts(req.params.projectId!, req.auth!, status));
  }),
);

blogsRouter.get(
  "/projects/:projectId/posts/:postId",
  asyncHandler(async (req, res) => {
    const post = await blogsService.getPost(req.params.projectId!, req.params.postId!, req.auth!);
    res.json({ post });
  }),
);

blogsRouter.post(
  "/projects/:projectId/posts",
  validateBody(postSchema),
  asyncHandler(async (req, res) => {
    if (!req.body.title?.trim() || !req.body.content?.trim()) {
      throw badRequest("A title and some content are required");
    }
    const post = await blogsService.createPost(req.params.projectId!, req.body, req.auth!);
    res.status(201).json({ post });
  }),
);

blogsRouter.patch(
  "/projects/:projectId/posts/:postId",
  validateBody(postSchema),
  asyncHandler(async (req, res) => {
    const post = await blogsService.updatePost(
      req.params.projectId!,
      req.params.postId!,
      req.body,
      req.auth!,
    );
    res.json({ post });
  }),
);

blogsRouter.delete(
  "/projects/:projectId/posts/:postId",
  asyncHandler(async (req, res) => {
    await blogsService.deletePost(req.params.projectId!, req.params.postId!, req.auth!);
    res.status(204).end();
  }),
);

blogsRouter.post(
  "/projects/:projectId/posts/:postId/approve",
  asyncHandler(async (req, res) => {
    const post = await blogsService.approvePost(req.params.projectId!, req.params.postId!, req.auth!);
    res.json({ post });
  }),
);

blogsRouter.post(
  "/projects/:projectId/posts/:postId/reject",
  asyncHandler(async (req, res) => {
    const post = await blogsService.rejectPost(req.params.projectId!, req.params.postId!, req.auth!);
    res.json({ post });
  }),
);

// Cover images go straight through to the site's own media store.
blogsRouter.post(
  "/projects/:projectId/image",
  imageUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("No file uploaded");
    const url = await blogsService.uploadImage(req.params.projectId!, req.file, req.auth!);
    res.json({ url });
  }),
);
