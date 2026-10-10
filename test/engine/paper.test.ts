import { expect, test } from "bun:test";
import { Logger } from "../../src/core/logger";
import { AF_SCALE } from "../../src/core/units";
import type { RealAfVenue, RealLighterVenue } from "../../src/engine/adapters";
import { Engine } from "../../src/engine/engine";
import type { AfReceipt } from "../../src/engine/types";
import { dryVenues } from "../../src/paper/dry";
import { PaperVenues } from "../../src/paper/venues";
import { book, fixture } from "./helpers";

function setup() {
  const f = fixture();
  const paper = new PaperVenues(f.feeds, f.markets, f.store, f.clock);
  const engine = new Engine({
    ...f.options,
    af: paper.af,
    lighter: paper.lighter,
    feeds: paper.feeds,
  });
  return { ...f, paper, engine };
}
test("recorded book sequence produces a paper fill, hedge and zero net", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  const original = f.store.orders("SOL")[0];
  expect(original).toBeDefined();
  const sequence = [
    book(f.clock.now(), 99, 103),
    book(f.clock.now() + 1000, 100, 104),
    book(f.clock.now() + 2000, 103, 105),
  ];
  for (const next of sequence) {
    f.clock.time = next.ts;
    f.feeds.fresh();
    f.feeds.view("SOL").afBook = next;
    f.feeds.emit({ type: "market", market: "SOL", view: f.feeds.view("SOL") });
    await f.engine.idle();
  }
  expect(f.store.fills().length).toBeGreaterThan(0);
  expect(
    f.store
      .intents()
      .some((i) => i.venue === "lighter" && i.status === "confirmed"),
  ).toBe(true);
  const status = await f.engine.status();
  expect(status.positions[0]?.netDelta).toBe("0");
  expect(status.mode).toBe("paper");
  await f.engine.shutdown();
  f.store.close();
});
test("paper public book includes tagged own levels for exact outside removal", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  const own = f.store.orders("SOL")[0];
  expect(
    f.paper.feeds
      .view("SOL")
      .afBook.asks.some((l) => l.clientOrderId === own?.clientOrderId),
  ).toBe(true);
  await f.engine.shutdown();
  f.store.close();
});
test("paper IOC walks live depth and rehedges a terminal remainder", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  const order = f.store.orders("SOL")[0];
  if (!order) throw new Error("Missing quote");
  f.feeds.view("SOL").lighterBook = {
    ...book(f.clock.now(), 99, 100),
    asks: [
      { price: 100n * AF_SCALE, size: 200000000n },
      { price: 101n * AF_SCALE, size: 10n * AF_SCALE },
    ],
  };
  f.feeds.view("SOL").afBook = book(f.clock.now(), 103, 105);
  f.paper.tradeThrough("SOL");
  await f.engine.idle();
  expect(f.engine.state("SOL").unhedgedBase).toBe(0n);
  expect((await f.engine.status()).positions[0]?.netDelta).toBe("0");
  await f.engine.shutdown();
  f.store.close();
});
test("paper outbox replay after startup position correction cannot double hedge", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  f.feeds.view("SOL").afBook = book(f.clock.now(), 103, 105);
  f.paper.feeds.stop();
  const fills = f.paper.tradeThrough("SOL");
  expect(fills).toHaveLength(1);
  const restarted = new Engine({
    ...f.options,
    af: f.paper.af,
    lighter: f.paper.lighter,
    feeds: f.paper.feeds,
  });
  await restarted.start(false);
  await restarted.idle();
  expect((await restarted.status()).positions[0]?.netDelta).toBe("0");
  expect(f.store.intents().filter((i) => i.venue === "lighter")).toHaveLength(
    1,
  );
  expect(f.store.fills()).toHaveLength(1);
  await restarted.shutdown();
  f.store.close();
});
test("dry builds/simulates and signs without calling venue sends", async () => {
  const f = setup();
  let simulated = 0;
  let signed = 0;
  let sent = 0;
  const events: Record<string, unknown>[] = [];
  const realAf = {
    quote: async () => {
      simulated++;
      return {
        status: "success",
        digest: "simulated",
        updatedPremiumTwap: true,
        gasUsd: 0n,
        simulated: true,
      };
    },
    cancel: async () => {
      simulated++;
      return {
        status: "success",
        digest: "simulated",
        updatedPremiumTwap: false,
        gasUsd: 0n,
        simulated: true,
      };
    },
  } as unknown as RealAfVenue;
  const realLighter = {
    signOffline: () => {
      signed++;
      return { txHash: "offline", txType: 14, txInfo: "signed" };
    },
    hedge: async () => {
      sent++;
      throw new Error("send forbidden");
    },
  } as unknown as RealLighterVenue;
  const venues = dryVenues(
    f.paper,
    realAf,
    realLighter,
    f.store,
    async () => 1n,
  );
  const config = { ...f.config, mode: "dry" as const };
  const engine = new Engine({
    ...f.options,
    config,
    mode: "dry",
    ...venues,
    feeds: f.paper.feeds,
    logger: new Logger({ write: (line) => events.push(JSON.parse(line)) }),
  });
  await engine.start(false);
  await engine.tick();
  f.feeds.view("SOL").afBook = book(f.clock.now(), 103, 105);
  f.paper.tradeThrough("SOL");
  await engine.idle();
  expect(simulated).toBeGreaterThan(0);
  expect(signed).toBe(1);
  expect(sent).toBe(0);
  expect(engine.health().mode).toBe("dry");
  // The filled quote is gone; create another one to exercise cancellation.
  f.clock.advance(2000);
  f.feeds.fresh();
  f.feeds.view("SOL").afBook = book(f.clock.now());
  await engine.tick();
  await engine.cancelAll();
  await engine.shutdown();
  expect(
    events
      .filter((e) => e.type === "af_tx" && e.kind === "quote")
      .every((e) => e.updatedPremiumTwap === true),
  ).toBe(true);
  expect(
    events.some(
      (e) =>
        e.type === "af_tx" &&
        e.kind === "cancel" &&
        e.updatedPremiumTwap === false,
    ),
  ).toBe(true);
  f.store.close();
});
test("expired paper orders do not fill", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  f.clock.advance(f.config.aftermath.quoteTtlMs + 1);
  f.feeds.view("SOL").afBook = book(f.clock.now(), 103, 105);
  expect(f.paper.tradeThrough("SOL")).toHaveLength(0);
  await f.engine.shutdown();
  f.store.close();
});

