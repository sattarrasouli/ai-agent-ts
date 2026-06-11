import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolveInWorkspace, confirm } from "../utils/safety.js";
import type { ToolDefinition, ToolResult } from "../types.js";

const execAsync = promisify(exec);

// These definitions are sent to the model so it knows what it can call.
// Descriptions matter: the model picks tools based on them.
export const toolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a text file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a text file in the workspace. Always read a file before overwriting it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and folders in a workspace directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path relative to workspace root. Use '.' for the root.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the workspace (builds, tests, git, installing deps). Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run" },
        },
        required: ["command"],
      },
    },
  },
];

// Dispatch a single tool call. Errors are CAUGHT and returned as ToolResult
// so the model can read the error and try to recover, rather than crashing.
export async function executeTool(
  workspace: string,
  name: string,
  args: Record<string, any>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "read_file":
        return await readFile(workspace, args.path);
      case "write_file":
        return await writeFile(workspace, args.path, args.content);
      case "list_dir":
        return await listDir(workspace, args.path);
      case "run_command":
        return await runCommand(workspace, args.command);
      default:
        return { ok: false, output: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, output: `Error: ${(err as Error).message}` };
  }
}

async function readFile(ws: string, p: string): Promise<ToolResult> {
  const abs = resolveInWorkspace(ws, p);
  const content = await fs.readFile(abs, "utf8");
  return { ok: true, output: content };
}

async function writeFile(ws: string, p: string, content: string): Promise<ToolResult> {
  const abs = resolveInWorkspace(ws, p);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return { ok: true, output: `Wrote ${content.length} bytes to ${p}` };
}

async function listDir(ws: string, p: string): Promise<ToolResult> {
  const abs = resolveInWorkspace(ws, p);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const lines = entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  return { ok: true, output: lines.join("\n") || "(empty)" };
}

async function runCommand(ws: string, command: string): Promise<ToolResult> {
  // Gate every command behind explicit approval.
  const approved = await confirm(`\n⚠️  The agent wants to run:\n    ${command}\nAllow?`);
  if (!approved) return { ok: false, output: "Command rejected by user." };

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: ws,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, output: (stdout + stderr).trim() || "(no output)" };
  } catch (err: any) {
    // Non-zero exit: still return stdout/stderr so the model sees what failed.
    const out = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n");
    return { ok: false, output: out.trim() || "Command failed." };
  }
}