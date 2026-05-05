import readline from "node:readline";
import { config, assertConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { ToolRegistry } from "./tools/registry.js";
import { benefitsTools } from "./tools/benefits.js";
import { timeoffTools } from "./tools/timeoff.js";
import { approvalTools } from "./tools/approvals.js";
import { PolicyEngine } from "./policy/engine.js";
import {
  enforceSelfServiceScope,
  enforceApprovalAuthority,
  enforceEnrollmentWindow,
} from "./policy/rules.js";
import { MockHCMClient } from "./integrations/mock-hcm.js";
import { FileAuditLogger } from "./observability/audit.js";
import { buildLLMClient } from "./llm/factory.js";
import type { Message } from "./llm/types.js";

async function main(): Promise<void> {
  assertConfig();

  const llm = buildLLMClient();
  const hcm = new MockHCMClient();

  const tools = new ToolRegistry();
  for (const tool of [
    ...benefitsTools(hcm),
    ...timeoffTools(hcm),
    ...approvalTools(hcm),
  ]) {
    tools.register(tool);
  }

  const policy = new PolicyEngine()
    .use(enforceSelfServiceScope)
    .use(enforceApprovalAuthority)
    .use(
      enforceEnrollmentWindow(
        new Date("2026-04-01"),
        new Date("2026-05-31")
      )
    );

  const audit = new FileAuditLogger(config.auditPath);

  const orchestrator = new Orchestrator({
    llm,
    tools,
    policy,
    audit,
    maxIterations: config.maxIterations,
    maxCostUsd: config.maxCostUsd,
  });

  // Default identity for the CLI. In a real app this comes from auth.
  const ctx = { userId: "emp-001", roles: ["employee", "manager"] };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Enterprise Workflow Agent");
  console.log(`Provider: ${llm.provider}  Model: ${llm.modelId}`);
  console.log(`User: ${ctx.userId}  Roles: ${ctx.roles.join(", ")}`);
  console.log("Type 'exit' to quit. Type 'reset' to clear conversation history.\n");

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  let history: Message[] = [];

  while (true) {
    const input = await ask("> ");
    if (input.trim() === "exit") break;
    if (input.trim() === "reset") {
      history = [];
      console.log("\n[history cleared]\n");
      continue;
    }
    if (!input.trim()) continue;

    try {
      const result = await orchestrator.run(input, ctx, history);
      history = result.messages;

      if (result.status === "ok") {
        console.log(`\n${result.text}\n`);
        console.log(
          `[trace=${result.traceId.slice(0, 8)} iter=${result.iterations} cost=$${result.costUsd.toFixed(4)}]\n`
        );
      } else {
        console.log(`\n[${result.status}] ${result.reason ?? ""}\n`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\nError: ${message}\n`);
    }
  }

  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
