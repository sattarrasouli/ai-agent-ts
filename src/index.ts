// Load .env before anything else so DEEPSEEK_API_KEY & co. are available.
import "dotenv/config";

import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runAgent } from "./core/agent.js";

async function main() {
  // Workspace defaults to the current directory; override with --workspace <dir>.
  const wsFlag = process.argv.indexOf("--workspace");
  const workspace =
    wsFlag !== -1 && process.argv[wsFlag + 1]
      ? path.resolve(process.argv[wsFlag + 1])
      : process.cwd();

  // The task is any remaining args; if none, ask interactively.
  const argTask = process.argv
    .slice(2)
    .filter((a, idx, arr) => a !== "--workspace" && arr[idx - 1] !== "--workspace")
    .join(" ")
    .trim();

  let task = argTask;
  if (!task) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    task = (await rl.question("What should the agent do?\n> ")).trim();
    rl.close();
  }

  if (!task) {
    console.error("No task provided.");
    process.exit(1);
  }

  console.log(`\n📂 Workspace: ${workspace}`);
  console.log(`🎯 Task: ${task}`);

  await runAgent(workspace, task);
}

main().catch((err) => {
  console.error("\nFatal:", err.message);
  process.exit(1);
});