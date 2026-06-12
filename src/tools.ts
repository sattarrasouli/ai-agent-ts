// tools.ts — the tool registry: schema + implementation per tool, in one place.
// `approvalMessage`, when present, means the agent must get a y/N confirmation
// (describing the action) before running it.
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { config } from "./config.js";
import { safeResolve, evalArithmetic, truncate, walkFiles } from "./safety.js";
import type { ToolSchema } from "./providers.js";

const execAsync = promisify(exec);

export type Tool = {
  schema: ToolSchema;
  approvalMessage?: (args: any) => string;
  run: (args: any) => string | Promise<string>;
};

// Web search: uses Brave Search if BRAVE_SEARCH_API_KEY is set, otherwise falls
// back to scraping DuckDuckGo's HTML endpoint (keyless but best-effort/brittle).
async function webSearch(query: string, count: number): Promise<string> {
  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  try {
    if (braveKey) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": braveKey },
      });
      if (!res.ok) return `Brave search error: HTTP ${res.status}`;
      const data: any = await res.json();
      const results = (data.web?.results ?? []).slice(0, count);
      if (!results.length) return "No results.";
      return results
        .map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description ?? ""}`)
        .join("\n");
    }

    // DuckDuckGo HTML fallback — parse result anchors and snippets.
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ai-agent-ts/1.0)" },
    });
    if (!res.ok) return `DuckDuckGo search error: HTTP ${res.status}`;
    const html = await res.text();
    const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
    const snippetRe = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;
    const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const decode = (href: string) => {
      const m = href.match(/[?&]uddg=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : href;
    };
    const links = [...html.matchAll(linkRe)].slice(0, count);
    const snippets = [...html.matchAll(snippetRe)];
    if (!links.length) return "No results (or DuckDuckGo markup changed).";
    return links
      .map((m, i) => `${i + 1}. ${strip(m[2])}\n   ${decode(m[1])}\n   ${strip(snippets[i]?.[1] ?? "")}`)
      .join("\n");
  } catch (err: any) {
    return `Error searching for '${query}': ${err.message}`;
  }
}

export const registry: Record<string, Tool> = {
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
        return fs.readFileSync(safeResolve(config.rootDir, filePath), "utf8");
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
        const entries = fs.readdirSync(safeResolve(config.rootDir, dir), { withFileTypes: true });
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
        const target = safeResolve(config.rootDir, filePath);
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
        const target = safeResolve(config.rootDir, filePath);
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

  web_search: {
    schema: {
      name: "web_search",
      description:
        "Search the web and return the top results (title, URL, snippet). Use to discover URLs, then fetch_url to read them.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          count: { type: "number", description: "Number of results (default 5)" },
        },
        required: ["query"],
      },
    },
    run: ({ query, count }) => webSearch(query, count ?? 5),
  },
};

// Neutral schemas for the provider layer to shape per its API.
export const toolSchemas: ToolSchema[] = Object.values(registry).map((t) => t.schema);
