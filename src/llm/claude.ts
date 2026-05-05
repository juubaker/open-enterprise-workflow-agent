import Anthropic from "@anthropic-ai/sdk";
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

export interface ClaudeClientOptions {
  apiKey: string;
  model: string;
  /** Optional override for testing or custom deployments. */
  baseURL?: string;
}

/**
 * Anthropic implementation of LLMClient. Translates the normalized message
 * format to/from Anthropic's native shape.
 */
export class ClaudeClient implements LLMClient {
  readonly modelId: string;
  readonly provider = "anthropic";
  private readonly client: Anthropic;

  constructor(opts: ClaudeClientOptions) {
    this.modelId = opts.model;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: request.maxTokens ?? 4096,
      system: request.system,
      tools: request.tools.map(toAnthropicTool),
      messages: request.messages.map(toAnthropicMessage),
    });

    return {
      content: response.content
        .map(fromAnthropicBlock)
        .filter((b): b is ResponseContentBlock => b !== null),
      stopReason: mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }

  /**
   * Per-million pricing for Claude Opus class models. Production should load
   * actual rates from configuration — these drift as Anthropic adjusts pricing
   * and don't account for cached input tokens.
   */
  estimateCost(usage: TokenUsage): number {
    const inputPer1M = 3.0;
    const outputPer1M = 15.0;
    return (
      (usage.inputTokens * inputPer1M + usage.outputTokens * outputPer1M) /
      1_000_000
    );
  }
}

function toAnthropicTool(t: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  };
}

function toAnthropicMessage(m: Message): Anthropic.MessageParam {
  return {
    role: m.role,
    content: m.content.map(toAnthropicBlock),
  };
}

function toAnthropicBlock(
  b: ContentBlock
): Anthropic.ContentBlockParam {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: b.content,
        ...(b.isError ? { is_error: true } : {}),
      };
  }
}

function fromAnthropicBlock(
  b: Anthropic.ContentBlock
): ResponseContentBlock | null {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "tool_use") {
    return {
      type: "tool_use",
      id: b.id,
      name: b.name,
      input: b.input as Record<string, unknown>,
    };
  }
  return null; // ignore other block types (thinking, citations, etc.)
}

function mapStopReason(r: string | null): StopReason {
  if (r === "end_turn") return "end_turn";
  if (r === "tool_use") return "tool_use";
  if (r === "max_tokens") return "max_tokens";
  return "other";
}
