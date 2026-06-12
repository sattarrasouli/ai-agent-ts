# ai-agent-ts

A tool-calling coding agent in TypeScript. It runs as an interactive REPL,
streams responses, and can read/write files, run shell commands, search the
project, and search/fetch the web — all sandboxed to the project directory, with
a human approval gate on anything that mutates or executes.

Supports DeepSeek, OpenAI, and Anthropic behind a single provider abstraction.

## Setup

```bash
npm install
cp .env.example .env   # then add your API key (see below)
```

## Usage

```bash
npm run dev        # start the interactive REPL
```

At the prompt: type a message to talk to the agent, `reset` to clear the
conversation, or `exit`/`quit` to leave. **Ctrl+C cancels an in-flight turn**
(returns to the prompt); pressing it at an idle prompt quits.

Conversation history is saved to `.agent-session.json` and resumed on the next
launch.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `AGENT_PROVIDER` | no | `deepseek` (default), `openai`, or `anthropic` |
| `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | yes* | key for the selected provider (*the one matching `AGENT_PROVIDER`) |
| `AGENT_MODEL` | no | model override (defaults per provider) |
| `AGENT_BASE_URL` | no | override the API endpoint |
| `BRAVE_SEARCH_API_KEY` | no | use Brave for `web_search` (else DuckDuckGo fallback) |
| `LOG_LEVEL` | no | `debug`\|`info`\|`warn`\|`error` (default `info`) |
| `LOG_JSON` | no | set `1` for JSON log lines |

## Scripts

```bash
npm run dev        # run the REPL via tsx
npm test           # run the unit test suite (node:test)
npm run typecheck  # tsc --noEmit
npm run build      # compile to dist/
```

## Structure

```
src/
├── index.ts        # REPL entry — readline, Ctrl+C/abort wiring, UI callbacks
├── agent.ts        # the turn loop, streaming, retries, session persistence
├── providers.ts    # per-provider request shaping + SSE normalization
├── tools.ts        # tool registry (schema + impl) and web_search
├── safety.ts       # pure helpers: path sandbox, arithmetic parser, walk
├── config.ts       # central config + provider/key selection
├── logger.ts       # leveled logger (stderr, optional JSON)
└── *.test.ts       # unit tests (node:test)
```

## Tools

`calculator`, `get_current_time`, `read_file`, `list_directory`, `grep`,
`fetch_url`, `web_search`, and the approval-gated `write_file`, `edit_file`,
`run_command`.
