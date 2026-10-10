import { Logger, type LoggerOptions } from "../core/logger";

export function modeLogger(
  mode: string,
  options: LoggerOptions = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): Logger {
  const secrets = Object.entries(env)
    .filter(
      ([key, value]) => value && /PRIVATE_KEY|TOKEN|SECRET|MNEMONIC/i.test(key),
    )
    .map(([, value]) => value as string);
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  return new Logger({
    ...options,
    fields: { ...options.fields, mode },
    write: (line) => {
      const scrub = (value: unknown): unknown => {
        if (typeof value === "string") {
          for (const secret of secrets)
            value = (value as string).split(secret).join("[REDACTED]");
          return value;
        }
        if (Array.isArray(value)) return value.map(scrub);
        if (value !== null && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, scrub(item)]),
          );
        return value;
      };
      write(`${JSON.stringify(scrub(JSON.parse(line)))}\n`);
    },
  });
}
export function errorFields(
  error: unknown,
  debug: boolean,
  seen = new Set<unknown>(),
): Record<string, unknown> {
  if (!(error instanceof Error))
    return { name: "Error", message: String(error) };
  if (seen.has(error)) return { message: "[Circular]" };
  seen.add(error);
  const fields: Record<string, unknown> = {
    ...error,
    name: error.name,
    message: error.message,
  };
  for (const key of Object.keys(fields))
    if (/token|password|credential/i.test(key)) fields[key] = "[REDACTED]";
  if (debug) {
    fields.stack = error.stack;
    if (error.cause !== undefined)
      fields.cause = errorFields(error.cause, true, seen);
  } else {
    delete fields.stack;
    delete fields.cause;
  }
  return fields;
}
