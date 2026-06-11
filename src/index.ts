// agent.ts — the simplest possible agent: an LLM in a loop with one tool.
// Run:  set DEEPSEEK_API_KEY in .env   then   npx tsx src/index.ts
import "dotenv/config"; // load .env so DEEPSEEK_API_KEY is available

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  throw new Error("DEEPSEEK_API_KEY is not set. Add it to your .env file.");
}

// 1. One tool the model is allowed to call.
const tools = [{
  type: "function",
  function: {
    name: "calculator",
    description: "Evaluate a math expression, e.g. '1234 * 5678'",
    parameters: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
  },
}];

// 2. The conversation so far.
const messages: any[] = [
  { role: "user", content: "What is 1234 * 5678, then add 9?" },
];

async function main() {
  // 3. The loop: ask the model → run any tool it asks for → repeat.
  while (true) {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages, tools }),
    });

    const data = await res.json();
    if (!res.ok || !data.choices) {
      throw new Error(`API error ${res.status}: ${JSON.stringify(data)}`);
    }
    const msg = data.choices[0].message;
    messages.push(msg);                 // remember what the model said

    if (!msg.tool_calls) {              // no tool requested → it's done
      console.log("\nAnswer:", msg.content);
      return;
    }

    for (const call of msg.tool_calls) {           // run each requested tool
      const { expression } = JSON.parse(call.function.arguments);
      const result = String(eval(expression));     // demo only, never on real input
      console.log(`calculator("${expression}") = ${result}`);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }
}

main();