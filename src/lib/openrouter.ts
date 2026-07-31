import { env } from "../config/env";
import { AppError } from "./errors";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant turns where the model wants tools run. */
  tool_calls?: ToolCall[];
  /** Required on `tool` turns — ties the result back to the call. */
  tool_call_id?: string;
  /** Tool name, echoed on `tool` turns; some models rely on it. */
  name?: string;
}

/** A function the model may call, in the JSON-Schema shape OpenRouter expects. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }[];
}

export interface AssistantTurn {
  content: string;
  toolCalls: ToolCall[];
}

async function post(body: Record<string, unknown>): Promise<ChatCompletionResponse> {
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
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AppError(502, `OpenRouter request failed (${res.status})`, "openrouter_error", detail.slice(0, 500));
  }
  return (await res.json()) as ChatCompletionResponse;
}

// Call OpenRouter's chat-completions endpoint. Returns the assistant's text.
export async function chatCompletion(
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number } = {},
): Promise<string> {
  const data = await post({
    model: opts.model ?? env.OPENROUTER_MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
  });
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new AppError(502, "OpenRouter returned no content", "openrouter_empty");
  return content;
}

// One turn of a tool-calling conversation. Unlike chatCompletion this tolerates
// an empty `content` — a turn that only requests tools legitimately has none —
// so the caller decides when the exchange is finished.
export async function chatCompletionWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  opts: { model?: string; temperature?: number } = {},
): Promise<AssistantTurn> {
  const data = await post({
    model: opts.model ?? env.OPENROUTER_AGENT_MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
    ...(tools.length ? { tools, tool_choice: "auto" } : {}),
  });

  const message = data.choices?.[0]?.message;
  const toolCalls = message?.tool_calls ?? [];
  const content = message?.content?.trim() ?? "";
  if (!content && !toolCalls.length) {
    throw new AppError(502, "OpenRouter returned no content", "openrouter_empty");
  }
  return { content, toolCalls };
}
