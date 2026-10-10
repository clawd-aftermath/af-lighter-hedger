import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/cli/main";
import { parseYaml } from "../../src/config/load";
import { runtimeConfigSchema } from "../../src/config/schema";
import { VenueError } from "../../src/core/errors";
import { configInput } from "../fixtures/config";

test("example config resolves real mainnet endpoints without keys", () => {
  const config = runtimeConfigSchema.parse(
    parseYaml(
      readFileSync(
        new URL("../../config/config.example.yaml", import.meta.url),
        "utf8",
      ),
    ),
  );
  expect(config.profile).toBe("mainnet");
  expect(config.mode).toBe("paper");
  expect(config.aftermath.baseUrl).toBe("https://aftermath.finance");
  expect(config.aftermath.grpcUrl).toBe("https://fullnode.mainnet.sui.io:443");
  expect(config.lighter.baseUrl).toBe("https://mainnet.zklighter.elliot.ai");
  expect(config.lighter.chainId).toBe(304);
});
test("testnet URLs follow profile and explicit overrides win", () => {
  const config = runtimeConfigSchema.parse({
    profile: "testnet",
    aftermath: { gas: {} },
    lighter: { accountIndex: 0, apiKeyIndex: 4 },
  });
  expect(config.aftermath.baseUrl).toBe("https://testnet.aftermath.finance");
  expect(config.lighter.baseUrl).toBe("https://testnet.zklighter.elliot.ai");
  expect(config.lighter.chainId).toBe(300);
  expect(config.aftermath.grpcUrl).toBe("https://fullnode.testnet.sui.io:443");
  const override = runtimeConfigSchema.parse({
    ...configInput(config),
    aftermath: { ...config.aftermath, baseUrl: "https://localhost:9000" },
  });
  expect(override.aftermath.baseUrl).toBe("https://localhost:9000");
});
for (const debug of [false, true])
  test(`VenueError message/code and secret redaction debug=${debug}`, async () => {
    const dir = mkdtempSync(join(import.meta.dir, ".errors-"));
    let output = "";
    try {
      const error = new VenueError(
        "rate limit sensitive-value",
        "lighter",
        429,
        false,
        { cause: new Error("sensitive-value cause") },
      );
      Object.assign(error, {
        apiKey: "sensitive-value",
        signature: "sensitive-value",
      });
      expect(
        await main(
          [
            "bun",
            "hedger",
            ...(debug ? ["--debug"] : []),
            "run",
            "--mode",
            "paper",
          ],
          {
            env: {
              BOT_STATE_PATH: join(dir, "state.sqlite"),
              LIGHTER_API_PRIVATE_KEY: "sensitive-value",
            },
            write: () => {},
            error: (text) => {
              output += text;
            },
            runtime: async () => {
              throw error;
            },
          },
        ),
      ).toBe(1);
      const row = JSON.parse(output);
      expect(row.msg).toContain("VenueError: rate limit");
      expect(row.venue).toBe("lighter");
      expect(row.code).toBe(429);
      expect(row.mode).toBe("paper");
      expect(output).not.toContain("sensitive-value");
      expect(row.apiKey).toBe("[REDACTED]");
      expect(Boolean(row.stack)).toBe(debug);
      expect(Boolean(row.cause)).toBe(debug);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
test("oracle configuration cannot exceed venue tolerance", () => {
  expect(() =>
    runtimeConfigSchema.parse({
      aftermath: { gas: {} },
      lighter: { accountIndex: 0, apiKeyIndex: 4 },
      risk: { stalenessMs: { afOracle: 15000 } },
    }),
  ).toThrow();
});

test("short or escaped secrets cannot corrupt NDJSON error records", async () => {
  const { modeLogger, errorFields } = await import("../../src/ops/logging");
  let output = "";
  const error = Object.assign(
    new VenueError('secret 1 and "quoted\\value"', "lighter", 401),
    { password: "another-secret" },
  );
  modeLogger(
    "paper",
    {
      write: (line) => {
        output += line;
      },
    },
    { TEST_TOKEN: "1", OTHER_SECRET: '"quoted\\value"' },
  ).error("failure", errorFields(error, true));
  const row = JSON.parse(output);
  expect(row.code).toBe(401);
  expect(row.message).toBe("secret [REDACTED] and [REDACTED]");
  expect(row.password).toBe("[REDACTED]");
});
