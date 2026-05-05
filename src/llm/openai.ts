import OpenAI from "openai";
import type { LLMClient } from "./client.js";
import type {
  ContentBlock,
  LLMRequest,
  LLMResponse,
  Message,
  ResponseContentBlock,
  StopReason,
  TokenUsage,
} from "./types.js";

export interface OpenAIClientOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  /**
   * Provider label written to audit logs. "openai" by default; set to
   * "ollama" for local Ollama, "together" for Together AI, etc.
   * Distinct provider labels make per-provider metrics cleanly groupable.
   */
  provider?: string;
}

/**
 * OpenAI-protocol implementation. Works with any endpoint that speaks the
 * OpenAI Chat Completions format:
 *   - api.openai.com (OpenAI itself)
 *   - localhost:11434/v1 (Ollama)
 *   - api.together.xyz/v1 (Together AI)
 *   - api.groq.com/openai/v1 (Groq)
 *   - api.anyscale.com/v1 (Anyscale)
 *   - any vLLM, LM Studio, or self-hosted server
 *
 * Translates the agent's normalized format to/from OpenAI's. Unlike
 * Anthropic's content-block model, OpenAI puts tool calls in a sidecar
 * `tool_calls` array on the assistant message and tool results in separate
 * messages with role "tool" — translation handles both directions.
 */
export class OpenAIClient implements LLMClient {
  readonly modelId: string;
  readonly provider: string;
  private readonly client: OpenAI;

  constructor(opts: OpenAIClientOptions) {
    this.modelId = opts.model;
    this.provider = opts.provider ?? "openai";
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    });
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: request.system },
      ...request.messages.flatMap(toOpenAIMessages),
    ];

    const tools: OpenAI.ChatCompletionTool[] = request.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      max_tokens: request.maxTokens ?? 4096,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("OpenAI response had no choices");
    }

    return {
      content: extractContent(choice.message),
      stopReason: mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  /**
   * Per-million pricing. Local providers (Ollama) cost nothing. OpenAI
   * pricing varies wildly by model — these are placeholders for gpt-4o-mini.
   * Production should load real rates from configuration per (provider, model).
   */
  estimateCost(usage: TokenUsage): number {
    if (this.provider === "ollama") return 0;
    const inputPer1M = 0.15;
    const outputPer1M = 0.6;
    return (
      (usage.inputTokens * inputPer1M + usage.outputTokens * outputPer1M) /
      1_000_000
    );
  }
}

/**
 * One normalized message can become multiple OpenAI messages. A user message
 * containing tool_results becomes one "tool" message per result. An assistant
 * message containing both text and tool_uses becomes one assistant message
 * with content + tool_calls.
 */
function toOpenAIMessages(
  m: Message
): OpenAI.ChatCompletionMessageParam[] {
  if (m.role === "user") {
    const toolResults = m.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result"
    );
    if (toolResults.length > 0) {
      // OpenAI requires tool results to be their own messages with role "tool"
      return toolResults.map((b) => ({
        role: "tool" as const,
        tool_call_id: b.toolUseId,
        content: b.content,
      }));
    }
    const text = m.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return [{ role: "user", content: text }];
  }

  const text = m.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const toolUses = m.content.filter(
    (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
      b.type === "tool_use"
  );

  const message: OpenAI.ChatCompletionAssistantMessageParam = {
    role: "assistant",
    content: text || null,
  };
  if (toolUses.length > 0) {
    message.tool_calls = toolUses.map((b) => ({
      id: b.id,
      type: "function" as const,
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }));
  }
  return [message];
}

function extractContent(
  message: OpenAI.ChatCompletionMessage
): ResponseContentBlock[] {
  const out: ResponseContentBlock[] = [];
  if (message.content) {
    out.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    if (call.type !== "function") continue;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      // Some smaller local models occasionally emit malformed JSON for
      // tool args. Surface it to the orchestrator, which will return it
      // as a tool error the model can recover from.
      input = { __parse_error: call.function.arguments };
    }
    out.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input,
    });
  }
  return out;
}

function mapFinishReason(r: string | null | undefined): StopReason {
  if (r === "stop") return "end_turn";
  if (r === "tool_calls") return "tool_use";
  if (r === "length") return "max_tokens";
  return "other";
}
