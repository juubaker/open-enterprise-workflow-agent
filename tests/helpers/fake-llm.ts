import type { LLMClient } from "../../src/llm/client.js";
import type {
  LLMRequest,
  LLMResponse,
  ResponseContentBlock,
  TokenUsage,
} from "../../src/llm/types.js";

/**
 * Test double for LLMClient. Tests enqueue responses; the orchestrator
 * dequeues them as it makes calls. No SDK to mock — the interface is
 * the contract.
 *
 * Per-call cost is configurable via `pricePerToken` for budget tests.
 */
export class FakeLLMClient implements LLMClient {
  readonly modelId = "fake-model";
  readonly provider = "fake";

  /** Per-token price used by estimateCost. Tests can tune this. */
  pricePerToken = 0.00001;

  private readonly queue: Partial<LLMResponse>[] = [];
  public readonly calls: LLMRequest[] = [];

  enqueue(response: Partial<LLMResponse>): this {
    this.queue.push(response);
    return this;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    // Snapshot the request so later mutation by the orchestrator doesn't
    // change what tests observe.
    this.calls.push({
      ...request,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: [...m.content],
      })),
    });
    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        "FakeLLMClient: call() invoked but no responses queued"
      );
    }
    return {
      content: [],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50 },
      ...next,
    };
  }

  estimateCost(usage: TokenUsage): number {
    return (usage.inputTokens + usage.outputTokens) * this.pricePerToken;
  }
}

// Convenience builders for canned response shapes.

export function textResponse(
  text: string,
  usage: TokenUsage = { inputTokens: 100, outputTokens: 50 }
): Partial<LLMResponse> {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage,
  };
}

export function toolUseResponse(
  name: string,
  input: Record<string, unknown>,
  toolUseId = "tu_1",
  usage: TokenUsage = { inputTokens: 100, outputTokens: 50 }
): Partial<LLMResponse> {
  const block: ResponseContentBlock = {
    type: "tool_use",
    id: toolUseId,
    name,
    input,
  };
  return {
    content: [block],
    stopReason: "tool_use",
    usage,
  };
}

/**
 * High-token-count response useful for testing the budget cap. Set
 * `client.pricePerToken` so this exceeds the test's maxCostUsd.
 */
export function expensiveTextResponse(
  text: string
): Partial<LLMResponse> {
  return textResponse(text, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
}
