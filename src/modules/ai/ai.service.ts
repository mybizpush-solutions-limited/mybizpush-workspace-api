import { chatCompletion, type ChatMessage } from "../../lib/openrouter";
import { Comment, Issue, Task, type ItemType } from "../../models";
import { notFound } from "../../lib/errors";

const SYSTEM_PROMPT =
  "You are the MyBizPush Dev Space assistant — a concise, practical copilot inside an internal " +
  "work-management tool organized as Departments → Projects → Tasks & Issues. Help the team " +
  "summarize issues, draft replies, break work into steps, and surface blockers. Keep answers " +
  "brief and actionable; use short bullet lists when helpful.";

export const aiService = {
  // Free-form chat. The system prompt is prepended server-side.
  chat: (messages: ChatMessage[]) =>
    chatCompletion([{ role: "system", content: SYSTEM_PROMPT }, ...messages]),

  // Summarize a specific task/issue using its description + recent comments.
  async summarizeItem(itemId: string, itemType: ItemType): Promise<string> {
    const item = itemType === "task" ? await Task.findByPk(itemId) : await Issue.findByPk(itemId);
    if (!item) throw notFound(`${itemType} not found`);
    const comments = await Comment.findAll({
      where: { itemId },
      order: [["createdAt", "ASC"]],
      limit: 30,
    });

    const transcript = comments.map((c) => `- ${c.body}`).join("\n") || "(no comments)";
    const prompt =
      `Summarize this ${itemType} for a teammate catching up. Give a one-line status, the key points, ` +
      `and any blockers or next steps.\n\n` +
      `Title: ${item.title}\nStatus: ${item.status}\nPriority: ${item.priority}\n\n` +
      `Description:\n${item.description || "(none)"}\n\nComments:\n${transcript}`;

    return chatCompletion([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ]);
  },
};
