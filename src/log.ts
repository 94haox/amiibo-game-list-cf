// Minimal leveled logger. In Workers, console.log lands in the runtime logs
// and is streamable via `wrangler tail`.

export type Level = "verbose" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { verbose: 0, info: 1, warn: 2, error: 3 };

let current: Level = "info";

export function setLevel(level: Level): void {
  current = level;
}

function emit(level: Level, message: unknown): void {
  if (ORDER[level] < ORDER[current]) return;
  const line = typeof message === "string" ? message : JSON.stringify(message);
  const tagged = `[${level}] ${line}`;
  if (level === "error") console.error(tagged);
  else if (level === "warn") console.warn(tagged);
  else console.log(tagged);
}

export const log = {
  verbose: (m: unknown) => emit("verbose", m),
  info: (m: unknown) => emit("info", m),
  warn: (m: unknown) => emit("warn", m),
  error: (m: unknown) => emit("error", m),
};
