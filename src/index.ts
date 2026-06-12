// agent.ts — an interactive LLM-in-a-loop agent with sandboxed tools.
// Run:  set DEEPSEEK_API_KEY in .env   then   npx tsx src/index.ts
import "dotenv/config"; // load .env so DEEPSEEK_API_KEY is available
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// ─────────────────────────────────────────────────────────────────────────────
// Config — everything provider/model specific lives here, so swapping providers
// (or models) is a one-line change rather than a hunt through the code.
// ─────────────────────────────────────────────────────────────────────────────
const config = {
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseUrl: process.env.AGENT_BASE_URL ?? "https://api.deepseek.com/chat/completions",
  model: process.env.AGENT_MODEL ?? "deepseek-v4-flash",
  // Tools may only read inside this root. Anything outside is rejected.
  rootDir: path.resolve(process.cwd()),
};

if (!config.apiKey) {
  throw new Error("DEEPSEEK_API_KEY is not set. Add it to your .env file.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety helpers
// ─────────────────────────────────────────────────────────────────────────────

// Resolve a user/model-supplied path and ensure it stays inside rootDir.
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. The tools the model is allowed to call.
// ─────────────────────────────────────────────────────────────────────────────
const tools = [
  {
    type: "function",
    function: {
      name: "calculator",
      description: "Evaluate a math expression, e.g. '1234 * 5678'",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description:
        "Get the current date and time. Optionally pass an IANA timezone, e.g. 'America/New_York'.",
      parameters: {
        type: "object",
        properties: { timezone: { type: "string" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read and return the full text contents of a file at the given path.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path to the file to read" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List the names of files and subdirectories in a directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path (defaults to '.')" } },
        required: [],
      },
    },
  },
];

// Tool implementations, keyed by name. Each takes parsed args and returns a string.
const toolHandlers: Record<string, (args: any) => string> = {
  calculator: ({ expression }) => {
    try {
      return String(evalArithmetic(expression));
    } catch (err: any) {
      return `Error evaluating '${expression}': ${err.message}`;
    }
  },
  get_current_time: ({ timezone }) =>
    new Date().toLocaleString("en-US", timezone ? { timeZone: timezone } : {}),
  read_file: ({ path: filePath }) => {
    try {
      return fs.readFileSync(safeResolve(filePath), "utf8");
    } catch (err: any) {
      return `Error reading '${filePath}': ${err.message}`;
    }
  },
  list_directory: ({ path: dirPath }) => {
    const dir = dirPath || ".";
    try {
      const entries = fs.readdirSync(safeResolve(dir), { withFileTypes: true });
      return entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join("\n");
    } catch (err: any) {
      return `Error listing '${dir}': ${err.message}`;
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. The conversation so far (persists across turns within a session).
// ─────────────────────────────────────────────────────────────────────────────
const messages: any[] = [];

// Run one user turn: feed it to the model, run any tools it asks for, repeat
// until the model produces a final answer. Returns the assistant's answer text.
async function runTurn(): Promise<string> {
  while (true) {
    const res = await fetch(config.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, messages, tools }),
    });
    const data = await res.json();
    if (!res.ok || !data.choices) {
      throw new Error(`API error ${res.status}: ${JSON.stringify(data)}`);
    }
    const msg = data.choices[0].message;
    messages.push(msg); // remember what the model said

    if (!msg.tool_calls) {
      return msg.content; // no tool requested → it's the final answer
    }

    for (const call of msg.tool_calls) {
      // run each requested tool by looking it up by name
      const handler = toolHandlers[call.function.name];
      const args = JSON.parse(call.function.arguments);
      const result = handler
        ? handler(args)
        : `Error: unknown tool '${call.function.name}'`;
      console.log(`  ↳ ${call.function.name}(${call.function.arguments}) = ${result}`);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Interactive REPL — read user input, run a turn, repeat. Ctrl+C or "exit".
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log("Agent ready. Type a message, or 'exit' to quit.\n");

  while (true) {
    const input = (await ask("you › ")).trim();
    if (!input) continue;
    if (input === "exit" || input === "quit") break;

    messages.push({ role: "user", content: input });
    try {
      const answer = await runTurn();
      console.log(`\nagent › ${answer}\n`);
    } catch (err: any) {
      console.error(`\n[error] ${err.message}\n`);
    }
  }

  rl.close();
}

main();
