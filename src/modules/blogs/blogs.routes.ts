import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler, badRequest } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { BLOG_AI_GATE_SEVERITIES, BLOG_EDITOR_ROLES } from "../../models";
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
  aiGateSeverity: z.enum(BLOG_AI_GATE_SEVERITIES).optional(),
});

const editorSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(BLOG_EDITOR_ROLES),
});

// A slug is normalised rather than rejected: "My Post: Part 2" becomes
// "my-post-part-2". Refusing it sent authors round in circles at publish time.
function normalizeSlug(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const postSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  subtitle: z.string().trim().max(500).optional(),
  slug: z.string().trim().max(300).transform(normalizeSlug).optional(),
  content: z.string().max(200_000).optional(),
  imageUrl: z.string().trim().url().or(z.literal("")).optional(),
  status: z.enum(["draft", "pending", "approved", "rejected"]).optional(),
  seoTitle: z.string().trim().max(300).optional(),
  seoDescription: z.string().trim().max(500).optional(),
  categoryId: z.string().uuid().or(z.literal("")).optional(),
});

const categorySchema = z.object({
  name: z.string().trim().min(1).max(40),
  slug: z.string().trim().max(60).optional(),
  description: z.string().trim().max(300).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

const optionalDate = z.string().datetime({ offset: true }).or(z.literal("")).nullable();

const adSchema = z.object({
  name: z.string().trim().min(1).max(120),
  imageUrl: z.string().trim().url().max(1000),
  linkUrl: z.string().trim().url().max(1000).or(z.literal("")),
  altText: z.string().trim().max(200),
  size: z.string().trim().max(20),
  placement: z.string().trim().max(20),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(999),
  startsAt: optionalDate,
  endsAt: optionalDate,
});

const optionalUrl = z.string().trim().url().max(500).or(z.literal(""));
const siteSettingsSchema = z.object({
  instagramUrl: optionalUrl,
  facebookUrl: optionalUrl,
  xUrl: optionalUrl,
  linkedinUrl: optionalUrl,
  youtubeUrl: optionalUrl,
  tiktokUrl: optionalUrl,
  featuredVideoUrl: optionalUrl,
  featuredInstagramUrl: optionalUrl,
  commentsEnabled: z.boolean(),
  latestCount: z.number().int().min(0).max(12),
  randomCount: z.number().int().min(0).max(12),
  relatedCount: z.number().int().min(0).max(12),
});

// Feedback the reviewer leaves with a decision. Optional on approve ("nice
// work"), required on reject — enforced in the service so the rule lives with
// the behaviour rather than with the parsing.
const decisionSchema = z.object({
  feedback: z.string().trim().max(5000).optional(),
});

const reviewCommentSchema = z.object({
  // The id of the block the note is pinned to, stamped by the editor.
  anchorId: z.string().trim().max(64).optional(),
  // Clipped rather than rejected: quotes come from the AI review's findings, and
  // a note shouldn't fail because the model quoted a long passage.
  quote: z
    .string()
    .trim()
    .transform((s) => s.slice(0, 400))
    .optional(),
  body: z.string().trim().min(1).max(5000),
});

const reviewCommentPatchSchema = z.object({
  body: z.string().trim().min(1).max(5000).optional(),
  resolved: z.boolean().optional(),
});

// ---- Channels ---------------------------------------------------------------

// Every project whose blog this user may work on, with their role on each.
blogsRouter.get(
  "/projects",
  asyncHandler(async (req, res) => {
    res.json({ projects: await blogsService.myProjects(req.auth!) });
  }),
);

// Everything awaiting review, across every blog this person publishes for.
blogsRouter.get(
  "/review-queue",
  asyncHandler(async (req, res) => {
    res.json({ items: await blogsService.reviewQueue(req.auth!) });
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
    // `gate` is the automated review a submission went through, and whether
    // the post got past it; null when the post was only saved.
    const { post, gate } = await blogsService.createPost(req.params.projectId!, req.body, req.auth!);
    res.status(201).json({ post, gate });
  }),
);

blogsRouter.patch(
  "/projects/:projectId/posts/:postId",
  validateBody(postSchema),
  asyncHandler(async (req, res) => {
    const { post, gate } = await blogsService.updatePost(
      req.params.projectId!,
      req.params.postId!,
      req.body,
      req.auth!,
    );
    res.json({ post, gate });
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
  validateBody(decisionSchema),
  asyncHandler(async (req, res) => {
    const post = await blogsService.approvePost(
      req.params.projectId!,
      req.params.postId!,
      req.auth!,
      req.body.feedback ?? "",
    );
    res.json({ post });
  }),
);

blogsRouter.post(
  "/projects/:projectId/posts/:postId/reject",
  validateBody(decisionSchema),
  asyncHandler(async (req, res) => {
    const post = await blogsService.rejectPost(
      req.params.projectId!,
      req.params.postId!,
      req.auth!,
      req.body.feedback ?? "",
    );
    res.json({ post });
  }),
);

// ---- Review -----------------------------------------------------------------

// The automated check, the inline notes, and the decision history in one call.
blogsRouter.get(
  "/projects/:projectId/posts/:postId/review",
  asyncHandler(async (req, res) => {
    res.json(await blogsService.getReview(req.params.projectId!, req.params.postId!, req.auth!));
  }),
);

// Runs the post through the site API's AI reviewer. Can take a while — it's a
// model call on the far side.
blogsRouter.post(
  "/projects/:projectId/posts/:postId/ai-review",
  asyncHandler(async (req, res) => {
    const review = await blogsService.runAIReview(
      req.params.projectId!,
      req.params.postId!,
      req.auth!,
    );
    res.json({ review });
  }),
);

blogsRouter.post(
  "/projects/:projectId/posts/:postId/comments",
  validateBody(reviewCommentSchema),
  asyncHandler(async (req, res) => {
    const comment = await blogsService.addReviewComment(
      req.params.projectId!,
      req.params.postId!,
      req.body,
      req.auth!,
    );
    res.status(201).json({ comment });
  }),
);

blogsRouter.patch(
  "/projects/:projectId/posts/:postId/comments/:commentId",
  validateBody(reviewCommentPatchSchema),
  asyncHandler(async (req, res) => {
    const comment = await blogsService.updateReviewComment(
      req.params.projectId!,
      req.params.postId!,
      req.params.commentId!,
      req.body,
      req.auth!,
    );
    res.json({ comment });
  }),
);

blogsRouter.delete(
  "/projects/:projectId/posts/:postId/comments/:commentId",
  asyncHandler(async (req, res) => {
    await blogsService.deleteReviewComment(
      req.params.projectId!,
      req.params.postId!,
      req.params.commentId!,
      req.auth!,
    );
    res.status(204).end();
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

// ---- Site furniture ---------------------------------------------------------
// Categories, banners and sidebar settings live on the site API; these proxy
// them so the media team can run the blog without the site's admin dashboard.

blogsRouter.get(
  "/projects/:projectId/categories",
  asyncHandler(async (req, res) => {
    res.json({ categories: await blogsService.listCategories(req.params.projectId!, req.auth!) });
  }),
);

blogsRouter.post(
  "/projects/:projectId/categories",
  validateBody(categorySchema),
  asyncHandler(async (req, res) => {
    const category = await blogsService.createCategory(req.params.projectId!, req.body, req.auth!);
    res.status(201).json({ category });
  }),
);

blogsRouter.put(
  "/projects/:projectId/categories/:categoryId",
  validateBody(categorySchema),
  asyncHandler(async (req, res) => {
    const category = await blogsService.updateCategory(
      req.params.projectId!,
      req.params.categoryId!,
      req.body,
      req.auth!,
    );
    res.json({ category });
  }),
);

blogsRouter.delete(
  "/projects/:projectId/categories/:categoryId",
  asyncHandler(async (req, res) => {
    await blogsService.deleteCategory(req.params.projectId!, req.params.categoryId!, req.auth!);
    res.status(204).end();
  }),
);

blogsRouter.get(
  "/projects/:projectId/ads",
  asyncHandler(async (req, res) => {
    res.json(await blogsService.listAds(req.params.projectId!, req.auth!));
  }),
);

blogsRouter.post(
  "/projects/:projectId/ads",
  validateBody(adSchema),
  asyncHandler(async (req, res) => {
    const ad = await blogsService.createAd(req.params.projectId!, req.body, req.auth!);
    res.status(201).json({ ad });
  }),
);

blogsRouter.put(
  "/projects/:projectId/ads/:adId",
  validateBody(adSchema),
  asyncHandler(async (req, res) => {
    const ad = await blogsService.updateAd(req.params.projectId!, req.params.adId!, req.body, req.auth!);
    res.json({ ad });
  }),
);

blogsRouter.delete(
  "/projects/:projectId/ads/:adId",
  asyncHandler(async (req, res) => {
    await blogsService.deleteAd(req.params.projectId!, req.params.adId!, req.auth!);
    res.status(204).end();
  }),
);

blogsRouter.get(
  "/projects/:projectId/site-settings",
  asyncHandler(async (req, res) => {
    res.json({ settings: await blogsService.getSiteSettings(req.params.projectId!, req.auth!) });
  }),
);

blogsRouter.put(
  "/projects/:projectId/site-settings",
  validateBody(siteSettingsSchema),
  asyncHandler(async (req, res) => {
    const settings = await blogsService.updateSiteSettings(req.params.projectId!, req.body, req.auth!);
    res.json({ settings });
  }),
);
