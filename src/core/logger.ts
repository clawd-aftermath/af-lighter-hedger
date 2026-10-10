export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function sensitive(name: string): boolean {
  const normalized = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /key|secret|signature|authtoken|mnemonic/.test(normalized);
}

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => redact(item, seen));
  } else {
    result = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitive(key) ? "[REDACTED]" : redact(item, seen),
      ]),
    );
  }
  seen.delete(value);
  return result;
}

export interface LoggerOptions {
  level?: LogLevel;
  fields?: LogFields;
  write?: (line: string) => void;
  now?: () => Date;
}

export class Logger {
  private readonly options: Required<LoggerOptions>;

  constructor(options: LoggerOptions = {}) {
    this.options = {
      level: options.level ?? "info",
      fields: options.fields ?? {},
      write:
        options.write ??
        ((line) => {
          process.stdout.write(line);
        }),
      now: options.now ?? (() => new Date()),
    };
  }

  child(fields: LogFields): Logger {
    return new Logger({
      ...this.options,
      fields: { ...this.options.fields, ...fields },
    });
  }

  log(level: LogLevel, msg: string, fields: LogFields = {}): void {
    if (levels[level] < levels[this.options.level]) return;
    const record = {
      ...this.options.fields,
      ...fields,
      ts: this.options.now().toISOString(),
      level,
      msg,
    };
    this.options.write(`${JSON.stringify(redact(record))}\n`);
  }

  debug(msg: string, fields?: LogFields): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.log("error", msg, fields);
  }
}

export function createLogger(options?: LoggerOptions): Logger {
  return new Logger(options);
}
