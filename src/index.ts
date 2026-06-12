// index.ts — interactive REPL entry point. Owns the terminal (readline), wires
// Ctrl+C to cancel the in-flight turn, and delegates the loop to agent.ts.
import "dotenv/config"; // load .env before anything reads process.env
import * as readline from "readline";
import { config, assertConfig } from "./config.js";
import {
  runTurn,
  loadSession,
  saveSession,
  resetSession,
  isAbortError,
  messages,
  type UI,
} from "./agent.js";

assertConfig();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, resolve));

// Lazily print the "agent › " header on the first streamed token, and a trailing
// newline once the assistant turn ends.
let headerPrinted = false;
const ui: UI = {
  token: (text) => {
    if (!headerPrinted) {
      process.stdout.write("\nagent › ");
      headerPrinted = true;
    }
    process.stdout.write(text);
  },
  endAssistant: () => {
    if (headerPrinted) process.stdout.write("\n");
    headerPrinted = false;
  },
  // Approval prompt that also unblocks if the turn is aborted mid-question.
  confirm: (action, signal) =>
    new Promise<boolean>((resolve) => {
      const onAbort = () => resolve(false);
      signal.addEventListener("abort", onAbort, { once: true });
      rl.question(`\n[approval] ${action}\n  allow? (y/N) `, (answer) => {
        signal.removeEventListener("abort", onAbort);
        const a = answer.trim().toLowerCase();
        resolve(a === "y" || a === "yes");
      });
    }),
};

// Ctrl+C: cancel the active turn if one is running, otherwise quit.
let activeAbort: AbortController | null = null;
rl.on("SIGINT", () => {
  if (activeAbort) {
    activeAbort.abort();
  } else {
    rl.close();
    process.exit(0);
  }
});

async function main() {
  loadSession();
  console.log(
    `Agent ready (provider: ${config.provider}, model: ${config.model}).\n` +
      "Type a message, 'reset' to clear, or 'exit' to quit. Ctrl+C cancels a running turn.\n",
  );

  while (true) {
    const input = (await ask("you › ")).trim();
    if (!input) continue;
    if (input === "exit" || input === "quit") break;
    if (input === "reset") {
      resetSession();
      console.log("Session reset.");
      continue;
    }

    messages.push({ role: "user", content: input });

    activeAbort = new AbortController();
    try {
      await runTurn(ui, activeAbort.signal);
      saveSession();
      console.log("");
    } catch (err: any) {
      if (isAbortError(err)) {
        ui.endAssistant();
        console.log("\n[cancelled]\n");
      } else {
        console.error(`\n[error] ${err.message}\n`);
      }
    } finally {
      activeAbort = null;
    }
  }

  rl.close();
}

main();
