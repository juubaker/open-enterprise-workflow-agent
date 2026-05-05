import type { AgentResult, AuditEvent, Identity, ServerMetadata } from "./types";

/**
 * Timeouts in milliseconds. /chat is long because LLM calls can legitimately
 * take 30+ seconds; /audit and /metadata are short because they hit local I/O
 * and an idle backend should fail fast, not block the UI for a minute.
 */
const TIMEOUTS = {
  chat: 90_000,
  audit: 10_000,
  metadata: 5_000,
};

async function jsonFetch<T>(
  url: string,
  init: RequestInit & { identity?: Identity; timeoutMs: number }
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (init.identity) {
    headers.set("x-user-id", init.identity.userId);
    headers.set("x-roles", init.identity.roles.join(","));
  }

  // Abort the fetch if the backend doesn't respond. Without this, a hung
  // backend leaves the UI in busy state forever — the symptom you'd see as
  // "the app stops responding."
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs);

  try {
    const res = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }
    return res.json();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(
        `Request timed out after ${init.timeoutMs / 1000}s. Is the backend (npm run server) still running?`
      );
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export async function postChat(
  message: string,
  history: any[],
  identity: Identity
): Promise<AgentResult> {
  return jsonFetch<AgentResult>("/chat", {
    method: "POST",
    body: JSON.stringify({ message, history }),
    identity,
    timeoutMs: TIMEOUTS.chat,
  });
}

export async function fetchAudit(
  limit = 500
): Promise<{ events: AuditEvent[]; total: number }> {
  return jsonFetch<{ events: AuditEvent[]; total: number }>(
    `/audit?limit=${limit}`,
    { timeoutMs: TIMEOUTS.audit }
  );
}

export async function fetchMetadata(): Promise<ServerMetadata> {
  return jsonFetch<ServerMetadata>("/metadata", { timeoutMs: TIMEOUTS.metadata });
}
