import { expect, test } from "bun:test";
import { Logger } from "../../src/core/logger";
import { Engine } from "../../src/engine/engine";
import { fixture } from "./helpers";

test("quote, transaction, fill, hedge, reconciliation and market status are NDJSON with mode", async () => {
  const f = fixture(),
    events: Record<string, unknown>[] = [];
  const engine = new Engine({
    ...f.options,
    logger: new Logger({ write: (line) => events.push(JSON.parse(line)) }),
  });
  await engine.start(false);
  await engine.tick();
  await engine.onFill(f.af.fill());
  await engine.reconcileAll();
  await engine.tripBreaker("manual_test");
  await engine.shutdown();
  for (const type of [
    "quote_plan",
    "af_tx",
    "fill",
    "hedge_sent",
    "hedge_result",
    "reconcile",
    "fail_closed",
    "market_status",
  ])
    expect(events.some((e) => e.type === type)).toBe(true);
  expect(events.every((e) => e.mode === "paper")).toBe(true);
  const plan = events.find((e) => e.type === "quote_plan");
  expect(typeof plan?.target).toBe("number");
  expect(plan?.ordersToPlace).toBe(1);
  const tx = events.find((e) => e.type === "af_tx");
  expect(tx?.updatedPremiumTwap).toBeNull();
  f.store.close();
});
test("quote planning is bounded even when unchanged orders trigger fast events", async () => {
  const f = fixture(),
    events: Record<string, unknown>[] = [];
  const engine = new Engine({
    ...f.options,
    logger: new Logger({ write: (line) => events.push(JSON.parse(line)) }),
  });
  await engine.start(false);
  await engine.tick();
  f.clock.advance(1000);
  f.feeds.fresh();
  await engine.tick();
  const before = events.filter((e) => e.type === "quote_plan").length;
  f.feeds.view("SOL").lighterHourlyFunding = 0.0001;
  for (let i = 0; i < 10; i++)
    await engine.handle({
      type: "market",
      market: "SOL",
      view: f.feeds.view("SOL"),
    });
  expect(events.filter((e) => e.type === "quote_plan")).toHaveLength(before);
  f.clock.advance(1000);
  f.feeds.fresh();
  await engine.tick();
  expect(events.filter((e) => e.type === "quote_plan").length).toBeGreaterThan(
    before,
  );
  f.store.close();
});
test("pnl includes per-venue funding source labels", () => {
  const f = fixture();
  f.store.funding({
    venue: "lighter",
    market: "SOL",
    ts: 1,
    amount: -12n,
    key: "fund",
    source: "venue",
  });
  const rows = f.engine.pnl(true);
  expect(
    rows[0]?.fundingByVenue.find(
      (p) => p.venue === "lighter" && p.source === "venue",
    )?.amount,
  ).toBe("-12");
  f.store.close();
});
