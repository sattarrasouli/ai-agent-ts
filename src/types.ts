// Shared types for the agent. These mirror the OpenAI / DeepSeek
// Chat Completions wire format so we can talk to the API with plain fetch.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    // NOTE: OpenAI-format APIs send tool arguments as a JSON *string*,
    // not a parsed object. We JSON.parse it ourselves in the loop.
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// Every tool returns this. `ok: false` means the action failed but the
// agent can recover — we feed the error text back to the model instead
// of crashing.
export interface ToolResult {
  ok: boolean;
  output: string;
}