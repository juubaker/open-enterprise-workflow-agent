import type { LLMRequest, LLMResponse, TokenUsage } from "./types.js";

/**
 * The agent's only dependency on the LLM provider. Implementations translate
 * between the normalized request/response shape and their vendor's API.
 *
 * Three reasons this exists:
 *   1. Vendor swaps don't ripple through agent code — the orchestrator
 *      doesn't know whether Anthropic, OpenAI, or a local Ollama is on
 *      the other side.
 *   2. Cost estimation is per-provider — each implementation knows its
 *      own pricing model.
 *   3. Tests use a FakeLLMClient that's an order of magnitude simpler
 *      than mocking a vendor SDK.
 */
export interface LLMClient {
  /** Model identifier — opaque to the agent, used only for audit logs. */
  readonly modelId: string;

  /** Provider category for audit/metrics — "anthropic", "openai", "ollama", etc. */
  readonly provider: string;

  /** Run one round-trip against the model. */
  call(request: LLMRequest): Promise<LLMResponse>;

  /**
   * Estimate the dollar cost of a call given its token usage. Returns 0 for
   * local providers (Ollama). Real production would load per-model pricing
   * from configuration; the in-code constants here are reasonable starting
   * points but will drift from actual vendor pricing over time.
   */
  estimateCost(usage: TokenUsage): number;
}
