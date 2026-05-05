import { randomUUID } from "node:crypto";
import { ToolRegistry } from "./tools/registry.js";
import { PolicyEngine } from "./policy/engine.js";
import { AuditLogger, AuditEvent } from "./observability/audit.js";
import { AgentContext, AgentResult } from "./types.js";
import { buildSystemPrompt } from "./prompts.js";
import type { LLMClient } from "./llm/client.js";
import type { ContentBlock, Message } from "./llm/types.js";

export interface OrchestratorOptions {
  llm: LLMClient;
  tools: ToolRegistry;
  policy: PolicyEngine;
  audit: AuditLogger;
  maxIterations?: number;
  maxCostUsd?: number;
}

/**
 * Runs the LLM tool-use loop with three production guarantees:
 *   1. Every tool call passes through the policy engine first.
 *   2. Cost and iteration counts are bounded.
 *   3. Every action and decision is recorded to the audit log.
 *
 * The orchestrator depends only on LLMClient — it doesn't know whether
 * Anthropic, OpenAI, or a local Ollama is on the other side. Provider swaps
 * happen at LLMClient construction (see src/llm/factory.ts).
 *
 * Events emitted: agent.start, llm.call, tool.invoked, tool.error,
 * policy.denied, agent.end, agent.budget_exceeded, agent.iteration_limit.
 * Each event carries durationMs where applicable for downstream metrics.
 */
export class Orchestrator {
  private readonly llm: LLMClient;
  private readonly tools: ToolRegistry;
  private readonly policy: PolicyEngine;
  private readonly audit: AuditLogger;
  private readonly maxIterations: number;
  private readonly maxCostUsd: number;

  constructor(opts: OrchestratorOptions) {
    this.llm = opts.llm;
    this.tools = opts.tools;
    this.policy = opts.policy;
    this.audit = opts.audit;
    this.maxIterations = opts.maxIterations ?? 10;
    this.maxCostUsd = opts.maxCostUsd ?? 1.0;
  }

  async run(
    input: string,
    ctx: AgentContext,
    history: Message[] = []
  ): Promise<AgentResult> {
    const traceId = ctx.traceId ?? randomUUID();
    const messages: Message[] = [
      ...history,
      { role: "user", content: [{ type: "text", text: input }] },
    ];
    const tools = this.tools.schemas();

    let totalCostUsd = 0;
    let iterations = 0;

    const events: AuditEvent[] = [];
    const emit = async (event: AuditEvent): Promise<void> => {
      const stamped = {
        ...event,
        timestamp: event.timestamp ?? new Date().toISOString(),
      };
      events.push(stamped);
      await this.audit.log(stamped);
    };

    await emit({
      traceId,
      type: "agent.start",
      actor: ctx.userId,
      payload: {
        input,
        roles: ctx.roles,
        provider: this.llm.provider,
        model: this.llm.modelId,
      },
    });

    while (iterations < this.maxIterations) {
      iterations++;

      const llmStart = Date.now();
      const response = await this.llm.call({
        system: buildSystemPrompt(ctx),
        messages,
        tools,
      });
      const llmDuration = Date.now() - llmStart;
      const callCost = this.llm.estimateCost(response.usage);
      totalCostUsd += callCost;

      await emit({
        traceId,
        type: "llm.call",
        payload: {
          iteration: iterations,
          provider: this.llm.provider,
          model: this.llm.modelId,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          costUsd: callCost,
          durationMs: llmDuration,
          stopReason: response.stopReason,
        },
      });

      if (totalCostUsd > this.maxCostUsd) {
        await emit({
          traceId,
          type: "agent.budget_exceeded",
          payload: { totalCostUsd, limit: this.maxCostUsd },
        });
        return {
          status: "budget_exceeded",
          reason: `Spent $${totalCostUsd.toFixed(4)} exceeded $${this.maxCostUsd.toFixed(2)} cap`,
          traceId,
          costUsd: totalCostUsd,
          iterations,
          messages,
          events,
        };
      }

      messages.push({ role: "assistant", content: response.content });

      if (response.stopReason === "end_turn") {
        const text = response.content
          .filter(
            (b): b is Extract<typeof b, { type: "text" }> => b.type === "text"
          )
          .map((b) => b.text)
          .join("");
        await emit({
          traceId,
          type: "agent.end",
          payload: { iterations, costUsd: totalCostUsd },
        });
        return {
          status: "ok",
          text,
          traceId,
          costUsd: totalCostUsd,
          iterations,
          messages,
          events,
        };
      }

      if (response.stopReason !== "tool_use") {
        return {
          status: "error",
          reason: `Unexpected stop reason: ${response.stopReason}`,
          traceId,
          costUsd: totalCostUsd,
          iterations,
          messages,
          events,
        };
      }

      const toolCalls = response.content.filter(
        (b): b is Extract<typeof b, { type: "tool_use" }> =>
          b.type === "tool_use"
      );
      const toolResults: ContentBlock[] = [];

      for (const call of toolCalls) {
        const policyResult = await this.policy.check({
          tool: call.name,
          input: call.input,
          context: ctx,
        });

        if (!policyResult.allowed) {
          await emit({
            traceId,
            type: "policy.denied",
            actor: ctx.userId,
            payload: {
              tool: call.name,
              input: call.input,
              reason: policyResult.reason,
            },
          });
          toolResults.push({
            type: "tool_result",
            toolUseId: call.id,
            content: `POLICY_DENIED: ${policyResult.reason}`,
            isError: true,
          });
          continue;
        }

        const toolStart = Date.now();
        try {
          const output = await this.tools.invoke(call.name, call.input, ctx);
          const toolDuration = Date.now() - toolStart;
          await emit({
            traceId,
            type: "tool.invoked",
            actor: ctx.userId,
            payload: {
              tool: call.name,
              input: call.input,
              output,
              durationMs: toolDuration,
            },
          });
          toolResults.push({
            type: "tool_result",
            toolUseId: call.id,
            content:
              typeof output === "string" ? output : JSON.stringify(output),
          });
        } catch (e) {
          const toolDuration = Date.now() - toolStart;
          const message = e instanceof Error ? e.message : String(e);
          await emit({
            traceId,
            type: "tool.error",
            actor: ctx.userId,
            payload: {
              tool: call.name,
              error: message,
              durationMs: toolDuration,
            },
          });
          toolResults.push({
            type: "tool_result",
            toolUseId: call.id,
            content: `ERROR: ${message}`,
            isError: true,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
    }

    await emit({
      traceId,
      type: "agent.iteration_limit",
      payload: { iterations: this.maxIterations },
    });
    return {
      status: "iteration_limit",
      reason: `Hit max iterations (${this.maxIterations})`,
      traceId,
      costUsd: totalCostUsd,
      iterations,
      messages,
      events,
    };
  }
}
