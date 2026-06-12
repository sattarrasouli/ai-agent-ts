// logger.ts — a small leveled logger. Operational logs go to stderr so they
// never interleave with the assistant's streamed reply on stdout. Set
// LOG_LEVEL=debug|info|warn|error (default info) and LOG_JSON=1 for JSON lines.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;
const asJson = process.env.LOG_JSON === "1" || process.env.LOG_JSON === "true";

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  if (asJson) {
    process.stderr.write(JSON.stringify({ ts, level, msg, ...meta }) + "\n");
  } else {
    const tag = level.toUpperCase().padEnd(5);
    const extra = meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
    process.stderr.write(`${ts} ${tag} ${msg}${extra}\n`);
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
