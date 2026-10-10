import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, DEFAULT_MARKETS } from "../../src/config/defaults";
import { loadConfig, loadSecrets, parseYaml } from "../../src/config/load";
import {
  marketsSchema,
  parseConfig,
  runtimeConfigSchema,
  STRATEGY_TUNABLES,
} from "../../src/config/schema";
import { configInput, configuredStrategy } from "../fixtures/config";

const CONFIG_INPUT = configInput(DEFAULT_CONFIG);

test("shipped config is schema valid", () =>
  expect(parseConfig(runtimeConfigSchema, CONFIG_INPUT)).toEqual(
    DEFAULT_CONFIG,
  ));
test("shipped markets are BTC ETH SOL SUI with small enabled defaults", () => {
  expect(DEFAULT_MARKETS.map((m) => m.symbol)).toEqual([
    "BTC",
    "ETH",
    "SOL",
    "SUI",
  ]);
  for (const m of DEFAULT_MARKETS)
    expect([m.enabled, m.clipUsd, m.maxPositionUsd, m.levels]).toEqual([
      true,
      50,
      500,
      1,
    ]);
});
test("profitable-only and session defaults", () => {
  expect(DEFAULT_CONFIG.strategy.compressionBudgetBp).toBe(0);
  expect(DEFAULT_CONFIG.strategy.allowAfTaking).toBe(false);
  expect(DEFAULT_CONFIG.risk.pauseWhenSessionClosed).toBe(true);
  expect(DEFAULT_CONFIG.aftermath.quoteTtlMs).toBe(600000);
});
test("operator examples load and match defaults", () => {
  const result = loadConfig(
    "config/config.example.yaml",
    "config/markets.example.yaml",
    {},
  );
  expect(result.config).toEqual(DEFAULT_CONFIG);
  expect(result.markets).toEqual(DEFAULT_MARKETS);
  expect(result.secrets.afAgentPrivateKey).toBeUndefined();
});
const invalid = [
  ["profile", { profile: "dev" }],
  ["mode", { mode: "real" }],
  [
    "aftermath.baseUrl",
    { aftermath: { ...DEFAULT_CONFIG.aftermath, baseUrl: "bad" } },
  ],
  [
    "aftermath.quoteTtlMs",
    { aftermath: { ...DEFAULT_CONFIG.aftermath, quoteTtlMs: 0 } },
  ],
  [
    "lighter.apiKeyIndex",
    { lighter: { ...DEFAULT_CONFIG.lighter, apiKeyIndex: 3 } },
  ],
  [
    "lighter.apiKeyIndex",
    { lighter: { ...DEFAULT_CONFIG.lighter, apiKeyIndex: 255 } },
  ],
  [
    "lighter.accountIndex",
    { lighter: { ...DEFAULT_CONFIG.lighter, accountIndex: -1 } },
  ],
  [
    "lighter.maxSlippageBps",
    { lighter: { ...DEFAULT_CONFIG.lighter, maxSlippageBps: 401 } },
  ],
  [
    "lighter.emergencySlippageBps",
    { lighter: { ...DEFAULT_CONFIG.lighter, emergencySlippageBps: 10 } },
  ],
  ["strategy.eta", { strategy: { ...CONFIG_INPUT.strategy, eta: 1.01 } }],
  [
    "strategy.holdHours",
    { strategy: { ...CONFIG_INPUT.strategy, holdHours: 0 } },
  ],
  [
    "strategy.compressionBudgetBp",
    { strategy: { ...CONFIG_INPUT.strategy, compressionBudgetBp: -1 } },
  ],
  [
    "risk.minMarginHeadroomPct",
    { risk: { ...DEFAULT_CONFIG.risk, minMarginHeadroomPct: 101 } },
  ],
  [
    "risk.stalenessMs.afBook",
    {
      risk: {
        ...DEFAULT_CONFIG.risk,
        stalenessMs: { ...DEFAULT_CONFIG.risk.stalenessMs, afBook: -1 },
      },
    },
  ],
] as const;
for (const [field, override] of invalid)
  test(`config names bad ${field} ${JSON.stringify(override)}`, () =>
    expect(() =>
      parseConfig(runtimeConfigSchema, { ...CONFIG_INPUT, ...override }),
    ).toThrow(field));
