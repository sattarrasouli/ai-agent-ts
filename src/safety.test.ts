// Tests for the pure safety helpers. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { evalArithmetic, safeResolve, truncate } from "./safety.js";

test("evalArithmetic: basic operators", () => {
  assert.equal(evalArithmetic("1234 * 5678"), 7006652);
  assert.equal(evalArithmetic("1234 * 5678 + 9"), 7006661);
  assert.equal(evalArithmetic("10 % 3"), 1);
});

test("evalArithmetic: precedence and parentheses", () => {
  assert.equal(evalArithmetic("2 + 3 * 4"), 14);
  assert.equal(evalArithmetic("(2 + 3) * 4"), 20);
  assert.equal(evalArithmetic("-5 + 2"), -3);
  assert.equal(evalArithmetic("2.5 * 2"), 5);
});

test("evalArithmetic: rejects malformed / non-numeric input", () => {
  assert.throws(() => evalArithmetic("2 +"));
  assert.throws(() => evalArithmetic("alert(1)"));
  assert.throws(() => evalArithmetic("(1 + 2"));
});

test("safeResolve: allows paths inside root", () => {
  const root = "/home/u/project";
  assert.equal(safeResolve(root, "src/index.ts"), path.join(root, "src/index.ts"));
  assert.equal(safeResolve(root, "."), root);
});

test("safeResolve: rejects traversal and absolute escapes", () => {
  const root = "/home/u/project";
  assert.throws(() => safeResolve(root, "../../etc/passwd"));
  assert.throws(() => safeResolve(root, "/etc/passwd"));
});

test("truncate: only truncates beyond limit", () => {
  assert.equal(truncate("short", 100), "short");
  const out = truncate("x".repeat(50), 10);
  assert.ok(out.startsWith("x".repeat(10)));
  assert.ok(out.includes("truncated"));
});
