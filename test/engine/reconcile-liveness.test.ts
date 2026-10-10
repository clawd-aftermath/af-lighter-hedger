import { expect, test } from "bun:test";
import { runtimeConfigSchema } from "../../src/config/schema";
import { Logger } from "../../src/core/logger";
import { Engine } from "../../src/engine/engine";
import { resolveMarkets } from "../../src/engine/markets";
import type { AfVenue, LighterVenue } from "../../src/engine/types";
import { configInput } from "../fixtures/config";
import {
  afMarket,
  book,
  FakeAf,
  FakeFeeds,
  FakeLighter,
  fixture,
  lighterMarket,
  required,
} from "./helpers";

function setup(symbols = ["SOL"]) {
  const f = fixture();
  const events: Record<string, unknown>[] = [];
  f.config.mode = "live";
  f.config.aftermath.maxRequotesPerMinute = 120;
  const markets = resolveMarkets(
    symbols.map((symbol) => ({ ...required(f.markets[0]).config, symbol })),
    symbols.map(afMarket),
    symbols.map(lighterMarket),
  );
  const feeds = new FakeFeeds(f.clock, symbols);
  const af = new Map(symbols.map((s) => [s, new FakeAf(f.clock, f.store)]));
  const lighter = new Map(
    symbols.map((s) => [s, new FakeLighter(f.clock, f.store)]),
  );
  const getAf = (s: string) => required(af.get(s));
  const getLighter = (s: string) => required(lighter.get(s));
  const afVenue: AfVenue = {
    position: (s) => getAf(s).position(s),
    quote: (r, c) => getAf(r.market).quote(r, c),
    cancel: (s, o, c) => getAf(s).cancel(s, o, c),
    flatten: (s, side, size, slippage, c) =>
      getAf(s).flatten(s, side, size, slippage, c),
    resolve: (i) => getAf(i.market).resolve(i),
  };
  const lighterVenue: LighterVenue = {
    position: (s) => getLighter(s).position(s),
    hedge: (r, c) => getLighter(r.intent.marketId).hedge(r, c),
    resolve: (i) => getLighter(i.market).resolve(i),
  };
  const engine = new Engine({
    ...f.options,
    mode: "live",
    markets,
    feeds,
    af: afVenue,
    lighter: lighterVenue,
    logger: new Logger({ write: (line) => events.push(JSON.parse(line)) }),
  });
  const positionEvent = (symbol: string) =>
    engine.handle({
      type: "position",
      market: symbol,
      afPosition: { base: getAf(symbol).base, exists: true },
    });
  return { ...f, engine, feeds, getAf, getLighter, positionEvent, events };
}

test("race F: 60 seconds of 1-second requotes cannot starve a lost fill correction", async () => {
  const f = setup();
  const af = f.getAf("SOL");
  const lighter = f.getLighter("SOL");
  await f.engine.start(false);
  af.onQuote = () =>
    f.feeds.emit({
      type: "position",
      market: "SOL",
      afPosition: { base: af.base, exists: true },
    });
  await f.engine.tick();
  await f.engine.idle();
  for (let second = 1; second <= 60; second++) {
    f.clock.advance(1000);
    f.feeds.fresh();
    const view = f.feeds.view("SOL");
    view.lighterBook = book(f.clock.now(), 99, 101);
    for (const level of [...view.lighterBook.asks, ...view.lighterBook.bids])
      level.price += BigInt(second % 2) * 10000000n;
    if (second === 20) {
      af.fill(200000000n); // The AF fill event is deliberately lost.
      await f.positionEvent("SOL");
    }
    await f.engine.tick();
    await f.engine.idle();
    await f.positionEvent("SOL");
    await f.engine.reconcileAll();
    if (second < 23) expect(lighter.requests).toHaveLength(0);
    else
      expect(lighter.requests.map((r) => r.intent.size)).toEqual([200000000n]);
    if (second >= 3 && (second < 20 || second >= 23))
      expect(
        f.events.filter((e) => e.type === "reconcile").at(-1)?.action,
      ).not.toBe("deferred");
  }
  expect(af.quotes).toHaveLength(61);
  expect(f.alerts.some((a) => a.reason === "reconcile_starved")).toBe(false);
  expect(af.base + lighter.base).toBe(0n);
  await f.engine.shutdown();
  f.store.close();
});

