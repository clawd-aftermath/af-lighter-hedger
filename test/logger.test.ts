import { expect, test } from "bun:test";
import { createLogger, redact } from "../src/core/logger";

test("emits one NDJSON record with timestamp, level, message and fields", () => {
  const lines: string[] = [];
  const logger = createLogger({
    write: (line) => lines.push(line),
    now: () => new Date("2026-10-09T00:00:00Z"),
  });
  logger.info("hello\nworld", { count: 2 });
  expect(lines).toHaveLength(1);
  expect(lines[0]?.split("\n")).toHaveLength(2);
  expect(JSON.parse(lines[0] ?? "")).toEqual({
    ts: "2026-10-09T00:00:00.000Z",
    level: "info",
    msg: "hello\nworld",
    count: 2,
  });
});

test("filters levels", () => {
  const lines: string[] = [];
  const logger = createLogger({
    level: "warn",
    write: (line) => lines.push(line),
  });
  logger.debug("debug");
  logger.info("info");
  logger.warn("warn");
  logger.error("error");
  expect(lines.map((line) => JSON.parse(line).level)).toEqual([
    "warn",
    "error",
  ]);
});

test("child loggers bind fields and per-call fields take precedence", () => {
  const lines: string[] = [];
  const parent = createLogger({
    fields: { app: "hedger", market: "BTC" },
    write: (line) => lines.push(line),
  });
  const child = parent.child({ market: "ETH", privateKey: "synthetic" });
  child.info("child", { market: "SUI" });
  parent.info("parent");
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({
    app: "hedger",
    market: "SUI",
    privateKey: "[REDACTED]",
  });
  expect(JSON.parse(lines[1] ?? "")).toMatchObject({ market: "BTC" });
});

test("redacts nested case variants, separators, arrays and key-like fields", () => {
  const input = {
    key: "synthetic",
    nested: [
      {
        SECRET: "synthetic",
        private_key: "synthetic",
        Signature: "synthetic",
        authToken: "synthetic",
        mnemonic: "synthetic",
        apiKey: "synthetic",
        session_secret: "synthetic",
        normal: "ok",
      },
    ],
  };
  const result = redact(input);
  expect(JSON.stringify(result)).not.toContain("synthetic");
  expect(JSON.stringify(result)).toContain("ok");
  expect(input.key).toBe("synthetic");
});

test("handles bigint and circular objects", () => {
  const circular: Record<string, unknown> = { id: 9007199254740993n };
  circular.self = circular;
  expect(redact(circular)).toEqual({
    id: "9007199254740993",
    self: "[Circular]",
  });
});

test("reserved record fields cannot be overwritten", () => {
  const lines: string[] = [];
  createLogger({ write: (line) => lines.push(line) }).error("real", {
    ts: "fake",
    msg: "fake",
    level: "fake",
  });
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({
    level: "error",
    msg: "real",
  });
  expect(JSON.parse(lines[0] ?? "").ts).not.toBe("fake");
});
