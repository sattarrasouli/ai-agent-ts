import { callModel } from "./llm.js";
import { toolDefinitions, executeTool } from "../tools/index.js";
import type { ChatMessage } from "../types.js";

const SYSTEM_PROMPT = `You are a coding agent operating inside a user's repository.

You can read and write files and run shell commands, all scoped to the workspace.
Work step by step:
- Explore the codebase (list_dir, read_file) before making changes.
- Make focused edits with write_file. Read a file before you overwrite it.
- Verify your work by running tests or builds with run_command.
- When the task is complete, stop calling tools and reply with a short summary.

Be careful and concise. Never invent file contents — read before you edit.`;

// Safety limit: never loop forever, even if the model misbehaves.
const MAX_ITERATIONS = 25;
// Guard against a giant file blowing up the context window.
const MAX_TOOL_OUTPUT = 20_000;

export async function runAgent(workspace: string, task: string): Promise<void> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // 1. Ask the model what to do next.
    const assistant = await callModel(messages, toolDefinitions);
    messages.push(assistant); // record its turn in history

    // 2. No tool calls means the model is done — print its answer and stop.
    if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
      console.log(`\n✅ ${assistant.content ?? "(done)"}`);
      return;
    }

    // 3. Otherwise run every tool it asked for and feed results back.
    for (const call of assistant.tool_calls) {
      let args: Record<string, any>;
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "Error: tool arguments were not valid JSON.",
        });
        continue;
      }

      console.log(`\n🔧 ${call.function.name}(${preview(call.function.arguments)})`);
      const result = await executeTool(workspace, call.function.name, args);
      console.log(result.ok ? "   ↳ ok" : `   ↳ failed: ${preview(result.output)}`);

      // The tool result goes back as a "tool" role message keyed by call id.
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.output.slice(0, MAX_TOOL_OUTPUT),
      });
    }
  }

  console.log(`\n⛔ Stopped after ${MAX_ITERATIONS} iterations (safety limit).`);
}

// Shorten long strings for clean console logging.
function preview(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? flat.slice(0, 80) + "…" : flat;
}