// Tests for tool handlers that don't require the network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { registry, toolSchemas } from "./tools.js";

test("registry exposes neutral schemas for every tool", () => {
  assert.ok(toolSchemas.length === Object.keys(registry).length);
  for (const s of toolSchemas) {
    assert.ok(s.name && s.description && s.parameters, `schema incomplete: ${JSON.stringify(s)}`);
  }
});

test("calculator returns numeric result as string", async () => {
  assert.equal(await registry.calculator.run({ expression: "6 * 7" }), "42");
});

test("calculator reports errors as a string (never throws)", async () => {
  const out = await registry.calculator.run({ expression: "2 +" });
  assert.match(out, /Error evaluating/);
});

test("read_file rejects paths outside the project root", async () => {
  const out = await registry.read_file.run({ path: "../../etc/passwd" });
  assert.match(out, /outside the project root/);
});

test("list_directory lists this project's src dir", async () => {
  const out = await registry.list_directory.run({ path: "src" });
  assert.match(out, /index\.ts/);
});

test("grep finds a known string in the source tree", async () => {
  const out = await registry.grep.run({ pattern: "runTurn" });
  assert.match(out, /agent\.ts:/);
});

test("mutating tools require approval", () => {
  assert.ok(registry.write_file.approvalMessage);
  assert.ok(registry.edit_file.approvalMessage);
  assert.ok(registry.run_command.approvalMessage);
  assert.ok(!registry.read_file.approvalMessage);
});
