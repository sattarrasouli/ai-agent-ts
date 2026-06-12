// providers.ts — adapters that translate the agent's internal (OpenAI-shaped)
// conversation to each provider's request format, and normalize each provider's
// streaming SSE events back into a single neutral delta shape. Adding a provider
// means implementing one Provider object; the rest of the agent is unchanged.
import { config, type ProviderName } from "./config.js";

// Neutral tool schema the registry produces; each provider shapes it as needed.
export type ToolSchema = { name: string; description: string; parameters: any };

// One normalized streaming event. A raw SSE chunk may yield content text,
// fragments of one or more tool calls, and/or token usage.
export interface StreamDelta {
  contentDelta?: string;
  toolCallDeltas?: { index: number; id?: string; name?: string; argsFragment?: string }[];
  usage?: { prompt?: number; completion?: number };
}

export interface Provider {
  name: ProviderName;
  endpoint: string;
  headers(): Record<string, string>;
  buildBody(messages: any[], tools: ToolSchema[]): unknown;
  // Map a parsed SSE `data:` JSON object to a neutral delta (or null to skip).
  parseEvent(json: any): StreamDelta | null;
}

const safeParse = (s: string): any => {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
};

// ─── OpenAI-compatible (OpenAI, DeepSeek) ────────────────────────────────────
// Both speak the /chat/completions protocol, so one adapter covers them.
function openAiCompatible(name: ProviderName, defaultEndpoint: string): Provider {
  return {
    name,
    endpoint: config.baseUrlOverride ?? defaultEndpoint,
    headers: () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    }),
    buildBody: (messages, tools) => ({
      model: config.model,
      messages,
      tools: tools.map((t) => ({ type: "function", function: t })),
      stream: true,
      stream_options: { include_usage: true },
    }),
    parseEvent: (json) => {
      const out: StreamDelta = {};
      if (json.usage) {
        out.usage = {
          prompt: json.usage.prompt_tokens,
          completion: json.usage.completion_tokens,
        };
      }
      const delta = json.choices?.[0]?.delta;
      if (delta?.content) out.contentDelta = delta.content;
      if (delta?.tool_calls) {
        out.toolCallDeltas = delta.tool_calls.map((tc: any) => ({
          index: tc.index ?? 0,
          id: tc.id,
          name: tc.function?.name,
          argsFragment: tc.function?.arguments,
        }));
      }
      return out;
    },
  };
}

// ─── Anthropic (Messages API) ────────────────────────────────────────────────
// Anthropic separates the system prompt, uses content blocks, and represents
// tool calls/results as tool_use / tool_result blocks. Translate both ways.
function toAnthropicMessages(messages: any[]): { system: string; messages: any[] } {
  let system = "";
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      system += (system ? "\n" : "") + (m.content ?? "");
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: safeParse(tc.function.arguments),
        });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : "(no content)" });
    } else if (m.role === "tool") {
      // Tool results are user-role messages; merge consecutive ones (parallel
      // tool calls) into a single user message as Anthropic expects.
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: m.content };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return { system, messages: out };
}

function anthropic(): Provider {
  return {
    name: "anthropic",
    endpoint: config.baseUrlOverride ?? "https://api.anthropic.com/v1/messages",
    headers: () => ({
      "content-type": "application/json",
      "x-api-key": config.apiKey ?? "",
      "anthropic-version": config.anthropicVersion,
    }),
    buildBody: (messages, tools) => {
      const { system, messages: anthMessages } = toAnthropicMessages(messages);
      return {
        model: config.model,
        max_tokens: config.anthropicMaxTokens,
        system: system || undefined,
        messages: anthMessages,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
        stream: true,
      };
    },
    parseEvent: (json) => {
      switch (json.type) {
        case "message_start":
          return { usage: { prompt: json.message?.usage?.input_tokens } };
        case "content_block_start":
          if (json.content_block?.type === "tool_use") {
            return {
              toolCallDeltas: [
                {
                  index: json.index,
                  id: json.content_block.id,
                  name: json.content_block.name,
                  argsFragment: "",
                },
              ],
            };
          }
          return null;
        case "content_block_delta":
          if (json.delta?.type === "text_delta") {
            return { contentDelta: json.delta.text };
          }
          if (json.delta?.type === "input_json_delta") {
            return { toolCallDeltas: [{ index: json.index, argsFragment: json.delta.partial_json }] };
          }
          return null;
        case "message_delta":
          return { usage: { completion: json.usage?.output_tokens } };
        default:
          return null;
      }
    },
  };
}

export function getProvider(): Provider {
  switch (config.provider) {
    case "openai":
      return openAiCompatible("openai", "https://api.openai.com/v1/chat/completions");
    case "anthropic":
      return anthropic();
    case "deepseek":
    default:
      return openAiCompatible("deepseek", "https://api.deepseek.com/chat/completions");
  }
}

// Exported for tests.
export const _internal = { toAnthropicMessages };
