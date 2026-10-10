import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { parse, stringify } from "yaml";
import { funding } from "../../src/cli/commands/funding";
import { bookMetrics, marketRows } from "../../src/cli/commands/markets";
import { TERMS_MESSAGE } from "../../src/cli/commands/setup";
import { main } from "../../src/cli/main";
import { DEFAULT_CONFIG } from "../../src/config/defaults";
import type { MarketConfig, RuntimeConfig } from "../../src/config/schema";
import type { OperatorClients } from "../../src/ops/operator";
import { parseAf } from "../../src/venues/aftermath/http";
import {
  type MarketData,
  marketSchema,
  type Orderbook,
} from "../../src/venues/aftermath/types";
import type { LighterSigner } from "../../src/venues/lighter/signer";
import { parseBookOrder, parseMarket } from "../../src/venues/lighter/types";
import recorded from "../fixtures/cli/public-btc.json";
import { configInput, configuredStrategy } from "../fixtures/config";

async function withSettings(
  config: RuntimeConfig,
  markets: MarketConfig[],
  body: (configPath: string, marketPath: string) => Promise<void>,
) {
  const directory = mkdtempSync("test/fixtures/cli/temporary-");
  const configPath = `${directory}/config.yaml`;
  const marketPath = `${directory}/markets.yaml`;
  try {
    writeFileSync(configPath, stringify(configInput(config)));
    writeFileSync(marketPath, stringify(markets));
    await body(configPath, marketPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const marketFile = "test/fixtures/cli/markets.yaml";
const configFile = "test/fixtures/cli/config.yaml";
const key = Ed25519Keypair.generate();
const env = {
  AF_AGENT_PRIVATE_KEY: key.getSecretKey(),
  LIGHTER_API_PRIVATE_KEY: "synthetic-not-a-real-key",
};
const address = key.toSuiAddress();
function fakeClients(): OperatorClients {
  return {
    afMarkets: async () =>
      recorded.af.marketDatas.map((d) => ({
        market: marketSchema.parse(d.market),
        metadata: d.metadata,
      })) as MarketData[],
    afBooks: async () =>
      (
        parseAf(JSON.stringify(recorded.afBooks)) as {
          orderbooks: { marketId: string; orderbook: Orderbook }[];
        }
      ).orderbooks,
    lighterMarkets: async () =>
      recorded.lighter.order_book_details.map((r) => ({
        ...parseMarket(r),
        initialMarginFraction: r.default_initial_margin_fraction / 10000,
        indexPrice: Number(r.index_price),
      })),
    lighterBook: async () => ({
      bids: recorded.lighterBook.bids.map(parseBookOrder),
      asks: recorded.lighterBook.asks.map(parseBookOrder),
    }),
    lighterFunding: async () =>
      recorded.lighterFunding.fundings.map((r) => ({
        ...r,
        direction: r.direction as "long" | "short",
      })),
    rgp: async () => 1000n,
    signer: async () => ({}) as LighterSigner,
    lighterLimits: async () => ({
      userTier: "0",
      userTierName: "Standard",
      effectiveLitStakes: "0",
      makerFeeTick: 0,
      takerFeeTick: 0,
    }),
    lighterAccount: async () => ({
      accountIndex: 0n,
      collateral: "200",
      availableBalance: "100",
      positions: [],
    }),
    agentCap: async () => ({
      walletAddress: address,
      accountId: 1n,
      collateralCoinType:
        "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
      collateral: 100000000n,
      objectId: "0x1",
      objectVersion: 1,
      objectDigest: "synthetic",
      accountObjectId: "0x2",
      accountObjectInitialSharedVersion: 1n,
      isAgent: true,
      whitelistedAgentCapIds: [],
    }),
    afAccount: async () => ({
      accountId: 1n,
      totalEquityUsd: 200,
      availableCollateral: 100,
      availableCollateralUsd: 100,
      totalUnrealizedFundingsUsd: 0,
      totalUnrealizedPnlUsd: 0,
      positions: [],
    }),
    balance: async () => 1000000000n,
    gasPool: async () => ({
      gasPoolId: "0x3",
      balance: 1000000000n,
      whitelistedAddresses: [address],
    }),
  };
}
async function run(
  args: string[],
  clients = fakeClients(),
  keys: Readonly<Record<string, string | undefined>> = {},
) {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await main(["bun", "hedger", ...args], {
    env: keys,
    clients: () => clients,
    write: (s) => output.push(s),
    error: (s) => errors.push(s),
    now: () => 1794006000000,
  });
  return { code, output: output.join("\n"), errors: errors.join("\n") };
}
for (const command of [
  ["doctor"],
  ["markets"],
  ["markets", "list"],
  ["markets", "check"],
  ["funding"],
  ["setup"],
  ["setup", "aftermath"],
  ["setup", "aftermath", "terms-signature"],
  ["setup", "aftermath", "allocate"],
  ["setup", "lighter"],
  ["setup", "lighter", "check"],
])
  test(`operator help: ${command.join(" ")}`, async () => {
    const result = await run([...command, "--help"], {
      afMarkets: () => {
        throw new Error("No clients for help");
      },
    } as unknown as OperatorClients);
    expect(result.code).toBe(0);
    expect(result.output).toContain("Usage:");
  });
test("recorded BTC discovery has consistent hourly units, side signs and metrics", async () => {
  const rows = await marketRows(
    { marketsFile: marketFile },
    { clients: () => fakeClients(), now: () => 1794006000000 },
  );
  expect(rows).toHaveLength(1);
  const r = rows[0];
  expect(r).toBeDefined();
  if (!r) return;
  expect(r.configured).toBe(true);
  expect(r.enabled).toBe(true);
  expect(r.afAprPct).toBeCloseTo(r.afHourlyPct * 8760);
  expect(r.lighterAprPct).toBeCloseTo((r.lighterHourlyPct ?? 0) * 8760);
  expect(r.longAfShortLighterHourlyPct).toBe(
    -(r.shortAfLongLighterHourlyPct ?? 0),
  );
  expect(r.afSpreadBps).toBeGreaterThan(0);
  expect(r.lighterBuy500Bps).toBeGreaterThan(0);
  expect(r.afBidDepth1PctUsd).toBeGreaterThan(500);
  expect(r.afOiHeadroomUsd).toBeGreaterThan(500);
  const cli = await run([
    "markets",
    "list",
    "--json",
    "--markets-file",
    marketFile,
  ]);
  expect(cli.code).toBe(0);
  expect(JSON.parse(cli.output)[0].symbol).toBe("BTC");
});
test("markets check prints PASS and underlying WARN for recorded BTC", async () => {
  const result = await run([
    "markets",
    "check",
    "BTC",
    "--markets-file",
    marketFile,
  ]);
  expect(result.code).toBe(0);
  expect(result.output).toContain("PASS listing");
  expect(result.output).toContain("WARN underlying");
  expect(result.output).toContain("PASS hedge depth");
  expect(result.output).toContain("PASS increments");
  expect(result.output).toContain("margin estimate");
});
test("markets check fails insufficient hedge depth and unknown entry", async () => {
  const clients = fakeClients();
  clients.lighterBook = async () => ({
    bids: [
      {
        orderIndex: 1n,
        price: "82500",
        initialBaseAmount: "0.00001",
        remainingBaseAmount: "0.00001",
      },
    ],
    asks: [
      {
        orderIndex: 2n,
        price: "82600",
        initialBaseAmount: "0.00001",
        remainingBaseAmount: "0.00001",
      },
    ],
  });
  const result = await run(
    ["markets", "check", "BTC", "--markets-file", marketFile],
    clients,
  );
  expect(result.code).toBe(1);
  expect(result.output).toContain("FAIL hedge depth");
  expect(
    (await run(["markets", "check", "NOPE", "--markets-file", marketFile]))
      .code,
  ).toBe(1);
});
test("depth includes spread, sorts levels and rejects empty or crossed books", () => {
  const b = bookMetrics(
    [{ price: 99, size: 10 }],
    [
      { price: 102, size: 2 },
      { price: 101, size: 2 },
    ],
    300,
    150,
  );
  expect(b.buyClipBps).toBeCloseTo(200);
  expect(b.askDepthUsd).toBe(202);
  expect(() => bookMetrics([], [], 50)).toThrow();
  expect(() =>
    bookMetrics([{ price: 101, size: 1 }], [{ price: 100, size: 1 }], 50),
  ).toThrow();
});
test("doctor reports no FAIL with healthy configured clients and never prints keys", async () => {
  const result = await run(
    ["doctor", "--config", configFile, "--markets-file", marketFile],
    fakeClients(),
    env,
  );
  expect(result.code).toBe(0);
  expect(result.output).toContain("PASS strategy tunables");
  expect(result.output).toContain("PASS AF agent cap");
  expect(result.output).toContain("PASS Lighter API key and tier");
  expect(result.output).not.toContain(env.AF_AGENT_PRIVATE_KEY);
  expect(result.output).not.toContain(env.LIGHTER_API_PRIVATE_KEY);
});
test("doctor warns for paper without keys, fails dry without keys", async () => {
  const paper = await run(["doctor", "--markets-file", marketFile]);
  expect(paper.code).toBe(0);
  expect(paper.output).toContain("WARN AF_AGENT_PRIVATE_KEY");
  const dry = await run([
    "doctor",
    "--config",
    configFile,
    "--markets-file",
    marketFile,
  ]);
  expect(dry.code).toBe(1);
  expect(dry.output).toContain("FAIL LIGHTER_API_PRIVATE_KEY");
});
test("doctor fails malformed config, connectivity, owner caps, missing gas and tier mismatch", async () => {
  expect((await run(["doctor", "--config", "/nonexistent"])).output).toContain(
    "FAIL configuration",
  );
  const clients = fakeClients();
  clients.rgp = async () => {
    throw new Error(env.AF_AGENT_PRIVATE_KEY);
  };
  clients.balance = async () => 0n;
  const original = clients.agentCap;
  clients.agentCap = async (a) => {
    const cap = await original(a);
    if (!cap) throw new Error("Missing synthetic cap");
    return { ...cap, isAgent: false };
  };
  clients.lighterLimits = async () => ({
    userTier: "1",
    userTierName: "Premium",
    effectiveLitStakes: "0",
    makerFeeTick: 4,
    takerFeeTick: 28,
  });
  const result = await run(
    ["doctor", "--config", configFile, "--markets-file", marketFile],
    clients,
    env,
  );
  expect(result.code).toBe(1);
  for (const label of [
    "Sui gRPC RGP",
    "AF agent cap",
    "agent SUI gas",
    "Lighter tier",
  ])
    expect(result.output).toContain(`FAIL ${label}`);
  expect(result.output + result.errors).not.toContain(env.AF_AGENT_PRIVATE_KEY);
});
test("terms signature verifies the exact personal message with a throwaway key", async () => {
  const result = await run(
    ["setup", "aftermath", "terms-signature"],
    fakeClients(),
    { AF_OWNER_PRIVATE_KEY: key.getSecretKey() },
  );
  expect(result.code).toBe(0);
  const snippet = parse(
    result.output.slice(result.output.indexOf("ownerAddress:")),
  );
  expect(Buffer.from(snippet.termsBytesB64, "base64").toString()).toBe(
    TERMS_MESSAGE,
  );
  const publicKey = await verifyPersonalMessageSignature(
    new TextEncoder().encode(TERMS_MESSAGE),
    snippet.termsSignature,
  );
  expect(publicKey.toSuiAddress()).toBe(snippet.ownerAddress);
  expect(result.output).not.toContain(key.getSecretKey());
});
test("allocation preview refuses without confirm before settings, keys or clients", async () => {
  const result = await run(
    [
      "setup",
      "aftermath",
      "allocate",
      "BTC",
      "10.25",
      "--config",
      "/nonexistent",
    ],
    {} as OperatorClients,
    env,
  );
  expect(result.code).toBe(2);
  expect(result.output).toContain("10250000 atomic units");
  expect(result.errors).toContain("--confirm");
  expect(
    (await run(["setup", "aftermath", "allocate", "BTC", "0.0000001"])).code,
  ).toBe(1);
  expect(
    (await run(["setup", "aftermath", "allocate", "BTC", "1", "--confirm"]))
      .code,
  ).toBe(2);
});
test("Lighter setup check verifies registration and flags tier or auth errors", async () => {
  expect(
    (await run(["setup", "lighter", "check"], fakeClients(), env)).code,
  ).toBe(0);
  const clients = fakeClients();
  clients.lighterLimits = async () => {
    throw new Error(env.LIGHTER_API_PRIVATE_KEY);
  };
  const result = await run(["setup", "lighter", "check"], clients, env);
  expect(result.code).toBe(1);
  expect(result.output).toContain("FAIL");
  expect(result.output + result.errors).not.toContain(
    env.LIGHTER_API_PRIVATE_KEY,
  );
});
test("funding uses no books and watch waits exactly 30 seconds and stops on abort", async () => {
  const controller = new AbortController();
  const waits: number[] = [];
  const lines: string[] = [];
  const clients = fakeClients();
  clients.afBooks = async () => {
    throw new Error("Must not fetch books");
  };
  clients.lighterBook = async () => {
    throw new Error("Must not fetch books");
  };
  await funding(
    { markets: "BTC", watch: true, marketsFile: marketFile },
    {
      clients: () => clients,
      signal: controller.signal,
      sleep: async (ms) => {
        waits.push(ms);
        controller.abort();
      },
      write: (s) => lines.push(s),
      now: () => 1794006000000,
    },
  );
  expect(waits).toEqual([30000]);
  expect(lines.join("\n")).toContain("Lighter last %/h");
  expect(lines.join("\n")).toContain("BTC |");
  expect((await run(["funding", "--markets", "NOPE"])).code).toBe(1);
});
test("example YAML has no secrets and preserves defaults", () => {
  expect(readFileSync("config/config.example.yaml", "utf8")).not.toContain(
    env.AF_AGENT_PRIVATE_KEY,
  );
  expect(DEFAULT_CONFIG.strategy.compressionBudgetBp).toBe(0);
});

test("discovery sorts absolute differential, includes disabled entries and marks BYD with --all", async () => {
  const clients = fakeClients();
  const originals = await clients.afMarkets();
  const lOriginals = await clients.lighterMarkets();
  const base = originals[0];
  const lBase = lOriginals[0];
  if (!base || !lBase) throw new Error("Missing fixture");
  clients.afMarkets = async () => [
    base,
    ...["ETH", "BYD"].map((symbol, i) => ({
      ...base,
      market: {
        ...base.market,
        objectId: `0x${i + 10}`,
        marketParams: {
          ...base.market.marketParams,
          baseAssetSymbol: `${symbol}USD`,
        },
      },
      metadata: base.metadata
        ? { ...base.metadata, symbol: `${symbol}/USD:USDC` }
        : null,
    })),
  ];
  clients.lighterMarkets = async () => [
    lBase,
    { ...lBase, symbol: "ETH", marketId: 2 },
    { ...lBase, symbol: "BYD", marketId: 3 },
  ];
  const books = await clients.afBooks([]);
  clients.afBooks = async (ids) =>
    ids.map((marketId) => ({
      marketId,
      orderbook: books[0]?.orderbook as Orderbook,
    }));
  clients.lighterFunding = async (id) => [
    {
      timestamp: 1794006000,
      direction: "long",
      rate: id === 2 ? "1.00" : "0.0001",
      value: "0",
    },
  ];
  const markets: MarketConfig[] = [
    {
      symbol: "ETH",
      enabled: false,
      aftermath: { marketId: "auto" },
      lighter: { marketId: "auto" },
      clipUsd: 50,
      maxPositionUsd: 500,
      levels: 1,
    },
  ];
  await withSettings(DEFAULT_CONFIG, markets, async (config, marketsFile) => {
    const rows = await marketRows(
      { config, marketsFile },
      { clients: () => clients },
    );
    expect(rows.map((r) => r.symbol)).toEqual(["ETH", "BTC"]);
    expect(rows[0]?.enabled).toBe(false);
    expect(rows[0]?.configured).toBe(true);
    const all = await marketRows(
      { config, marketsFile, all: true },
      { clients: () => clients },
    );
    expect(all.find((r) => r.symbol === "BYD")?.exclusion).toContain(
      "different underlying",
    );
  });
});
test("discovery retains thin-book markets with unknown depth and warnings", async () => {
  const clients = fakeClients();
  clients.lighterBook = async () => ({ bids: [], asks: [] });
  clients.afBooks = async () => [];
  clients.lighterFunding = async () => {
    throw new Error("Unavailable");
  };
  const rows = await marketRows(
    { marketsFile: marketFile },
    { clients: () => clients },
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.lighterSpreadBps).toBeNull();
  expect(rows[0]?.afSpreadBps).toBeNull();
  expect(rows[0]?.lighterHourlyPct).toBeNull();
  expect(rows[0]?.warnings).toHaveLength(3);
});
test("markets check fails missing catalog, below-minimum clip and OI capacity", async () => {
  const clients = fakeClients();
  const original = clients.afMarkets;
  clients.afMarkets = async () => {
    throw new Error("Catalog down");
  };
  expect(
    (
      await run(
        ["markets", "check", "BTC", "--markets-file", marketFile],
        clients,
      )
    ).output,
  ).toContain("FAIL validation");
  clients.afMarkets = async () =>
    (await original()).map((d) => ({
      ...d,
      market: {
        ...d.market,
        marketParams: { ...d.market.marketParams, minOrderUsdValue: 1000 },
        marketState: {
          ...d.market.marketState,
          openInterest: d.market.marketParams.maxOpenInterest,
        },
      },
    }));
  const result = await run(
    ["markets", "check", "BTC", "--markets-file", marketFile],
    clients,
  );
  expect(result.code).toBe(1);
  expect(result.output).toContain("FAIL minimum clip");
  expect(result.output).toContain("FAIL OI headroom");
});
test("known BYD mismatch is a failed underlying check", async () => {
  const clients = fakeClients();
  const original = clients.afMarkets;
  const lOriginal = clients.lighterMarkets;
  clients.afMarkets = async () =>
    (await original()).map((d) => ({
      ...d,
      market: {
        ...d.market,
        marketParams: { ...d.market.marketParams, baseAssetSymbol: "BYDUSD" },
      },
    }));
  clients.lighterMarkets = async () =>
    (await lOriginal()).map((m) => ({ ...m, symbol: "BYD" }));
  const entry: MarketConfig = {
    symbol: "BYD",
    enabled: true,
    aftermath: { marketId: "auto" },
    lighter: { marketId: "auto" },
    clipUsd: 50,
    maxPositionUsd: 500,
    levels: 1,
  };
  await withSettings(DEFAULT_CONFIG, [entry], async (config, marketsFile) => {
    const result = await run(
      [
        "markets",
        "check",
        "BYD",
        "--config",
        config,
        "--markets-file",
        marketsFile,
      ],
      clients,
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "FAIL underlying: Known underlying mismatch",
    );
  });
});
test("doctor checks gas-pool terms, balance and normalized whitelist", async () => {
  const owner = Ed25519Keypair.generate();
  const signed = await owner.signPersonalMessage(
    new TextEncoder().encode(TERMS_MESSAGE),
  );
  const config = structuredClone(DEFAULT_CONFIG);
  config.strategy = structuredClone(configuredStrategy);
  config.mode = "dry";
  config.aftermath.accountId = "1";
  config.aftermath.gas.mode = "gas-pool";
  config.aftermath.gas.gasPool = {
    ownerAddress: owner.toSuiAddress(),
    termsBytesB64: signed.bytes,
    termsSignature: signed.signature,
  };
  const markets = parse(readFileSync(marketFile, "utf8")) as MarketConfig[];
  await withSettings(config, markets, async (configPath, marketsPath) => {
    const clients = fakeClients();
    const good = await run(
      ["doctor", "--config", configPath, "--markets-file", marketsPath],
      clients,
      env,
    );
    expect(good.code).toBe(0);
    expect(good.output).toContain("PASS AF gas pool terms");
    expect(good.output).toContain("PASS AF gas pool:");
    clients.gasPool = async () => ({
      gasPoolId: "0x3",
      balance: 1000000000n,
      whitelistedAddresses: [],
    });
    const bad = await run(
      ["doctor", "--config", configPath, "--markets-file", marketsPath],
      clients,
      env,
    );
    expect(bad.code).toBe(1);
    expect(bad.output).toContain("FAIL AF gas pool:");
  });
});
test("doctor checks USDC fee-cap balance and owner-key isolation", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.strategy = structuredClone(configuredStrategy);
  config.mode = "dry";
  config.aftermath.accountId = "1";
  config.aftermath.gas.mode = "dynamic-gas";
  config.aftermath.gas.dynamicGas = {
    coinType: recorded.af.marketDatas[0]?.market.collateralCoinType ?? "",
    maxFeeAtomic: "60000",
  };
  const markets = parse(readFileSync(marketFile, "utf8")) as MarketConfig[];
  await withSettings(config, markets, async (configPath, marketsPath) => {
    const clients = fakeClients();
    let selectedCoin = "";
    clients.balance = async (_, coin) => {
      selectedCoin = coin;
      return 1000000n;
    };
    const good = await run(
      ["doctor", "--config", configPath, "--markets-file", marketsPath],
      clients,
      env,
    );
    expect(good.code).toBe(0);
    expect(selectedCoin).toContain("::usdc::USDC");
    expect(good.output).toContain("PASS agent USDC gas");
    const isolated = await run(
      ["doctor", "--config", configPath, "--markets-file", marketsPath],
      clients,
      { ...env, AF_OWNER_PRIVATE_KEY: "synthetic-owner-secret" },
    );
    expect(isolated.code).toBe(1);
    expect(isolated.output).toContain("FAIL owner key isolation");
    expect(isolated.output).not.toContain("synthetic-owner-secret");
  });
});
test("confirmed allocation with insufficient collateral refuses before any builder", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.mode = "live";
  config.aftermath.accountId = "1";
  const markets = parse(readFileSync(marketFile, "utf8")) as MarketConfig[];
  await withSettings(config, markets, async (configPath, marketsPath) => {
    const clients = fakeClients();
    const account = await clients.afAccount();
    clients.afAccount = async () => ({ ...account, availableCollateral: 0 });
    const result = await run(
      [
        "setup",
        "aftermath",
        "allocate",
        "BTC",
        "10",
        "--confirm",
        "--config",
        configPath,
        "--markets-file",
        marketsPath,
      ],
      clients,
      env,
    );
    expect(result.code).toBe(2);
    expect(result.errors).toContain("Insufficient unallocated");
  });
});

for (const mode of ["paper", "dry", "live"] as const)
  test(`doctor reports unset strategy tunables in ${mode}`, async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.mode = mode;
    config.aftermath.accountId = "1";
    await withSettings(config, [], async (configPath) => {
      const result = await run(
        ["doctor", "--config", configPath, "--markets-file", marketFile],
        fakeClients(),
        env,
      );
      expect(result.code).toBe(mode === "paper" ? 0 : 1);
      expect(result.output).toContain(
        `${mode === "paper" ? "WARN" : "FAIL"} strategy tunables`,
      );
      for (const field of config.strategy.missingTunables)
        expect(result.output).toContain(`strategy.${field}`);
      expect(result.output).toContain("docs/configuration.md#strategy");
    });
  });
