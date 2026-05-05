import type { AuditEvent } from "./observability/audit.js";
import type { Message } from "./llm/types.js";

/**
 * Identity and roles passed through every layer of the agent.
 * In production this is constructed from a validated JWT or similar.
 */
export interface AgentContext {
  userId: string;
  roles: string[];
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export type AgentStatus =
  | "ok"
  | "iteration_limit"
  | "budget_exceeded"
  | "error";

export interface AgentResult {
  status: AgentStatus;
  text?: string;
  reason?: string;
  traceId: string;
  costUsd: number;
  iterations: number;
  /**
   * Full conversation after the run, in the agent's normalized message
   * format. Pass back as `history` to a subsequent run() to continue the
   * thread. The format is provider-agnostic — the same history works
   * across LLMClient implementations.
   */
  messages: Message[];
  /** All audit events emitted during this run, in order. */
  events: AuditEvent[];
}
