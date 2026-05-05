/**
 * Normalized message and content shapes used by the agent core. Each LLMClient
 * implementation translates between these and its provider's native format.
 *
 * Shape inspired by Anthropic's content-block model because it's the cleanest
 * abstraction — explicit blocks for text, tool use, and tool results, rather
 * than smuggling tool calls into a sidecar field on the message.
 */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMRequest {
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

/**
 * Response content can only contain text and tool_use blocks (the model
 * never emits tool_results — those come from us, going back in).
 */
export type ResponseContentBlock = Extract<
  ContentBlock,
  { type: "text" } | { type: "tool_use" }
>;

export interface LLMResponse {
  content: ResponseContentBlock[];
  stopReason: StopReason;
  usage: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
