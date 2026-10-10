import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { main } from "../../src/cli/main";
import { DEFAULT_CONFIG } from "../../src/config/defaults";
import { STRATEGY_TUNABLES } from "../../src/config/schema";
import { fixture } from "../engine/helpers";
import { configInput } from "../fixtures/config";

const refusal =
  "Unset strategy tunables: strategy.holdHours, strategy.eta, strategy.kPhi, strategy.kBasis, strategy.epsInBp, strategy.exitTakerShare, strategy.skew.s1, strategy.skew.s3; set your own values before dry/live; see docs/configuration.md#strategy";

for (const mode of ["dry", "live"])
  test(`${mode} refuses unset strategy before state, keys or clients`, async () => {
    const directory = mkdtempSync(join(import.meta.dir, ".strategy-"));
    const statePath = join(directory, "state.sqlite");
    let called = false;
    const errors: string[] = [];
    try {
      expect(
        await main(
          [
            "bun",
            "hedger",
            "run",
            "--mode",
            mode,
            "--confirm-live",
            "--markets",
            "BTC",
            "--config",
            "config/config.example.yaml",
          ],
          {
            env: { BOT_STATE_PATH: statePath },
            write: () => {},
            error: (line) => errors.push(line),
            runtime: async () => {
              called = true;
              throw new Error("not reachable");
            },
          },
        ),
      ).toBe(2);
      expect(errors).toHaveLength(1);
      expect(JSON.parse(errors[0] ?? "{}").message).toBe(refusal);
      expect(called).toBe(false);
      expect(existsSync(statePath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

test("built-in strategy also refuses dry without runner YAML", async () => {
  const errors: string[] = [];
  expect(
    await main(["bun", "hedger", "run", "--mode", "dry"], {
      env: {},
      write: () => {},
      error: (line) => errors.push(line),
    }),
  ).toBe(2);
  expect(JSON.parse(errors[0] ?? "{}").message).toBe(refusal);
});

for (const missing of [undefined, ...STRATEGY_TUNABLES])
  test(`dry checks explicit tunables: missing=${missing ?? "none"}`, async () => {
    const directory = mkdtempSync(join(import.meta.dir, ".strategy-"));
    const path = join(directory, "config.yaml");
    const input = configInput({
      ...DEFAULT_CONFIG,
      strategy: {
        ...DEFAULT_CONFIG.strategy,
        placeholders: false,
        missingTunables: [],
      },
    });
    if (missing === "skew.s1")
      delete (input.strategy.skew as { s1?: number }).s1;
    else if (missing === "skew.s3")
      delete (input.strategy.skew as { s3?: number }).s3;
    else if (missing)
      delete (input.strategy as Partial<typeof input.strategy>)[missing];
    let called = false;
    const errors: string[] = [];
    try {
      writeFileSync(path, stringify(input));
      const code = await main(
        ["bun", "hedger", "run", "--mode", "dry", "--config", path],
        {
          env: {
            BOT_STATE_PATH: join(directory, "state.sqlite"),
            AF_AGENT_PRIVATE_KEY: "test-af-key",
            LIGHTER_API_PRIVATE_KEY: "test-lighter-key",
          },
          write: () => {},
          error: (line) => errors.push(line),
          runtime: async (config) => {
            called = true;
            expect(config.strategy.placeholders).toBe(false);
            throw new Error("reached runtime after strategy check");
          },
        },
      );
      expect(called).toBe(!missing);
      expect(code).toBe(missing ? 2 : 1);
      expect(JSON.parse(errors[0] ?? "{}").message).toBe(
        missing
          ? `Unset strategy tunables: strategy.${missing}; set your own values before dry/live; see docs/configuration.md#strategy`
          : "reached runtime after strategy check",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

test("paper starts and stops with absent tunables and one placeholder warning", async () => {
  const directory = mkdtempSync(join(import.meta.dir, ".strategy-"));
  const f = fixture();
  const output: string[] = [];
  const errors: string[] = [];
  let started = false;
  let healthStopped = false;
  const healthServer = spyOn(Bun, "serve").mockReturnValue({
    stop: () => {
      healthStopped = true;
    },
  } as ReturnType<typeof Bun.serve>);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = f.engine.start.bind(f.engine);
  f.engine.start = async () => {
    await start(false);
    started = f.engine.isRunning;
    timer = setTimeout(() => process.emit("SIGTERM"), 0);
  };
  try {
    const code = await main(
      [
        "bun",
        "hedger",
        "run",
        "--mode",
        "paper",
        "--config",
        "config/config.example.yaml",
      ],
      {
        env: {
          BOT_STATE_PATH: join(directory, "state.sqlite"),
          BOT_HEALTH_PORT: "0",
        },
        write: (line) => output.push(line),
        error: (line) => errors.push(line),
        runtime: async (config) => {
          expect(config.strategy.placeholders).toBe(true);
          f.config.strategy = config.strategy;
          return { engine: f.engine, close: () => {} };
        },
      },
    );
    expect(errors).toEqual([]);
    expect(code).toBe(0);
    expect(started).toBe(true);
    expect(healthStopped).toBe(true);
    expect(f.engine.isRunning).toBe(false);
    const warnings = output
      .map((line) => JSON.parse(line))
      .filter((row) => row.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toBe(
      `Paper mode uses neutral placeholders. ${refusal}`,
    );
  } finally {
    healthServer.mockRestore();
    clearTimeout(timer);
    if (f.engine.isRunning) await f.engine.shutdown();
    f.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
