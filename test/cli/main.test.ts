import { expect, test } from "bun:test";
import {
  attachSignals,
  main,
  readSettings,
  stateNamespace,
} from "../../src/cli/main";
import { DEFAULT_CONFIG } from "../../src/config/defaults";
import { runtimeConfigSchema } from "../../src/config/schema";
import { gasConfig } from "../../src/engine/runtime";
import { configInput } from "../fixtures/config";

for (const args of [
  [],
  ["run"],
  ["status"],
  ["cancel-all"],
  ["flatten"],
  ["breaker"],
  ["breaker", "reset"],
  ["pnl"],
])
  test(`help ${args.join(" ") || "root"} without clients or state`, async () => {
    let output = "";
    expect(
      await main(["bun", "hedger", ...args, "--help"], {
        write: (text) => {
          output += text;
        },
        error: () => {},
      }),
    ).toBe(0);
    expect(output).toContain("Usage:");
  });
test("live flag refusal precedes state, key and client setup", async () => {
  let called = false;
  const code = await main(
    [
      "bun",
      "hedger",
      "run",
      "--mode",
      "live",
      "--markets",
      "BTC",
      "--config",
      "/nonexistent",
    ],
    {
      write: () => {},
      error: () => {},
      runtime: async () => {
        called = true;
        throw new Error("not reachable");
      },
    },
  );
  expect(code).toBe(2);
  expect(called).toBe(false);
});
test("flatten without confirmation is safety refusal", async () => {
  expect(
    await main(["bun", "hedger", "flatten", "all"], {
      write: () => {},
      error: () => {},
    }),
  ).toBe(2);
});
test("unknown modes and commands are errors", async () => {
  expect(
    await main(["bun", "hedger", "run", "--mode", "wrong"], {
      write: () => {},
      error: () => {},
    }),
  ).toBe(1);
  expect(
    await main(["bun", "hedger", "unknown"], {
      write: () => {},
      error: () => {},
    }),
  ).toBe(1);
});
test("market filter chooses enabled symbols and refuses unknown", () => {
  expect(
    readSettings({ markets: "BTC,ETH" }).markets.map((m) => m.symbol),
  ).toEqual(["BTC", "ETH"]);
  expect(() => readSettings({ markets: "NOPE" })).toThrow();
});
test("state namespace isolates mode/profile/accounts", () => {
  const paper = stateNamespace(DEFAULT_CONFIG);
  expect(paper).not.toBe(stateNamespace({ ...DEFAULT_CONFIG, mode: "live" }));
  expect(paper).not.toBe(
    stateNamespace({ ...DEFAULT_CONFIG, profile: "testnet" }),
  );
});
test("mainnet gas pool default is configurable", () => {
  const config = runtimeConfigSchema.parse({
    ...configInput(DEFAULT_CONFIG),
    profile: "mainnet",
  });
  expect(config.aftermath.gas.gasPoolPackageId).toBe(
    "0x1defae9e3c13f8598c1a7012f1be6ae29ebbbaf1a61ee33291e4d97c8cd53016",
  );
  expect(
    runtimeConfigSchema.parse({
      ...configInput(config),
      aftermath: {
        ...config.aftermath,
        gas: { ...config.aftermath.gas, gasPoolPackageId: "0x1" },
      },
    }).aftermath.gas.gasPoolPackageId,
  ).toBe("0x1");
});
test("dynamic gas refuses without reimbursement cap", () => {
  expect(() =>
    gasConfig({
      ...DEFAULT_CONFIG,
      aftermath: {
        ...DEFAULT_CONFIG.aftermath,
        gas: {
          mode: "dynamic-gas",
          maxGasBudgetMist: "100",
          dynamicGas: { coinType: "USDC" },
        },
      },
    }),
  ).toThrow("maxFeeAtomic");
});
test("SIGTERM handler calls shutdown exactly once", async () => {
  let calls = 0;
  let code = -1;
  const detach = attachSignals(
    {
      shutdown: async () => {
        calls++;
      },
    },
    (exit) => {
      code = exit;
    },
  );
  process.emit("SIGTERM");
  process.emit("SIGTERM");
  await Promise.resolve();
  detach();
  expect(calls).toBe(1);
  expect(code).toBe(0);
});
