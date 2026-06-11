import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

// The single most important safety control for a coding agent:
// resolve any model-supplied path and PROVE it stays inside the workspace.
// Blocks "../../etc/passwd" style traversal and absolute paths.
export function resolveInWorkspace(workspace: string, relativePath: string): string {
  const root = path.resolve(workspace);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Path "${relativePath}" escapes the workspace. Refused.`);
  }
  return target;
}

// Human-in-the-loop gate for dangerous actions (shell commands).
// Set AUTO_APPROVE=1 to skip — useful for trusted automation, dangerous otherwise.
export async function confirm(question: string): Promise<boolean> {
  if (process.env.AUTO_APPROVE === "1") return true;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}