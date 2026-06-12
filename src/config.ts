// config.ts — central configuration. Provider selection lives here so the rest
// of the app is provider-agnostic; swapping providers is one env var.
import * as path from "path";

export type ProviderName = "deepseek" | "openai" | "anthropic";

const provider = (process.env.AGENT_PROVIDER ?? "deepseek") as ProviderName;

// Per-provider defaults; AGENT_MODEL overrides for any provider.
const DEFAULT_MODEL: Record<ProviderName, string> = {
  deepseek: "deepseek-v4-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
};

// Each provider reads its own key, with DEEPSEEK_API_KEY kept as a fallback for
// backwards compatibility with existing .env files.
function resolveApiKey(p: ProviderName): string | undefined {
  switch (p) {
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "deepseek":
    default:
      return process.env.DEEPSEEK_API_KEY;
  }
}

export const config = {
  provider,
  apiKey: resolveApiKey(provider),
  model: process.env.AGENT_MODEL ?? DEFAULT_MODEL[provider],
  baseUrlOverride: process.env.AGENT_BASE_URL, // optional endpoint override
  // Tools may only touch paths inside this root. Anything outside is rejected.
  rootDir: path.resolve(process.cwd()),
  commandTimeoutMs: 30_000,
  maxRetries: 4, // API retry attempts on 429/5xx/network errors
  maxToolIterations: 25, // safety cap on tool-call loops within one turn
  sessionFile: path.resolve(process.cwd(), ".agent-session.json"),
  anthropicVersion: "2023-06-01",
  anthropicMaxTokens: 4096,
};

// Called from the entry point (not at import time, so tests can import config).
export function assertConfig(): void {
  if (!config.apiKey) {
    const envName =
      config.provider === "openai"
        ? "OPENAI_API_KEY"
        : config.provider === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : "DEEPSEEK_API_KEY";
    throw new Error(`${envName} is not set (provider='${config.provider}'). Add it to your .env file.`);
  }
}
