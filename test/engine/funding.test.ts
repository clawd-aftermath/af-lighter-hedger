import { expect, test } from "bun:test";
import { hourlyPayment, recordAfFunding } from "../../src/engine/funding";
import { PaperVenues } from "../../src/paper/venues";
import { StateStore } from "../../src/state/store";
import { fixture } from "./helpers";

const base = 1000000000n;
for (const position of [2n * base, -2n * base])
  test(`AF cumulative funding sign for ${position}`, () => {
    const store = new StateStore(":memory:", "funding");
    recordAfFunding(store, "BTC", position, { long: 10, short: 10, ts: 1 });
    const rows = recordAfFunding(store, "BTC", position, {
      long: 12,
      short: 12,
      ts: 2,
    });
    expect(rows[0]?.amount).toBe(-position * 2n);
    expect(rows[0]?.source).toBe("derived");
    expect(
      recordAfFunding(store, "BTC", position, { long: 12, short: 12, ts: 2 }),
    ).toEqual([]);
    expect(store.fundingPayments()).toHaveLength(1);
    store.close();
  });
test("settlement uses preceding position and sign-specific cumulative rate", () => {
  const store = new StateStore(":memory:", "funding");
  recordAfFunding(store, "ETH", -base, { long: 10, short: 20, ts: 1 });
  expect(
    recordAfFunding(store, "ETH", 0n, { long: 12, short: 23, ts: 2 })[0]
      ?.amount,
  ).toBe(3n * base);
  expect(
    recordAfFunding(store, "ETH", 0n, { long: 11, short: 21, ts: 1 }),
  ).toEqual([]);
  expect(store.get<{ ts: number }>("af:funding_checkpoint:ETH")?.ts).toBe(2);
  store.close();
});
test("AF checkpoint survives adapter reconstruction without duplicate funding", () => {
  const store = new StateStore(":memory:", "funding");
  recordAfFunding(store, "SUI", base, { long: 0, short: 0, ts: 1 });
  recordAfFunding(store, "SUI", base, { long: 0.01, short: 0.01, ts: 2 });
  expect(
    recordAfFunding(store, "SUI", base, { long: 0.01, short: 0.01, ts: 2 }),
  ).toEqual([]);
  expect(store.fundingPayments()[0]?.amount).toBe(-10000000n);
  store.close();
});
test("paper pays both venues at top-of-hour once with source labels", async () => {
  const f = fixture();
  f.clock.time = 3599000;
  f.feeds.fresh();
  f.store.set("paper:af:base:SOL", -base);
  f.store.set("paper:lighter:base:SOL", base);
  const paper = new PaperVenues(f.feeds, f.markets, f.store, f.clock);
  await paper.af.funding?.();
  await paper.lighter.funding?.();
  f.clock.advance(1000);
  await paper.af.funding?.();
  await paper.lighter.funding?.();
  const payments = f.store.fundingPayments();
  expect(payments).toHaveLength(2);
  expect(payments.find((p) => p.venue === "af")?.amount).toBe(125000000n);
  expect(payments.find((p) => p.venue === "lighter")?.amount).toBe(-1000000n);
  expect(payments.every((p) => p.source === "paper" && p.ts === 3600000)).toBe(
    true,
  );
  await paper.af.funding?.();
  expect(f.store.fundingPayments()).toHaveLength(2);
  f.store.close();
});
test("hourly funding uses exact base, price and signed rates", () => {
  expect(hourlyPayment(2n * base, 100n * base, 0.001)).toBe(-200000000n);
  expect(hourlyPayment(-2n * base, 100n * base, 0.001)).toBe(200000000n);
  expect(() => hourlyPayment(base, base, NaN)).toThrow();
});

test("AF observes settlements every reconcile while Lighter payment history is hourly", async () => {
  const { Engine } = await import("../../src/engine/engine");
  const f = fixture();
  let afReads = 0,
    lighterReads = 0;
  const config = { ...f.config, mode: "dry" as const };
  const engine = new Engine({
    ...f.options,
    mode: "dry",
    config,
    af: {
      ...f.af,
      position: (s) => f.af.position(s),
      quote: (r, c) => f.af.quote(r, c),
      cancel: (s, o, c) => f.af.cancel(s, o, c),
      flatten: (s, d, n, b, c) => f.af.flatten(s, d, n, b, c),
      resolve: (i) => f.af.resolve(i),
      funding: async () => {
        afReads++;
        return [];
      },
    },
    lighter: {
      position: (s) => f.lighter.position(s),
      hedge: (r, c) => f.lighter.hedge(r, c),
      resolve: (i) => f.lighter.resolve(i),
      funding: async () => {
        lighterReads++;
        return [];
      },
    },
  });
  await engine.start(false);
  await engine.reconcileAll();
  expect(afReads).toBe(2);
  expect(lighterReads).toBe(1);
  f.clock.advance(3600000);
  f.feeds.fresh();
  await engine.reconcileAll();
  expect(lighterReads).toBe(2);
  f.store.close();
});

test("a paper fill after the hour does not retroactively receive prior-hour funding", async () => {
  const f = fixture();
  f.clock.time = 3599000;
  f.feeds.fresh();
  const paper = new PaperVenues(f.feeds, f.markets, f.store, f.clock);
  await paper.af.funding?.();
  await paper.lighter.funding?.();
  f.clock.advance(1000);
  f.feeds.fresh();
  f.store.set("paper:orders:SOL", [
    {
      marketId: "SOL",
      clientOrderId: "1",
      side: "ASK",
      price: 98000000000n,
      size: 1000000000n,
      reduceOnly: false,
      createdAt: 3599000,
      expiryTimestamp: 4000000,
    },
  ]);
  expect(paper.tradeThrough("SOL")).toHaveLength(1);
  await paper.af.funding?.();
  expect(f.store.fundingPayments().find((p) => p.venue === "af")?.amount).toBe(
    0n,
  );
  f.store.close();
});

test("dry shadow positions do not produce paper funding payments", async () => {
  const f = fixture();
  const paper = new PaperVenues(f.feeds, f.markets, f.store, f.clock, false);
  f.store.set("paper:af:base:SOL", -1000000000n);
  await paper.af.funding?.();
  f.clock.advance(3600000);
  f.feeds.fresh();
  paper.tradeThrough("SOL");
  await paper.af.funding?.();
  expect(f.store.fundingPayments()).toEqual([]);
  f.store.close();
});