test("race G: position activity on SOL cannot defer ETH lost fill reconciliation", async () => {
  const f = setup(["SOL", "ETH"]);
  await f.engine.start(false);
  await f.engine.tick();
  f.getAf("ETH").fill(200000000n);
  await f.positionEvent("ETH");
  for (let second = 1; second <= 3; second++) {
    f.clock.advance(1000);
    f.feeds.fresh();
    f.getAf("SOL").base -= 10000000n;
    // An account update notifies every configured market, including unchanged ETH.
    await f.positionEvent("SOL");
    await f.positionEvent("ETH");
    await f.engine.reconcileAll();
  }
  expect(f.getLighter("SOL").requests).toHaveLength(0);
  expect(f.getLighter("ETH").requests.map((r) => r.intent.size)).toEqual([
    200000000n,
  ]);
  expect(f.getAf("ETH").base + f.getLighter("ETH").base).toBe(0n);
  expect(
    f.events.filter((e) => e.type === "reconcile" && e.market === "SOL").at(-1)
      ?.action,
  ).toBe("deferred");
  await f.engine.shutdown();
  f.store.close();
});

test("race H: continuous base changes trigger quote withdrawal and one corrective hedge", async () => {
  const f = setup(["SOL", "ETH"]);
  const af = f.getAf("SOL");
  const lighter = f.getLighter("SOL");
  await f.engine.start(false);
  await f.engine.tick();
  for (let change = 1; change <= 9; change++) {
    f.clock.advance(2000);
    f.feeds.fresh();
    af.base = -(190000000n + BigInt(change) * 10000000n);
    await f.positionEvent("SOL");
    await f.engine.tick();
    await f.engine.reconcileAll();
    expect(lighter.requests).toHaveLength(0);
    if (change < 9) {
      expect(af.orders.length).toBeGreaterThan(0);
      expect(f.alerts.some((a) => a.reason === "reconcile_starved")).toBe(
        false,
      );
    }
  }
  expect(f.clock.now()).toBe(118000);
  expect(af.orders).toHaveLength(0);
  expect(f.getAf("ETH").orders.length).toBeGreaterThan(0);
  expect(f.alerts.filter((a) => a.reason === "reconcile_starved")).toHaveLength(
    1,
  );
  const quotes = af.quotes.length;
  f.clock.advance(f.config.risk.reconcileQuiescenceMs - 1);
  f.feeds.fresh();
  await f.positionEvent("SOL"); // Cancellation/pending-order update; base unchanged.
  await f.engine.tick();
  await f.engine.reconcileAll();
  expect(af.quotes).toHaveLength(quotes);
  expect(f.getAf("ETH").orders.length).toBeGreaterThan(0);
  expect(lighter.requests).toHaveLength(0);
  f.clock.advance(1);
  await f.engine.reconcileAll();
  expect(lighter.requests.map((r) => r.intent.size)).toEqual([280000000n]);
  expect(af.base + lighter.base).toBe(0n);
  await f.engine.tick();
  expect(af.quotes.length).toBeGreaterThan(quotes);
  expect(af.orders.length).toBeGreaterThan(0);
  await f.engine.reconcileAll();
  expect(lighter.requests).toHaveLength(1);
  expect(f.getLighter("ETH").requests).toHaveLength(0);
  expect(f.engine.breaker.state.latched).toBe(false);
  await f.engine.shutdown();
  f.store.close();
});

