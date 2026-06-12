// agent.ts — the simplest possible agent: an LLM in a loop with one tool.
// Run:  set DEEPSEEK_API_KEY in .env   then   npx tsx src/index.ts
import "dotenv/config"; // load .env so DEEPSEEK_API_KEY is available
import * as fs from "fs";

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  throw new Error("DEEPSEEK_API_KEY is not set. Add it to your .env file.");
}

// 1. The tools the model is allowed to call.
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
  calculator: ({ expression }) => String(eval(expression)), // demo only, never on real input
  get_current_time: ({ timezone }) =>
    new Date().toLocaleString("en-US", timezone ? { timeZone: timezone } : {}),
  read_file: ({ path: filePath }) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (err: any) {
      return `Error reading '${filePath}': ${err.message}`;
    }
  },
  list_directory: ({ path: dirPath }) => {
    const dir = dirPath || ".";
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join("\n");
    } catch (err: any) {
      return `Error listing '${dir}': ${err.message}`;
    }
  },
};

// 2. The conversation so far.
const messages: any[] = [
  { role: "user", content: "What is 1234 * 5678, then add 9?" },
];

async function main() {
  // 3. The loop: ask the model → run any tool it asks for → repeat.
  while (true) {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages, tools }),
    });
    console.log("res", res);
    const data = await res.json();
    if (!res.ok || !data.choices) {
      throw new Error(`API error ${res.status}: ${JSON.stringify(data)}`);
    }
    const msg = data.choices[0].message;
    messages.push(msg); // remember what the model said

    if (!msg.tool_calls) {
      // no tool requested → it's done
      console.log("\nAnswer:", msg.content);
      return;
    }

    for (const call of msg.tool_calls) {
      // run each requested tool by looking it up by name
      const handler = toolHandlers[call.function.name];
      const args = JSON.parse(call.function.arguments);
      const result = handler
        ? handler(args)
        : `Error: unknown tool '${call.function.name}'`;
      console.log(`${call.function.name}(${call.function.arguments}) = ${result}`);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }
}

main();
