// safety.ts — pure, dependency-free helpers. Kept separate so they're trivially
// unit-testable without booting the agent or touching the network.
import * as fs from "fs";
import * as path from "path";

// Resolve a model-supplied path against rootDir and ensure it stays inside it.
// Throws on traversal attempts (e.g. "../../etc/passwd" or absolute paths out).
export function safeResolve(rootDir: string, p: string): string {
  const resolved = path.resolve(rootDir, p);
  if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) {
    throw new Error(`Path '${p}' is outside the project root and is not allowed.`);
  }
  return resolved;
}

// A tiny safe arithmetic evaluator (recursive descent) — no eval(), so model
// output can never execute arbitrary code. Supports + - * / % ( ) and decimals.
export function evalArithmetic(expr: string): number {
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

export const truncate = (s: string, n = 2000): string =>
  s.length > n ? s.slice(0, n) + `\n… [truncated, ${s.length} chars total]` : s;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Recursively walk a directory collecting file paths, skipping noisy dirs.
export function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}