test("paper quote, cancel and flatten receipts and events report unknown premium TWAP", async () => {
  const f = setup();
  const events: Record<string, unknown>[] = [];
  const engine = new Engine({
    ...f.options,
    af: f.paper.af,
    lighter: f.paper.lighter,
    feeds: f.paper.feeds,
    logger: new Logger({ write: (line) => events.push(JSON.parse(line)) }),
  });
  await engine.start(false);
  await engine.tick();
  f.store.set("paper:af:base:SOL", AF_SCALE);
  await engine.flatten("SOL", true);
  await engine.shutdown();
  const transactions = events.filter((e) => e.type === "af_tx");
  for (const kind of ["quote", "cancel", "unwind"])
    expect(transactions.some((e) => e.kind === kind)).toBe(true);
  for (const tx of transactions) {
    expect(tx.execution).toBe("paper");
    expect(tx.updatedPremiumTwap).toBeNull();
  }
  for (const intent of f.store.intents().filter((i) => i.venue === "af")) {
    const receipt = f.store.get<AfReceipt>(`paper:result:${intent.id}`);
    expect(receipt?.updatedPremiumTwap).toBeNull();
    const resolution = await f.paper.af.resolve(intent);
    expect(resolution.status).toBe("confirmed");
    if (
      "result" in resolution &&
      resolution.result &&
      "updatedPremiumTwap" in resolution.result
    )
      expect(resolution.result.updatedPremiumTwap).toBeNull();
  }
  f.store.close();
});
