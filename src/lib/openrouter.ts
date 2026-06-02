import { env } from "../config/env";
import { AppError } from "./errors";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

// Call OpenRouter's chat-completions endpoint. Returns the assistant's text.
export async function chatCompletion(
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number } = {},
): Promise<string> {
  if (!env.OPENROUTER_API_KEY) {
    throw new AppError(503, "OpenRouter is not configured", "openrouter_unconfigured");
  }

  const res = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      // OpenRouter attribution headers (optional but recommended).
      "HTTP-Referer": "https://mybizpush.com",
      "X-Title": "MyBizPush Dev Space",
    },
    body: JSON.stringify({
      model: opts.model ?? env.OPENROUTER_MODEL,
      messages,
      temperature: opts.temperature ?? 0.3,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AppError(502, `OpenRouter request failed (${res.status})`, "openrouter_error", detail.slice(0, 500));
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new AppError(502, "OpenRouter returned no content", "openrouter_empty");
  return content;
}
