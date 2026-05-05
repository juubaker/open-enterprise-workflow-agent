import "dotenv/config";

type Provider = "anthropic" | "openai" | "ollama";

const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-opus-4-7",
  openai: "gpt-4o-mini",
  ollama: "qwen2.5:7b",
};

function readProvider(): Provider {
  const raw = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();
  if (raw === "anthropic" || raw === "openai" || raw === "ollama") return raw;
  throw new Error(
    `Invalid LLM_PROVIDER="${raw}". Use anthropic, openai, or ollama.`
  );
}

const llmProvider = readProvider();

export const config = {
  llmProvider,

  /**
   * Model id passed to the LLM provider. If unset, picks a sensible default
   * for the chosen provider. The agent doesn't validate this against the
   * provider's catalog — bad model ids surface as API errors at first call.
   */
  model: process.env.AGENT_MODEL ?? DEFAULT_MODELS[llmProvider],

  // Provider-specific credentials and endpoints
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined, // empty string → undefined
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",

  // Existing knobs
  port: parseInt(process.env.PORT ?? "3000", 10),
  auditPath: process.env.AUDIT_PATH ?? "./audit.log",
  maxIterations: parseInt(process.env.AGENT_MAX_ITERATIONS ?? "10", 10),
  maxCostUsd: parseFloat(process.env.AGENT_MAX_COST_USD ?? "1.00"),
  trace: process.env.AGENT_TRACE === "1",
};

/**
 * Validates that the credentials needed for the chosen provider are present.
 * Called at startup by the CLI and HTTP server entry points.
 */
export function assertConfig(): void {
  if (config.llmProvider === "anthropic" && !config.anthropicApiKey) {
    throw new Error(
      "LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY. Copy .env.example to .env and set it."
    );
  }
  if (config.llmProvider === "openai" && !config.openaiApiKey) {
    throw new Error(
      "LLM_PROVIDER=openai requires OPENAI_API_KEY. Copy .env.example to .env and set it."
    );
  }
  // Ollama doesn't need credentials.
}
