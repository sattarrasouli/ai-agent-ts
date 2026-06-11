# ai-agent-ts

A minimal tool-calling coding agent in TypeScript, built on the DeepSeek API (works with any OpenAI-compatible endpoint).

The agent reads/writes files and runs shell commands — all sandboxed to a workspace directory, with a human approval gate on every shell command.

## Setup

```bash
npm install
cp .env.example .env   # then add your DEEPSEEK_API_KEY
```

## Usage

```bash
# Run a task against the current directory
npm run dev -- "add a unit test for utils.ts"

# Or target another workspace
npm run dev -- --workspace ../my-project "fix the failing build"
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DEEPSEEK_API_KEY` | yes | API key from platform.deepseek.com |
| `DEEPSEEK_MODEL` | no | Model override (default: `deepseek-v4-flash`) |
| `AUTO_APPROVE` | no | Set to `1` to skip the y/N prompt before shell commands |

## Structure

```
src/
├── index.ts          # CLI entry — loads .env, parses args
├── types.ts          # shared API wire-format types
├── core/
│   ├── agent.ts      # the agent loop
│   └── llm.ts        # DeepSeek API client
├── tools/
│   └── index.ts      # tool definitions + dispatcher
└── utils/
    └── safety.ts     # workspace sandbox + approval gate
```