test("gas pool mode requires pool fields", () =>
  expect(() =>
    parseConfig(runtimeConfigSchema, {
      ...CONFIG_INPUT,
      aftermath: { ...DEFAULT_CONFIG.aftermath, gas: { mode: "gas-pool" } },
    }),
  ).toThrow("aftermath.gas.gasPool"));
test("dynamic gas requires coin type", () =>
  expect(() =>
    parseConfig(runtimeConfigSchema, {
      ...CONFIG_INPUT,
      aftermath: { ...DEFAULT_CONFIG.aftermath, gas: { mode: "dynamic-gas" } },
    }),
  ).toThrow("dynamicGas"));
test("gas budgets preserve bigint precision", () => {
  const value = parseConfig(runtimeConfigSchema, {
    ...CONFIG_INPUT,
    aftermath: {
      ...DEFAULT_CONFIG.aftermath,
      gas: { mode: "sui", maxGasBudgetMist: "9007199254740993123" },
    },
  });
  expect(value.aftermath.gas.maxGasBudgetMist).toBe("9007199254740993123");
});
for (const [key, value] of [
  ["levels", 0],
  ["levels", 4],
  ["clipUsd", -1],
  ["clipUsd", 501],
  ["maxPositionUsd", 0],
] as const)
  test(`market bad ${key}=${value}`, () =>
    expect(() =>
      parseConfig(marketsSchema, [{ ...DEFAULT_MARKETS[0], [key]: value }]),
    ).toThrow(key));
test("markets reject duplicate symbols", () =>
  expect(() =>
    parseConfig(marketsSchema, [DEFAULT_MARKETS[0], DEFAULT_MARKETS[0]]),
  ).toThrow("symbol"));
test("markets require list", () =>
  expect(() => parseConfig(marketsSchema, {})).toThrow());
for (const key of [
  "AF_AGENT_PRIVATE_KEY",
  "LIGHTER_API_PRIVATE_KEY",
  "privateKey",
  "private_key",
  "apiSecret",
  "password",
  "seed_phrase",
  "accessToken",
  "api-key",
])
  test(`YAML refuses secret key ${key}`, () =>
    expect(() => parseYaml(`nested:\n  ${key}: do-not-print-me`)).toThrow(
      `nested.${key}`,
    ));
test("secret errors do not expose values", () => {
  try {
    parseYaml("privateKey: do-not-print-me");
  } catch (e) {
    expect(String(e)).not.toContain("do-not-print-me");
  }
});
test("API key index and pool signature are allowed public YAML fields", () =>
  expect(parseYaml("apiKeyIndex: 4\ntermsSignature: public")).toEqual({
    apiKeyIndex: 4,
    termsSignature: "public",
  }));
test("duplicate YAML keys refused", () =>
  expect(() => parseYaml("mode: paper\nmode: live")).toThrow("YAML"));
test("unknown config keys named", () =>
  expect(() =>
    parseConfig(runtimeConfigSchema, { ...CONFIG_INPUT, typo: true }),
  ).toThrow("typo"));

test("non-HTTP URL rejected by named field", () =>
  expect(() =>
    parseConfig(runtimeConfigSchema, {
      ...CONFIG_INPUT,
      aftermath: {
        ...DEFAULT_CONFIG.aftermath,
        baseUrl: "ftp://example.invalid",
      },
    }),
  ).toThrow("baseUrl"));
for (const key of ["signingKey", "credentials", "seed"])
  test(`additional secret-looking ${key} refused`, () =>
    expect(() => parseYaml(`${key}: hidden`)).toThrow(key));

