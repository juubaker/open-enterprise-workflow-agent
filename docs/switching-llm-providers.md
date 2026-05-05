# Switching LLM providers

The agent depends on the `LLMClient` interface, not on any vendor SDK. Three providers ship in the box:

| Provider | Use when | Cost |
| --- | --- | --- |
| **Anthropic** (Claude) | Default. Best results for tool-use, smartest reasoning. | Per-token, billed by Anthropic |
| **OpenAI** (GPT family) | Want OpenAI specifically, or a vendor evaluation comparison. | Per-token, billed by OpenAI |
| **Ollama** (local models) | No API key, no cost, fully offline. Good for development and demos. | Free (uses your CPU/GPU) |

Switching is one environment variable.

## Anthropic (default)

```bash
# .env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
# Optional: AGENT_MODEL=claude-opus-4-7
```

This is the default if `LLM_PROVIDER` is unset.

## OpenAI

```bash
# .env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
AGENT_MODEL=gpt-4o-mini
```

For OpenAI-compatible providers (Together AI, Groq, Anyscale, Fireworks), set `OPENAI_BASE_URL`:

```bash
# Together AI example
LLM_PROVIDER=openai
OPENAI_API_KEY=tok-...
OPENAI_BASE_URL=https://api.together.xyz/v1
AGENT_MODEL=meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo

# Groq example
LLM_PROVIDER=openai
OPENAI_API_KEY=gsk_...
OPENAI_BASE_URL=https://api.groq.com/openai/v1
AGENT_MODEL=llama-3.3-70b-versatile
```

## Ollama (local)

Install Ollama from [ollama.com](https://ollama.com), then pull a model that supports tool calling:

```bash
ollama pull qwen2.5:7b           # recommended for laptops
ollama pull llama3.1:8b          # alternative
ollama pull qwen2.5:14b          # better tool-use, needs more RAM
```

Configure the agent:

```bash
# .env
LLM_PROVIDER=ollama
AGENT_MODEL=qwen2.5:7b
# OLLAMA_BASE_URL defaults to http://localhost:11434/v1
```

Make sure Ollama is running (`ollama serve` in another terminal, or it's already running as a service if you installed it on macOS), then start the agent.

## Picking a model

Tool-use quality varies a lot across models. Rough ordering, best to worst, for this agent's workload:

1. **Claude Opus / Sonnet** — most reliable tool selection, best at handling policy denials gracefully
2. **GPT-4o** — close second, occasionally over-eager on tool calls
3. **Llama 3.1 70B / Qwen 2.5 72B** (via Together / Groq / Ollama on a beefy machine) — solid; mostly correct
4. **Llama 3.1 8B / Qwen 2.5 7B** (typical Ollama setup) — works for the demo flows but expect occasional missed tool calls or malformed JSON args

The eval suite (`npm run eval`) is the right way to measure this — run it against each provider you're considering.

## What changes when you swap

Nothing in the application code. The orchestrator depends on `LLMClient`, not on any specific implementation. Tools, policy rules, audit log, and the dashboard all work identically regardless of provider.

A few things you'll notice in the dashboard's audit log when you swap:

- The `agent.start` event records the active `provider` and `model` — useful when comparing across runs.
- `llm.call` events record `costUsd` per call. For Ollama this will be `$0.0000` because local inference is free.

## Production note

The `estimateCost()` method on each client uses placeholder per-million pricing. Real production should load actual vendor pricing from configuration, ideally per-(provider, model). The current values are accurate enough that budget caps function correctly but they will drift from real prices over time.
