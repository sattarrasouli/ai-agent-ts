import type { ChatMessage, ToolDefinition } from "../types.js";

// DeepSeek is OpenAI-compatible, so this same client works against OpenAI
// or any OpenAI-compatible endpoint by changing API_URL + MODEL + key.
const API_URL = "https://api.deepseek.com/chat/completions";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const MAX_RETRIES = 3;

interface CompletionResponse {
  choices: { message: ChatMessage; finish_reason: string }[];
}

// Client errors (bad key, malformed request) won't succeed on retry.
class NonRetryableError extends Error {}

// Send the full conversation + tool list, get back the model's next turn.
// The model has no memory between calls, so we always send everything.
export async function callModel(
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Promise<ChatMessage> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          tools,
          temperature: 0, // deterministic-ish; good for coding tasks
        }),
      });

      // Rate limit or server error → back off and retry.
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_RETRIES) {
          await sleep(500 * attempt);
          continue;
        }
        throw new Error(`DeepSeek API ${res.status}: ${await res.text()}`);
      }
      if (!res.ok) {
        // Remaining 4xx (bad key, malformed request) won't fix itself — fail fast.
        throw new NonRetryableError(`DeepSeek API ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as CompletionResponse;
      const message = data.choices?.[0]?.message;
      if (!message) throw new NonRetryableError("DeepSeek API returned no choices");
      return message;
    } catch (err) {
      if (err instanceof NonRetryableError || attempt >= MAX_RETRIES) throw err;
      await sleep(500 * attempt);
    }
  }
  throw new Error("unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}