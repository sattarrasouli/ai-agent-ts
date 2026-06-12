// Tests for the provider adapters' request shaping and stream normalization.
// These are pure (no network). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { getProvider, _internal } from "./providers.js";

// Default provider is deepseek (OpenAI-compatible) unless AGENT_PROVIDER is set.
const oa = getProvider();

test("openai-compatible: wraps tool schemas and enables streaming usage", () => {
  const body: any = oa.buildBody([{ role: "user", content: "hi" }], [
    { name: "t", description: "d", parameters: { type: "object", properties: {} } },
  ]);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.name, "t");
});

test("openai-compatible: parses content, tool-call, and usage deltas", () => {
  assert.equal(oa.parseEvent({ choices: [{ delta: { content: "hello" } }] })?.contentDelta, "hello");

  const tc = oa.parseEvent({
    choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: '{"a":' } }] } }],
  });
  assert.equal(tc?.toolCallDeltas?.[0].name, "f");
  assert.equal(tc?.toolCallDeltas?.[0].argsFragment, '{"a":');

  const u = oa.parseEvent({ usage: { prompt_tokens: 12, completion_tokens: 5 }, choices: [] });
  assert.deepEqual(u?.usage, { prompt: 12, completion: 5 });
});

test("anthropic: translates system, tool_calls, and tool results", () => {
  const { system, messages } = _internal.toAnthropicMessages([
    { role: "system", content: "be nice" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "ok",
      tool_calls: [{ id: "tu1", type: "function", function: { name: "calc", arguments: '{"x":1}' } }],
    },
    { role: "tool", tool_call_id: "tu1", content: "42" },
  ]);

  assert.equal(system, "be nice");
  // assistant message becomes content blocks: a text block + a tool_use block
  const assistant = messages.find((m) => m.role === "assistant");
  assert.ok(Array.isArray(assistant.content));
  assert.equal(assistant.content[0].type, "text");
  assert.equal(assistant.content[1].type, "tool_use");
  assert.deepEqual(assistant.content[1].input, { x: 1 });
  // tool result becomes a user message with a tool_result block
  const last = messages[messages.length - 1];
  assert.equal(last.role, "user");
  assert.equal(last.content[0].type, "tool_result");
  assert.equal(last.content[0].tool_use_id, "tu1");
});

test("anthropic: merges consecutive tool results into one user message", () => {
  const { messages } = _internal.toAnthropicMessages([
    { role: "tool", tool_call_id: "a", content: "ra" },
    { role: "tool", tool_call_id: "b", content: "rb" },
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content.length, 2);
});