test("live mode requires AF env key with named error", () =>
  expect(() => loadSecrets({ ...DEFAULT_CONFIG, mode: "live" }, {})).toThrow(
    "AF_AGENT_PRIVATE_KEY",
  ));
test("live mode requires Lighter env key with named error", () =>
  expect(() =>
    loadSecrets(
      { ...DEFAULT_CONFIG, mode: "live" },
      { AF_AGENT_PRIVATE_KEY: "local-test-key" },
    ),
  ).toThrow("LIGHTER_API_PRIVATE_KEY"));
test("secrets are taken from the injected environment only", () =>
  expect(
    loadSecrets(
      { ...DEFAULT_CONFIG, mode: "live" },
      { AF_AGENT_PRIVATE_KEY: "af-test", LIGHTER_API_PRIVATE_KEY: "l-test" },
    ),
  ).toEqual({ afAgentPrivateKey: "af-test", lighterApiPrivateKey: "l-test" }));
test("secret validation errors never echo env values", () => {
  try {
    loadSecrets(
      { ...DEFAULT_CONFIG, mode: "live" },
      { AF_AGENT_PRIVATE_KEY: "sensitive-value" },
    );
  } catch (e) {
    expect(String(e)).not.toContain("sensitive-value");
  }
});
test("YAML parse errors never echo source snippets", () => {
  try {
    parseYaml("privateKey: sensitive-value\nprivateKey: sensitive-value");
  } catch (e) {
    expect(String(e)).not.toContain("sensitive-value");
  }
});

test("absent strategy tunables use neutral placeholders and record every omission", () => {
  for (const strategy of [undefined, {}, { skew: {} }]) {
    const config = runtimeConfigSchema.parse({ ...CONFIG_INPUT, strategy });
    expect(config.strategy).toEqual({
      holdHours: 1,
      eta: 0,
      kPhi: 0,
      kBasis: 0,
      epsInBp: 0,
      exitTakerShare: 0,
      skew: { s1: 0, s3: 0 },
      compressionBudgetBp: 0,
      allowAfTaking: false,
      placeholders: true,
      missingTunables: [...STRATEGY_TUNABLES],
    });
  }
});

test("explicit neutral tunables count as configured without requiring safe defaults", () => {
  const config = runtimeConfigSchema.parse({
    ...CONFIG_INPUT,
    strategy: {
      holdHours: 1,
      eta: 0,
      kPhi: 0,
      kBasis: 0,
      epsInBp: 0,
      exitTakerShare: 0,
      skew: { s1: 0, s3: 0 },
    },
  });
  expect(config.strategy.placeholders).toBe(false);
  expect(config.strategy.missingTunables).toEqual([]);
  expect(config.strategy.compressionBudgetBp).toBe(0);
  expect(config.strategy.allowAfTaking).toBe(false);
});

for (const field of STRATEGY_TUNABLES)
  test(`a single missing strategy.${field} is tracked`, () => {
    const input = configInput({
      ...DEFAULT_CONFIG,
      strategy: configuredStrategy,
    });
    if (field === "skew.s1") delete (input.strategy.skew as { s1?: number }).s1;
    else if (field === "skew.s3")
      delete (input.strategy.skew as { s3?: number }).s3;
    else delete (input.strategy as Partial<typeof input.strategy>)[field];
    const config = runtimeConfigSchema.parse(input);
    expect(config.strategy.placeholders).toBe(true);
    expect(config.strategy.missingTunables).toEqual([field]);
  });

for (const field of ["placeholders", "missingTunables"])
  test(`YAML cannot forge derived strategy.${field} metadata`, () => {
    expect(() =>
      runtimeConfigSchema.parse({
        ...CONFIG_INPUT,
        strategy: { [field]: field === "placeholders" ? false : [] },
      }),
    ).toThrow(field);
  });
