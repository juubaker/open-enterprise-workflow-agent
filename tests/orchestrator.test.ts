import { describe, it, expect } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { ConsoleAuditLogger, AuditEvent, AuditLogger } from "../src/observability/audit.js";
import {
  FakeLLMClient,
  textResponse,
  toolUseResponse,
  expensiveTextResponse,
} from "./helpers/fake-llm.js";

class CapturingAuditLogger implements AuditLogger {
  events: AuditEvent[] = [];
  async log(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const ctx = { userId: "emp-001", roles: ["employee"] };

describe("Orchestrator", () => {
  it("returns text and stops on end_turn", async () => {
    const llm = new FakeLLMClient();
    llm.enqueue(textResponse("Hello, John"));
    const audit = new CapturingAuditLogger();
    const orch = new Orchestrator({
      llm,
      tools: new ToolRegistry(),
      policy: new PolicyEngine(),
      audit,
    });

    const result = await orch.run("hi", ctx);

    expect(result.status).toBe("ok");
    expect(result.text).toBe("Hello, John");
    expect(result.iterations).toBe(1);
    expect(audit.events.map((e) => e.type)).toEqual([
      "agent.start",
      "llm.call",
      "agent.end",
    ]);
  });

  it("dispatches a tool call, feeds the result back, and finishes", async () => {
    const llm = new FakeLLMClient();
    llm.enqueue(toolUseResponse("ping", { msg: "x" })).enqueue(
      textResponse("done")
    );

    const tools = new ToolRegistry().register({
      name: "ping",
      description: "echo",
      inputSchema: { type: "object", properties: { msg: { type: "string" } } },
      handler: async (input) => ({ echoed: (input as { msg: string }).msg }),
    });

    const audit = new CapturingAuditLogger();
    const orch = new Orchestrator({
      llm,
      tools,
      policy: new PolicyEngine(),
      audit,
    });

    const result = await orch.run("ping it", ctx);

    expect(result.status).toBe("ok");
    expect(result.text).toBe("done");
    expect(result.iterations).toBe(2);

    const types = audit.events.map((e) => e.type);
    expect(types).toContain("tool.invoked");
    expect(types).toContain("agent.end");
  });

  it("converts policy denial into a tool result and lets the model recover", async () => {
    const llm = new FakeLLMClient();
    llm.enqueue(toolUseResponse("forbidden", { employeeId: "emp-002" })).enqueue(
      textResponse("I cannot access that record.")
    );

    const tools = new ToolRegistry().register({
      name: "forbidden",
      description: "should be blocked",
      inputSchema: {
        type: "object",
        properties: { employeeId: { type: "string" } },
      },
      handler: async () => ({ result: "should never run" }),
    });

    const policy = new PolicyEngine().use(({ input, context }) => {
      const target = (input as { employeeId?: string }).employeeId;
      if (target && target !== context.userId) {
        return { allowed: false, reason: "test denial" };
      }
      return { allowed: true };
    });

    const audit = new CapturingAuditLogger();
    const orch = new Orchestrator({ llm, tools, policy, audit });

    const result = await orch.run("act on emp-002", ctx);

    expect(result.status).toBe("ok");
    expect(result.text).toContain("cannot");

    const denials = audit.events.filter((e) => e.type === "policy.denied");
    expect(denials).toHaveLength(1);

    const invocations = audit.events.filter((e) => e.type === "tool.invoked");
    expect(invocations).toHaveLength(0);
  });

  it("captures handler errors as tool results without crashing the loop", async () => {
    const llm = new FakeLLMClient();
    llm.enqueue(toolUseResponse("explode", {})).enqueue(textResponse("recovered"));

    const tools = new ToolRegistry().register({
      name: "explode",
      description: "throws",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        throw new Error("boom");
      },
    });

    const audit = new CapturingAuditLogger();
    const orch = new Orchestrator({
      llm,
      tools,
      policy: new PolicyEngine(),
      audit,
    });

    const result = await orch.run("explode it", ctx);

    expect(result.status).toBe("ok");
    expect(result.text).toBe("recovered");

    const errors = audit.events.filter((e) => e.type === "tool.error");
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0].payload)).toContain("boom");
  });

  it("hits the iteration cap and returns iteration_limit", async () => {
    const llm = new FakeLLMClient();
    for (let i = 0; i < 5; i++) {
      llm.enqueue(toolUseResponse("loop", { i }, `tu_${i}`));
    }

    const tools = new ToolRegistry().register({
      name: "loop",
      description: "infinite",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "ok",
    });

    const orch = new Orchestrator({
      llm,
      tools,
      policy: new PolicyEngine(),
      audit: new ConsoleAuditLogger(),
      maxIterations: 3,
    });

    const result = await orch.run("loop", ctx);
    expect(result.status).toBe("iteration_limit");
    expect(result.iterations).toBe(3);
  });

  it("hits the cost cap and returns budget_exceeded", async () => {
    const llm = new FakeLLMClient();
    llm.pricePerToken = 0.001; // tune so one call exceeds the cap
    llm.enqueue(expensiveTextResponse("never seen"));

    const orch = new Orchestrator({
      llm,
      tools: new ToolRegistry(),
      policy: new PolicyEngine(),
      audit: new ConsoleAuditLogger(),
      maxCostUsd: 0.01,
    });

    const result = await orch.run("expensive", ctx);
    expect(result.status).toBe("budget_exceeded");
    expect(result.costUsd).toBeGreaterThan(0.01);
  });

  it("threads conversation history into a follow-up turn", async () => {
    const llm = new FakeLLMClient();
    llm
      .enqueue(textResponse("Hello, John"))
      .enqueue(textResponse("Yes, you said hello earlier"));

    const orch = new Orchestrator({
      llm,
      tools: new ToolRegistry(),
      policy: new PolicyEngine(),
      audit: new ConsoleAuditLogger(),
    });

    const first = await orch.run("hi", ctx);
    expect(first.messages).toHaveLength(2); // user + assistant

    const second = await orch.run("did I say hello?", ctx, first.messages);
    // Second call should see the prior user and assistant turns plus the new user turn.
    expect(llm.calls[1].messages).toHaveLength(3);
    expect(llm.calls[1].messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "hi" }],
    });
    expect(second.status).toBe("ok");
  });

  it("injects user identity into the system prompt", async () => {
    const llm = new FakeLLMClient();
    llm.enqueue(textResponse("ok"));

    const orch = new Orchestrator({
      llm,
      tools: new ToolRegistry(),
      policy: new PolicyEngine(),
      audit: new ConsoleAuditLogger(),
    });

    await orch.run("hi", { userId: "emp-042", roles: ["manager"] });

    expect(llm.calls[0].system).toContain("emp-042");
    expect(llm.calls[0].system).toContain("manager");
  });

  it("includes provider and model in agent.start audit event", async () => {
    const llm = new FakeLLMClient();
    llm.enqueue(textResponse("ok"));

    const audit = new CapturingAuditLogger();
    const orch = new Orchestrator({
      llm,
      tools: new ToolRegistry(),
      policy: new PolicyEngine(),
      audit,
    });

    await orch.run("hi", ctx);

    const start = audit.events.find((e) => e.type === "agent.start");
    expect(start?.payload).toMatchObject({ provider: "fake", model: "fake-model" });
  });
});
