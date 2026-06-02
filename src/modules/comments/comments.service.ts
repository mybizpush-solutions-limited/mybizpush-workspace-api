import { Comment, User, type ItemType } from "../../models";
import { serializeComment } from "../shared/serializers";
import { logActivity, notify } from "../shared/events";

const withMentions = {
  include: [{ model: User, as: "mentions", attributes: ["id"], through: { attributes: [] } }],
};

export const commentsService = {
  async forItem(itemId: string) {
    const rows = await Comment.findAll({ where: { itemId }, ...withMentions, order: [["createdAt", "ASC"]] });
    return rows.map(serializeComment);
  },

  async add(input: { itemId: string; itemType: ItemType; authorId: string; body: string; mentions?: string[] }) {
    const comment = await Comment.create({
      itemId: input.itemId,
      itemType: input.itemType,
      authorId: input.authorId,
      body: input.body,
    });
    if (input.mentions?.length) await (comment as any).setMentions(input.mentions);

    await logActivity({ itemId: input.itemId, itemType: input.itemType, actorId: input.authorId, kind: "commented" });
    for (const uid of input.mentions ?? []) {
      await notify({ userId: uid, fromUserId: input.authorId, kind: "mentioned", itemId: input.itemId, itemType: input.itemType, message: "You were mentioned" });
    }

    const reloaded = await Comment.findByPk(comment.id, withMentions);
    return serializeComment(reloaded!);
  },
};
