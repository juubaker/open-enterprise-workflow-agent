# 0005 — LLMClient as interface, not SDK dependency

## Status

Accepted. Supersedes the implicit decision in [ADR 0001](./0001-policy-engine-as-central-gate.md) era to import the Anthropic SDK directly into the orchestrator.

## Context

The orchestrator originally imported `@anthropic-ai/sdk` directly and called `client.messages.create()` inline. This had three problems:

1. **Vendor lock-in by inertia.** The README claimed the agent was "provider-abstracted" but the orchestrator literally constructed Anthropic message objects and parsed Anthropic content blocks. Switching providers wasn't one config change — it was a refactor.
2. **Tests had to mock the SDK shape.** The test double, `FakeAnthropicClient`, faithfully implemented `messages.create()` with all its parameter quirks. Tests were verbose and tightly coupled to vendor types.
3. **No path to local development.** Running the agent against a local Ollama instance required either a fork or wholesale rewriting of the orchestrator.

The integration layer (`HCMClient`) had already established the pattern: define an interface, ship a mock implementation, defer real implementations. Applying the same pattern to the LLM was the obvious move; not having done so was a gap.

## Decision

Define `LLMClient` in `src/llm/client.ts` as the orchestrator's only dependency for reasoning. Ship three implementations and a factory:

- `ClaudeClient` — wraps the Anthropic SDK
- `OpenAIClient` — wraps the OpenAI SDK, configurable `baseURL` makes it work with OpenAI itself, Ollama, Together AI, Groq, Anyscale, vLLM, LM Studio, and any other OpenAI-compatible endpoint
- `buildLLMClient()` factory in `src/llm/factory.ts` selects one based on `LLM_PROVIDER` config

Messages and tool definitions are normalized in `src/llm/types.ts` into a provider-agnostic format. The shape is borrowed from Anthropic's content-block model — explicit blocks for text, tool use, and tool results — because it's the cleaner abstraction. Each implementation translates to and from its provider's native format.

Cost estimation lives on the `LLMClient` itself (`estimateCost(usage)`) rather than as a static helper. Each provider knows its own pricing. Local providers (Ollama) return $0.

```ts
interface LLMClient {
  readonly modelId: string;
  readonly provider: string;
  call(request: LLMRequest): Promise<LLMResponse>;
  estimateCost(usage: TokenUsage): number;
}
```

The orchestrator constructor takes an `LLMClient` and never knows which one it got.

## Consequences

**Easier:**

- Provider swaps are one environment variable: `LLM_PROVIDER=ollama` and the agent runs against a local model with no source changes.
- Tests use `FakeLLMClient` — implementing one method against one interface, instead of mocking an SDK with dozens of parameters and result types.
- New providers are one new class implementing the interface, plus one case in the factory switch.
- Cost estimation is per-provider, which is honest about the fact that pricing models differ.
- Demo flexibility: portfolio walkthroughs can run on Claude (best results) or Ollama (no API key, no cost) without code changes.

**Harder:**

- The normalized message format is a commitment. Adding a content block type means updating every implementation. So far the three block types (text, tool_use, tool_result) cover what every major provider supports; adding image input or thinking blocks would be a future migration.
- Translation between formats has bugs we won't catch until each provider sees real workloads. The Anthropic translation is well-tested because Claude was the original implementation; the OpenAI translation has been exercised against Ollama in development but smaller models have less reliable tool-calling and may surface translation bugs that bigger models hide.
- Smaller local models (7B class via Ollama) are noticeably worse at tool-use than Claude or GPT-4. The eval suite that passes reliably on Claude will fail more cases on a 7B local model. This is a model quality issue, not an integration bug, but it affects expectations.
- Cost estimation pricing constants will drift from real vendor pricing. Production needs a per-(provider, model) pricing table loaded from configuration.