test("race: a position read starts quiescence only when the observed base changes", async () => {
  const f = setup();
  await f.engine.start(false);
  f.clock.advance(5000);
  f.feeds.fresh();
  f.getAf("SOL").base = -200000000n;
  await f.engine.reconcileAll();
  expect(f.getLighter("SOL").requests).toHaveLength(0);
  expect(f.events.at(-1)).toMatchObject({
    action: "deferred",
    reason: "af_activity",
  });
  f.clock.advance(f.config.risk.reconcileQuiescenceMs);
  f.feeds.fresh();
  await f.engine.reconcileAll();
  expect(f.getLighter("SOL").requests.map((r) => r.intent.size)).toEqual([
    200000000n,
  ]);
  expect(f.getAf("SOL").base + f.getLighter("SOL").base).toBe(0n);
  f.store.close();
});

for (const kind of ["quote", "cancel"] as const)
  test(`race: pending AF post-only ${kind} does not defer a lost fill correction`, async () => {
    const f = setup();
    await f.engine.start(false);
    f.getAf("SOL").base = -200000000n;
    await f.positionEvent("SOL");
    const intent = f.store.createIntent({
      venue: "af",
      kind,
      market: "SOL",
      clientId: "pending",
      payload: kind === "quote" ? { postOnly: true } : {},
    });
    f.store.updateIntent(intent.id, "unknown", "quote-hash");
    f.clock.advance(f.config.risk.reconcileQuiescenceMs);
    await f.engine.reconcileAll();
    expect(f.getLighter("SOL").requests.map((r) => r.intent.size)).toEqual([
      200000000n,
    ]);
    expect(f.getAf("SOL").base + f.getLighter("SOL").base).toBe(0n);
    f.store.close();
  });

for (const kind of ["flatten", "quote"] as const)
  test(`race: pending AF position-changing ${kind} defers reconciliation`, async () => {
    const f = setup();
    await f.engine.start(false);
    f.getAf("SOL").base = -200000000n;
    await f.positionEvent("SOL");
    const intent = f.store.createIntent({
      venue: "af",
      kind,
      market: "SOL",
      clientId: "pending",
      payload: { postOnly: false },
    });
    f.store.updateIntent(intent.id, "unknown", "position-hash");
    f.clock.advance(f.config.risk.reconcileQuiescenceMs);
    await f.engine.reconcileAll();
    expect(f.getLighter("SOL").requests).toHaveLength(0);
    expect(f.events.at(-1)).toMatchObject({
      type: "reconcile",
      action: "deferred",
      reason: "pending_intent",
    });
    f.store.close();
  });

test("race: position object appearance and disappearance count as activity at zero base", async () => {
  const f = setup();
  const af = f.getAf("SOL");
  let exists = true;
  const position = af.position.bind(af);
  af.position = async (s) => ({ ...(await position(s)), exists });
  await f.engine.start(false);
  f.clock.advance(f.config.risk.reconcileQuiescenceMs);
  await f.engine.reconcileAll();
  for (const next of [false, true]) {
    exists = next;
    await f.engine.handle({
      type: "position",
      market: "SOL",
      afPosition: { base: 0n, exists },
    });
    expect(f.events.at(-1)).toMatchObject({
      action: "deferred",
      reason: "af_activity",
    });
    f.clock.advance(f.config.risk.reconcileQuiescenceMs);
    await f.engine.reconcileAll();
    expect(f.events.at(-1)).toMatchObject({ action: "noop" });
  }
  f.store.close();
});

test("max reconcile deferral defaults to 15000 ms and validates overrides", () => {
  const f = fixture();
  expect(f.config.risk.maxReconcileDeferralMs).toBe(15000);
  for (const value of [
    4500,
    0,
    -1,
    1.5,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const result = runtimeConfigSchema.safeParse({
      ...configInput(f.config),
      risk: { ...f.config.risk, maxReconcileDeferralMs: value },
    });
    expect(result.success).toBe(value === 4500);
  }
  f.store.close();
});
