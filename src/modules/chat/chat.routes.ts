import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rateLimit";
import { validateBody } from "../../middleware/validate";
import { CHANNEL_SCOPES, MEMBER_NOTIFY, MEMBER_ROLES, MESSAGE_TYPES } from "../../models";
import { GROUP_TYPES } from "../groups/groups.merge";
import { channelReport } from "./chat.reports";
import { chatService } from "./chat.service";
import { linkPreview } from "./linkPreview";

export const conversationsRouter = Router();
export const messagesRouter = Router();
conversationsRouter.use(requireAuth);
messagesRouter.use(requireAuth);

messagesRouter.get(
  "/link-preview",
  rateLimit({ windowSec: 60, max: 60, keyPrefix: "link-preview", key: (req) => req.auth?.sub ?? req.ip ?? "anon" }),
  asyncHandler(async (req, res) => {
    const url = z.string().url().max(2000).parse(req.query.url);
    res.set("Cache-Control", "private, max-age=3600");
    res.json({ preview: await linkPreview(url) });
  }),
);

const uuid = z.string().uuid();
const groups = z.array(z.object({ type: z.enum(GROUP_TYPES), id: uuid })).max(20);

export const sendSchema = z.object({
  id: uuid.optional(),
  type: z.enum(MESSAGE_TYPES).optional(),
  body: z.string().max(20000).optional(),
  meta: z.record(z.unknown()).optional(),
  attachmentIds: z.array(uuid).max(10).optional(),
  parentId: uuid.nullable().optional(),
  replyToId: uuid.nullable().optional(),
  mentions: z.array(uuid).max(100).optional(),
  clientSentAt: z.string().datetime().nullable().optional(),
});
export const editSchema = z.object({ body: z.string().max(20000), mentions: z.array(uuid).max(100).optional() });
export const emojiSchema = z.object({ emoji: z.string().trim().min(1).max(16) });
export const readSchema = z.object({ seq: z.coerce.number().int().min(0) });

const channelSchema = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  scope: z.enum(CHANNEL_SCOPES),
  scopeId: uuid.nullable().optional(),
  memberIds: z.array(uuid).max(500).optional(),
  groups: groups.optional(),
  moderatorIds: z.array(uuid).max(50).optional(),
  posting: z.enum(["everyone", "moderators"]).optional(),
});

conversationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = z.object({ type: z.enum(["direct", "channel"]).optional(), archived: z.enum(["true", "false"]).optional() }).parse(req.query);
    res.json({ conversations: await chatService.list(req.auth!.sub, { type: q.type, archived: q.archived === "true" }) });
  }),
);
conversationsRouter.get(
  "/joinable",
  asyncHandler(async (req, res) => {
    res.json({ conversations: await chatService.joinable(req.auth!.sub) });
  }),
);
conversationsRouter.post(
  "/direct",
  validateBody(z.object({ id: uuid.optional(), userId: uuid })),
  asyncHandler(async (req, res) => {
    const { created, conversation } = await chatService.openDirect(req.auth!.sub, req.body.userId, req.body.id);
    res.status(created ? 201 : 200).json({ conversation });
  }),
);
conversationsRouter.post(
  "/",
  validateBody(channelSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ conversation: await chatService.createChannel(req.body, req.auth!.sub) });
  }),
);
conversationsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json({ conversation: await chatService.get(req.params.id!, req.auth!.sub) });
  }),
);
conversationsRouter.patch(
  "/:id",
  validateBody(z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(1000).optional(), avatarUrl: z.string().url().nullable().optional(), posting: z.enum(["everyone", "moderators"]).optional() })),
  asyncHandler(async (req, res) => {
    res.json({ conversation: await chatService.update(req.params.id!, req.body, req.auth!.sub) });
  }),
);
conversationsRouter.post(
  "/:id/archive",
  asyncHandler(async (req, res) => {
    res.json({ conversation: await chatService.setArchived(req.params.id!, true, req.auth!.sub) });
  }),
);
conversationsRouter.post(
  "/:id/unarchive",
  asyncHandler(async (req, res) => {
    res.json({ conversation: await chatService.setArchived(req.params.id!, false, req.auth!.sub) });
  }),
);
conversationsRouter.post(
  "/:id/join",
  asyncHandler(async (req, res) => {
    res.json({ conversation: await chatService.join(req.params.id!, req.auth!.sub) });
  }),
);
conversationsRouter.post(
  "/:id/leave",
  asyncHandler(async (req, res) => {
    await chatService.leave(req.params.id!, req.auth!.sub);
    res.status(204).end();
  }),
);
conversationsRouter.patch(
  "/:id/me",
  validateBody(z.object({ notify: z.enum(MEMBER_NOTIFY).optional(), mutedUntil: z.string().datetime().nullable().optional(), pinned: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    res.json({ conversation: await chatService.setMyState(req.params.id!, req.body, req.auth!.sub) });
  }),
);
conversationsRouter.post(
  "/:id/read",
  validateBody(readSchema),
  asyncHandler(async (req, res) => {
    res.json(await chatService.read(req.params.id!, req.body.seq, req.auth!.sub));
  }),
);
conversationsRouter.post(
  "/:id/typing",
  validateBody(z.object({ isTyping: z.boolean() })),
  asyncHandler(async (req, res) => {
    await chatService.typing(req.params.id!, req.body.isTyping, req.auth!.sub);
    res.status(204).end();
  }),
);
conversationsRouter.get(
  "/:id/files",
  asyncHandler(async (req, res) => {
    const q = z.object({ kind: z.enum(["image", "video", "audio", "file"]).optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(req.query);
    res.json({ messages: await chatService.files(req.params.id!, req.auth!.sub, q) });
  }),
);
conversationsRouter.get(
  "/:id/pinned",
  asyncHandler(async (req, res) => {
    res.json({ messages: await chatService.pinned(req.params.id!, req.auth!.sub) });
  }),
);
conversationsRouter.get(
  "/:id/report",
  asyncHandler(async (req, res) => {
    const q = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }).parse(req.query);
    res.json(await channelReport(req.params.id!, req.auth!.sub, q));
  }),
);
conversationsRouter.get(
  "/:id/members",
  asyncHandler(async (req, res) => {
    res.json({ members: await chatService.members(req.params.id!, req.auth!.sub) });
  }),
);
conversationsRouter.post(
  "/:id/members",
  validateBody(z.object({ userIds: z.array(uuid).max(500).optional(), groups: groups.optional(), role: z.enum(MEMBER_ROLES).optional() })),
  asyncHandler(async (req, res) => {
    res.json({ members: await chatService.addMembers(req.params.id!, req.body, req.auth!.sub) });
  }),
);
conversationsRouter.patch(
  "/:id/members/:userId",
  validateBody(z.object({ role: z.enum(MEMBER_ROLES) })),
  asyncHandler(async (req, res) => {
    res.json({ member: await chatService.setMemberRole(req.params.id!, req.params.userId!, req.body.role, req.auth!.sub) });
  }),
);
conversationsRouter.delete(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    await chatService.removeMember(req.params.id!, req.params.userId!, req.auth!.sub);
    res.status(204).end();
  }),
);
conversationsRouter.get(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    const q = z.object({ before: z.coerce.number().int().optional(), after: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).optional(), parentId: uuid.optional() }).parse(req.query);
    res.json(await chatService.messages(req.params.id!, req.auth!.sub, q));
  }),
);
conversationsRouter.post(
  "/:id/messages",
  validateBody(sendSchema),
  asyncHandler(async (req, res) => {
    const { created, message } = await chatService.send(req.params.id!, req.body, req.auth!.sub);
    res.status(created ? 201 : 200).json({ message });
  }),
);

// ---- /messages --------------------------------------------------------------
messagesRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        q: z.string().trim().min(2).max(120),
        conversationId: uuid.optional(),
        senderId: uuid.optional(),
        type: z.enum(MESSAGE_TYPES).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      })
      .parse(req.query);
    res.json({ results: await chatService.search(req.auth!.sub, q) });
  }),
);
messagesRouter.patch(
  "/:id",
  validateBody(editSchema),
  asyncHandler(async (req, res) => {
    res.json({ message: await chatService.edit(req.params.id!, req.body, req.auth!.sub) });
  }),
);
messagesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json({ message: await chatService.remove(req.params.id!, req.auth!.sub) });
  }),
);
messagesRouter.post(
  "/:id/reactions",
  validateBody(emojiSchema),
  asyncHandler(async (req, res) => {
    res.json({ message: await chatService.react(req.params.id!, req.body.emoji, true, req.auth!.sub) });
  }),
);
messagesRouter.delete(
  "/:id/reactions",
  validateBody(emojiSchema),
  asyncHandler(async (req, res) => {
    res.json({ message: await chatService.react(req.params.id!, req.body.emoji, false, req.auth!.sub) });
  }),
);
messagesRouter.post(
  "/:id/pin",
  asyncHandler(async (req, res) => {
    res.json({ message: await chatService.setPinned(req.params.id!, true, req.auth!.sub) });
  }),
);
messagesRouter.post(
  "/:id/unpin",
  asyncHandler(async (req, res) => {
    res.json({ message: await chatService.setPinned(req.params.id!, false, req.auth!.sub) });
  }),
);
messagesRouter.get(
  "/:id/thread",
  asyncHandler(async (req, res) => {
    res.json(await chatService.thread(req.params.id!, req.auth!.sub));
  }),
);
