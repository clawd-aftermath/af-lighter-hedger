import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/defaults";
import { PublicFeeds } from "../../src/engine/feeds";
import { staleReason } from "../../src/engine/freshness";
import type { AfAccount, AfMarkets } from "../../src/venues/aftermath";
import { marketSchema } from "../../src/venues/aftermath/types";
import type { LighterRest, LighterWs } from "../../src/venues/lighter";
import data from "../fixtures/aftermath/markets.json";
import { FakeClock, FakeFeeds, fixture, required } from "./helpers";

test("quiet but live AF book remains verified by periodic REST snapshots", async () => {
  const f = fixture(),
    clock = f.clock,
    market = required(f.markets[0]);
  const raw = marketSchema.parse(data.marketDatas[0]?.market);
  raw.objectId = market.af.id;
  const feeds = new PublicFeeds({
    markets: f.markets,
    clock,
    config: f.config,
    oracle: {
      read: async () =>
        new Map([["SOL", { price: 100000000000n, timestamp: clock.now() }]]),
    },
    afMarkets: {
      http: { baseUrl: "https://aftermath.finance" },
      markets: async () => [{ market: raw, metadata: null }],
      orderbooks: async () => [
        {
          marketId: market.af.id,
          orderbook: {
            bids: [{ price: 99, size: 10 }],
            asks: [{ price: 101, size: 10 }],
            nonce: 1n,
          },
        },
      ],
    } as unknown as AfMarkets,
    afAccount: {} as AfAccount,
    lighterRest: {
      orderBookOrders: async () => ({
        bids: [{ price: "99", remainingBaseAmount: "10" }],
        asks: [{ price: "101", remainingBaseAmount: "10" }],
      }),
      fundings: async () => [],
    } as unknown as LighterRest,
    lighterWs: {} as LighterWs,
  });
  await feeds.refresh();
  for (let i = 0; i < 6; i++) {
    clock.advance(20000);
    await feeds.resnapshotAf();
    await feeds.refreshOracle();
    const v = feeds.view("SOL");
    v.afFrameTs = v.lighterFrameTs = clock.now();
    v.lighterBook.ts = v.statsTs = clock.now();
    v.fundingObserved = true;
    expect(staleReason(v, clock.now(), f.config)).toBeNull();
  }
  f.store.close();
});
test("dead socket fails closed even if REST values are recent", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  f.clock.advance(16000);
  f.feeds.fresh();
  f.feeds.view("SOL").afFrameTs = f.clock.now() - 16000;
  await f.engine.watchdog();
  expect(f.af.orders).toHaveLength(0);
  expect(staleReason(f.feeds.view("SOL"), f.clock.now(), f.config)).toBe(
    "socket_dead",
  );
  f.store.close();
});
test("old source oracle time fails closed despite active messages", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  f.clock.advance(11000);
  f.feeds.fresh();
  const v = f.feeds.view("SOL");
  v.oracleTs = f.clock.now() - 11000;
  v.afFrameTs = v.lighterFrameTs = f.clock.now();
  await f.engine.reconcileAll();
  await f.engine.tick();
  expect(f.af.orders).toHaveLength(0);
  expect(f.alerts.at(-1)?.reason).toBe("stale_af_oracle");
  f.store.close();
});
test("quiet stats and market state use measured cadence limits", () => {
  const clock = new FakeClock(),
    feeds = new FakeFeeds(clock);
  clock.advance(12000);
  const v = feeds.view("SOL");
  v.afBook.ts = v.lighterBook.ts = v.oracleTs = clock.now();
  expect(staleReason(v, clock.now(), DEFAULT_CONFIG)).toBeNull();
  clock.advance(19000);
  v.afBook.ts = v.lighterBook.ts = v.oracleTs = clock.now();
  expect(staleReason(v, clock.now(), DEFAULT_CONFIG)).toBe("stale_af_market");
});
test("future oracle timestamps are refused", () => {
  const clock = new FakeClock(),
    v = new FakeFeeds(clock).view("SOL");
  v.oracleTs = clock.now() + 5000;
  expect(staleReason(v, clock.now(), DEFAULT_CONFIG)).toBe("stale_af_oracle");
});
