// agent.ts — an interactive, streaming LLM-in-a-loop agent with sandboxed tools
// and human-in-the-loop approval for anything that mutates or executes.
// Run:  set DEEPSEEK_API_KEY in .env   then   npx tsx src/index.ts
import "dotenv/config"; // load .env so DEEPSEEK_API_KEY is available
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
// Config — everything provider/model specific lives here, so swapping providers
// (or models) is a one-line change rather than a hunt through the code.
// ─────────────────────────────────────────────────────────────────────────────
const config = {
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseUrl: process.env.AGENT_BASE_URL ?? "https://api.deepseek.com/chat/completions",
  model: process.env.AGENT_MODEL ?? "deepseek-v4-flash",
  // Tools may only touch paths inside this root. Anything outside is rejected.
  rootDir: path.resolve(process.cwd()),
  commandTimeoutMs: 30_000,
  maxRetries: 4, // API retry attempts on 429/5xx/network errors
  maxToolIterations: 25, // safety cap on tool-call loops within one turn
  sessionFile: path.resolve(process.cwd(), ".agent-session.json"),
};

if (!config.apiKey) {
  throw new Error("DEEPSEEK_API_KEY is not set. Add it to your .env file.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared readline — used by both the REPL and the approval prompts.
// ─────────────────────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, resolve));

async function confirm(action: string): Promise<boolean> {
  const answer = (await ask(`\n[approval] ${action}\n  allow? (y/N) `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety helpers
// ─────────────────────────────────────────────────────────────────────────────

// Resolve a model-supplied path and ensure it stays inside rootDir.
// Throws on traversal attempts (e.g. "../../etc/passwd" or absolute paths out).
function safeResolve(p: string): string {
  const resolved = path.resolve(config.rootDir, p);
  if (resolved !== config.rootDir && !resolved.startsWith(config.rootDir + path.sep)) {
    throw new Error(`Path '${p}' is outside the project root and is not allowed.`);
  }
  return resolved;
}

// A tiny safe arithmetic evaluator (recursive descent) — no eval(), so model
// output can never execute arbitrary code. Supports + - * / % ( ) and decimals.
function evalArithmetic(expr: string): number {
  let i = 0;
  const s = expr.replace(/\s+/g, "");

  function parseExpr(): number {
    let v = parseTerm();
    while (s[i] === "+" || s[i] === "-") {
      const op = s[i++];
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  function parseTerm(): number {
    let v = parseFactor();
    while (s[i] === "*" || s[i] === "/" || s[i] === "%") {
      const op = s[i++];
      const r = parseFactor();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  }
  function parseFactor(): number {
    if (s[i] === "(") {
      i++;
      const v = parseExpr();
      if (s[i] !== ")") throw new Error("missing closing paren");
      i++;
      return v;
    }
    if (s[i] === "-") { i++; return -parseFactor(); }
    if (s[i] === "+") { i++; return parseFactor(); }
    const start = i;
    while (i < s.length && /[0-9.]/.test(s[i])) i++;
    if (i === start) throw new Error(`unexpected token at '${s.slice(i)}'`);
    return parseFloat(s.slice(start, i));
  }

  const result = parseExpr();
  if (i !== s.length) throw new Error(`unexpected token at '${s.slice(i)}'`);
  return result;
}

const truncate = (s: string, n = 2000): string =>
  s.length > n ? s.slice(0, n) + `\n… [truncated, ${s.length} chars total]` : s;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Running token totals across the whole session.
const usageTotal = { prompt: 0, completion: 0 };

// POST to the API, retrying on transient failures (429, 5xx, network errors)
// with exponential backoff. Throws on non-retryable errors or exhausted retries.
async function fetchWithRetry(body: string): Promise<Response> {
  let lastErr: any;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const res = await fetch(config.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body,
      });
      if (res.ok && res.body) return res;
      // Retry on rate-limit / server errors; fail fast on 4xx (bad request, auth).
      if (res.status !== 429 && res.status < 500) {
        const errText = await res.text().catch(() => "");
        throw new Error(`API error ${res.status}: ${errText}`);
      }
      lastErr = new Error(`API error ${res.status}`);
    } catch (err: any) {
      lastErr = err;
      if (/API error 4\d\d/.test(err.message)) throw err; // non-retryable
    }
    if (attempt < config.maxRetries) {
      const delay = 500 * 2 ** attempt;
      console.error(`  [retry] ${lastErr.message} — backing off ${delay}ms`);
      await sleep(delay);
    }
  }
  throw new Error(`Request failed after ${config.maxRetries + 1} attempts: ${lastErr?.message}`);
}

// Recursively walk rootDir collecting text-file paths, skipping noisy dirs.
function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool registry — schema + implementation in one place. `approvalMessage`, when
// present, gates the tool behind a y/N confirmation describing the action.
// ─────────────────────────────────────────────────────────────────────────────
type Tool = {
  schema: { name: string; description: string; parameters: any };
  approvalMessage?: (args: any) => string;
  run: (args: any) => string | Promise<string>;
};

const registry: Record<string, Tool> = {
  calculator: {
    schema: {
      name: "calculator",
      description: "Evaluate a math expression, e.g. '1234 * 5678'.",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
    },
    run: ({ expression }) => {
      try {
        return String(evalArithmetic(expression));
      } catch (err: any) {
        return `Error evaluating '${expression}': ${err.message}`;
      }
    },
  },

  get_current_time: {
    schema: {
      name: "get_current_time",
      description:
        "Get the current date and time. Optionally pass an IANA timezone, e.g. 'America/New_York'.",
      parameters: {
        type: "object",
        properties: { timezone: { type: "string" } },
        required: [],
      },
    },
    run: ({ timezone }) =>
      new Date().toLocaleString("en-US", timezone ? { timeZone: timezone } : {}),
  },

  read_file: {
    schema: {
      name: "read_file",
      description: "Read and return the full text contents of a file at the given path.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path to the file to read" } },
        required: ["path"],
      },
    },
    run: ({ path: filePath }) => {
      try {
        return fs.readFileSync(safeResolve(filePath), "utf8");
      } catch (err: any) {
        return `Error reading '${filePath}': ${err.message}`;
      }
    },
  },

  list_directory: {
    schema: {
      name: "list_directory",
      description: "List the names of files and subdirectories in a directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path (defaults to '.')" } },
        required: [],
      },
    },
    run: ({ path: dirPath }) => {
      const dir = dirPath || ".";
      try {
        const entries = fs.readdirSync(safeResolve(dir), { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
      } catch (err: any) {
        return `Error listing '${dir}': ${err.message}`;
      }
    },
  },

  write_file: {
    schema: {
      name: "write_file",
      description:
        "Create or overwrite a file with the given content. Parent directories are created as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to write" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
      },
    },
    approvalMessage: ({ path: p, content }) =>
      `write_file → ${p} (${(content ?? "").length} chars)`,
    run: ({ path: filePath, content }) => {
      try {
        const target = safeResolve(filePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content ?? "", "utf8");
        return `Wrote ${(content ?? "").length} chars to '${filePath}'.`;
      } catch (err: any) {
        return `Error writing '${filePath}': ${err.message}`;
      }
    },
  },

  edit_file: {
    schema: {
      name: "edit_file",
      description:
        "Replace an exact substring in a file. `old_string` must appear exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string", description: "Exact text to replace" },
          new_string: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    approvalMessage: ({ path: p }) => `edit_file → ${p}`,
    run: ({ path: filePath, old_string, new_string }) => {
      try {
        const target = safeResolve(filePath);
        const original = fs.readFileSync(target, "utf8");
        const count = original.split(old_string).length - 1;
        if (count === 0) return `Error: old_string not found in '${filePath}'.`;
        if (count > 1) return `Error: old_string appears ${count} times in '${filePath}'; must be unique.`;
        fs.writeFileSync(target, original.replace(old_string, new_string), "utf8");
        return `Edited '${filePath}'.`;
      } catch (err: any) {
        return `Error editing '${filePath}': ${err.message}`;
      }
    },
  },

  run_command: {
    schema: {
      name: "run_command",
      description:
        "Run a shell command in the project root and return its stdout/stderr. Times out after 30s.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
    approvalMessage: ({ command }) => `run_command → ${command}`,
    run: async ({ command }) => {
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: config.rootDir,
          timeout: config.commandTimeoutMs,
          maxBuffer: 1024 * 1024,
        });
        return (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim() || "(no output)";
      } catch (err: any) {
        return `Command failed: ${err.message}\n${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
      }
    },
  },

  grep: {
    schema: {
      name: "grep",
      description:
        "Search all project text files for a regex pattern. Returns file:line: matched-line, capped at 100 hits.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regex source" },
          flags: { type: "string", description: "Optional regex flags, e.g. 'i'" },
        },
        required: ["pattern"],
      },
    },
    run: ({ pattern, flags }) => {
      let re: RegExp;
      try {
        re = new RegExp(pattern, flags ?? "");
      } catch (err: any) {
        return `Invalid regex: ${err.message}`;
      }
      const hits: string[] = [];
      for (const file of walkFiles(config.rootDir)) {
        let text: string;
        try {
          text = fs.readFileSync(file, "utf8");
        } catch {
          continue; // skip binary/unreadable files
        }
        const rel = path.relative(config.rootDir, file);
        const lines = text.split("\n");
        for (let n = 0; n < lines.length; n++) {
          if (re.test(lines[n])) {
            hits.push(`${rel}:${n + 1}: ${lines[n].trim()}`);
            if (hits.length >= 100) return hits.join("\n") + "\n… [capped at 100 hits]";
          }
        }
      }
      return hits.length ? hits.join("\n") : "No matches.";
    },
  },

  fetch_url: {
    schema: {
      name: "fetch_url",
      description: "HTTP GET a URL and return the response body as text (truncated).",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
    run: async ({ url }) => {
      try {
        const res = await fetch(url);
        const body = await res.text();
        return `HTTP ${res.status}\n${truncate(body, 4000)}`;
      } catch (err: any) {
        return `Error fetching '${url}': ${err.message}`;
      }
    },
  },
};

const toolSchemas = Object.values(registry).map((t) => ({
  type: "function",
  function: t.schema,
}));

// ─────────────────────────────────────────────────────────────────────────────
// System prompt + conversation state (persists across turns within a session).
// ─────────────────────────────────────────────────────────────────────────────
const messages: any[] = [
  {
    role: "system",
    content:
      "You are a helpful, careful coding agent operating inside a project directory. " +
      "Use the provided tools to inspect and modify files, run commands, search, and fetch URLs. " +
      "Prefer reading before writing. Be concise.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Streaming: read the SSE response, print assistant tokens live, and assemble
// any tool calls (whose name/arguments arrive in fragments) by index.
// ─────────────────────────────────────────────────────────────────────────────
async function readStream(
  body: ReadableStream<Uint8Array>,
): Promise<{ content: string; toolCalls: any[]; usage: any }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let headerPrinted = false;
  let usage: any = null;
  const toolCalls: any[] = [];

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
      if (json.usage) usage = json.usage; // final chunk carries token usage
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        if (!headerPrinted) {
          process.stdout.write("\nagent › ");
          headerPrinted = true;
        }
        process.stdout.write(delta.content);
        content += delta.content;
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
    }
  }
  if (headerPrinted) process.stdout.write("\n");
  return { content, toolCalls: toolCalls.filter(Boolean), usage };
}

// Run one user turn: stream the model's reply, run any tools it asks for
// (gated by approval where required), and repeat until it gives a final answer.
async function runTurn(): Promise<void> {
  for (let iter = 0; ; iter++) {
    if (iter >= config.maxToolIterations) {
      console.error(`\n[limit] stopped after ${config.maxToolIterations} tool iterations.`);
      return;
    }

    const res = await fetchWithRetry(
      JSON.stringify({
        model: config.model,
        messages,
        tools: toolSchemas,
        stream: true,
        stream_options: { include_usage: true },
      }),
    );

    const { content, toolCalls, usage } = await readStream(res.body!);

    if (usage) {
      usageTotal.prompt += usage.prompt_tokens ?? 0;
      usageTotal.completion += usage.completion_tokens ?? 0;
      console.log(
        `  [tokens] +${usage.prompt_tokens ?? 0} in / +${usage.completion_tokens ?? 0} out` +
          ` · session ${usageTotal.prompt}/${usageTotal.completion}`,
      );
    }

    const assistantMsg: any = { role: "assistant", content: content || null };
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
    messages.push(assistantMsg);

    if (!toolCalls.length) return; // final answer already streamed to stdout

    for (const call of toolCalls) {
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
      } else if (tool.approvalMessage && !(await confirm(tool.approvalMessage(args)))) {
        result = "Denied by user.";
        console.log(`  ↳ ${call.function.name} — denied`);
      } else {
        result = await tool.run(args);
        console.log(`  ↳ ${call.function.name}(${call.function.arguments}) = ${truncate(result, 200)}`);
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — save/load conversation history so sessions survive restarts.
// Only the system message is kept on reset; the file lives in the project root.
// ─────────────────────────────────────────────────────────────────────────────
function saveSession(): void {
  try {
    fs.writeFileSync(config.sessionFile, JSON.stringify(messages, null, 2), "utf8");
  } catch (err: any) {
    console.error(`  [warn] could not save session: ${err.message}`);
  }
}

function loadSession(): void {
  if (!fs.existsSync(config.sessionFile)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(config.sessionFile, "utf8"));
    if (Array.isArray(saved) && saved.length) {
      messages.length = 0;
      messages.push(...saved);
      const turns = saved.filter((m: any) => m.role === "user").length;
      console.log(`Resumed previous session (${turns} prior message(s)).`);
    }
  } catch (err: any) {
    console.error(`  [warn] could not load session: ${err.message}`);
  }
}

function resetSession(): void {
  messages.length = 1; // keep only the system prompt
  usageTotal.prompt = 0;
  usageTotal.completion = 0;
  try {
    if (fs.existsSync(config.sessionFile)) fs.unlinkSync(config.sessionFile);
  } catch {
    /* ignore */
  }
  console.log("Session reset.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactive REPL — read user input, run a turn, repeat.
// Commands: "exit"/"quit" to leave, "reset" to clear history.
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  loadSession();
  console.log("Agent ready. Type a message, 'reset' to clear, or 'exit' to quit.\n");

  while (true) {
    const input = (await ask("you › ")).trim();
    if (!input) continue;
    if (input === "exit" || input === "quit") break;
    if (input === "reset") {
      resetSession();
      continue;
    }

    messages.push({ role: "user", content: input });
    try {
      await runTurn();
      saveSession();
      console.log("");
    } catch (err: any) {
      console.error(`\n[error] ${err.message}\n`);
    }
  }

  rl.close();
}

main();
