// agent.ts — the conversation loop: build a request via the active provider,
// stream the reply, run any requested tools (with approval), and repeat until a
// final answer. Turns are abortable via an AbortSignal (Ctrl+C cancellation).
import * as fs from "fs";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { truncate, sleep } from "./safety.js";
import { registry, toolSchemas } from "./tools.js";
import { getProvider, type Provider } from "./providers.js";

// Callbacks the REPL supplies so the agent core stays free of terminal I/O.
export interface UI {
  confirm(action: string, signal: AbortSignal): Promise<boolean>;
  token(text: string): void; // a streamed assistant text fragment
  endAssistant(): void; // end-of-stream marker (e.g. print trailing newline)
}

const provider: Provider = getProvider();

// System prompt + conversation state (persists across turns within a session).
export const messages: any[] = [
  {
    role: "system",
    content:
      "You are a helpful, careful coding agent operating inside a project directory. " +
      "Use the provided tools to inspect and modify files, run commands, search, and fetch URLs. " +
      "Prefer reading before writing. Be concise.",
  },
];

export const usageTotal = { prompt: 0, completion: 0 };

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

// POST to the provider, retrying transient failures (429/5xx/network) with
// exponential backoff. Does not retry once the signal is aborted.
async function fetchWithRetry(body: string, signal: AbortSignal): Promise<Response> {
  let lastErr: any;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (signal.aborted) throw new AbortError();
    try {
      const res = await fetch(provider.endpoint, {
        method: "POST",
        headers: provider.headers(),
        body,
        signal,
      });
      if (res.ok && res.body) return res;
      if (res.status !== 429 && res.status < 500) {
        const errText = await res.text().catch(() => "");
        throw new Error(`API error ${res.status}: ${errText}`);
      }
      lastErr = new Error(`API error ${res.status}`);
    } catch (err: any) {
      if (err.name === "AbortError") throw err;
      lastErr = err;
      if (/API error 4\d\d/.test(err.message)) throw err; // non-retryable
    }
    if (attempt < config.maxRetries) {
      const delay = 500 * 2 ** attempt;
      logger.warn(`retrying request`, { reason: lastErr?.message, delayMs: delay });
      await sleep(delay);
    }
  }
  throw new Error(`Request failed after ${config.maxRetries + 1} attempts: ${lastErr?.message}`);
}

// Read the SSE stream, normalize each event via the provider, print assistant
// text live through the UI, and assemble tool calls (fragmented by index).
async function readStream(
  body: ReadableStream<Uint8Array>,
  ui: UI,
): Promise<{ content: string; toolCalls: any[]; usage: { prompt: number; completion: number } }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls: any[] = [];
  const usage = { prompt: 0, completion: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep the trailing partial line

    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = provider.parseEvent(json);
      if (!delta) continue;

      if (delta.contentDelta) {
        ui.token(delta.contentDelta);
        content += delta.contentDelta;
      }
      for (const tcd of delta.toolCallDeltas ?? []) {
        const idx = tcd.index ?? 0;
        if (!toolCalls[idx]) {
          toolCalls[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
        }
        if (tcd.id) toolCalls[idx].id = tcd.id;
        if (tcd.name) toolCalls[idx].function.name += tcd.name;
        if (tcd.argsFragment) toolCalls[idx].function.arguments += tcd.argsFragment;
      }
      if (delta.usage) {
        if (delta.usage.prompt) usage.prompt += delta.usage.prompt;
        if (delta.usage.completion) usage.completion += delta.usage.completion;
      }
    }
  }
  return { content, toolCalls: toolCalls.filter(Boolean), usage };
}

// Run one user turn to completion (or until aborted / the iteration cap).
export async function runTurn(ui: UI, signal: AbortSignal): Promise<void> {
  for (let iter = 0; ; iter++) {
    if (signal.aborted) throw new AbortError();
    if (iter >= config.maxToolIterations) {
      logger.warn(`stopped at tool-iteration cap`, { cap: config.maxToolIterations });
      return;
    }

    const res = await fetchWithRetry(JSON.stringify(provider.buildBody(messages, toolSchemas)), signal);
    const { content, toolCalls, usage } = await readStream(res.body!, ui);
    ui.endAssistant();

    if (usage.prompt || usage.completion) {
      usageTotal.prompt += usage.prompt;
      usageTotal.completion += usage.completion;
      logger.info("token usage", {
        in: usage.prompt,
        out: usage.completion,
        sessionIn: usageTotal.prompt,
        sessionOut: usageTotal.completion,
      });
    }

    const assistantMsg: any = { role: "assistant", content: content || null };
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
    messages.push(assistantMsg);

    if (!toolCalls.length) return; // final answer already streamed via the UI

    for (const call of toolCalls) {
      if (signal.aborted) throw new AbortError();
      const tool = registry[call.function.name];
      let args: any = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        /* leave args empty; handler will report */
      }

      let result: string;
      if (!tool) {
        result = `Error: unknown tool '${call.function.name}'`;
      } else if (tool.approvalMessage && !(await ui.confirm(tool.approvalMessage(args), signal))) {
        result = signal.aborted ? "Aborted by user." : "Denied by user.";
        logger.info(`tool ${signal.aborted ? "aborted" : "denied"}`, { tool: call.function.name });
      } else {
        result = await tool.run(args);
        logger.info("tool result", {
          tool: call.function.name,
          args: call.function.arguments,
          result: truncate(result, 200),
        });
      }
      if (signal.aborted) throw new AbortError();
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
}

// ─── Session persistence ─────────────────────────────────────────────────────
export function saveSession(): void {
  try {
    fs.writeFileSync(config.sessionFile, JSON.stringify(messages, null, 2), "utf8");
  } catch (err: any) {
    logger.warn("could not save session", { error: err.message });
  }
}

export function loadSession(): void {
  if (!fs.existsSync(config.sessionFile)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(config.sessionFile, "utf8"));
    if (Array.isArray(saved) && saved.length) {
      messages.length = 0;
      messages.push(...saved);
      const turns = saved.filter((m: any) => m.role === "user").length;
      logger.info("resumed previous session", { priorMessages: turns });
    }
  } catch (err: any) {
    logger.warn("could not load session", { error: err.message });
  }
}

export function resetSession(): void {
  messages.length = 1; // keep only the system prompt
  usageTotal.prompt = 0;
  usageTotal.completion = 0;
  try {
    if (fs.existsSync(config.sessionFile)) fs.unlinkSync(config.sessionFile);
  } catch {
    /* ignore */
  }
}

export const isAbortError = (err: unknown): boolean =>
  err instanceof Error && err.name === "AbortError";
