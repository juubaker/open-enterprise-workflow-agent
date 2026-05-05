import type { LLMClient } from "./client.js";
import { ClaudeClient } from "./claude.js";
import { OpenAIClient } from "./openai.js";
import { config } from "../config.js";

/**
 * Build the LLMClient indicated by config. The orchestrator depends on the
 * interface, not on the choice — flipping providers is one environment
 * variable away.
 */
export function buildLLMClient(): LLMClient {
  switch (config.llmProvider) {
    case "anthropic":
      if (!config.anthropicApiKey) {
        throw new Error(
          "LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY in .env"
        );
      }
      return new ClaudeClient({
        apiKey: config.anthropicApiKey,
        model: config.model,
      });

    case "openai":
      if (!config.openaiApiKey) {
        throw new Error("LLM_PROVIDER=openai requires OPENAI_API_KEY in .env");
      }
      return new OpenAIClient({
        apiKey: config.openaiApiKey,
        model: config.model,
        baseURL: config.openaiBaseUrl,
        provider: "openai",
      });

    case "ollama":
      // Ollama doesn't require auth — pass any non-empty string for the SDK.
      return new OpenAIClient({
        apiKey: "ollama",
        model: config.model,
        baseURL: config.ollamaBaseUrl,
        provider: "ollama",
      });

    default:
      throw new Error(
        `Unknown LLM_PROVIDER: "${config.llmProvider}". Use anthropic, openai, or ollama.`
      );
  }
}
