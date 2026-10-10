import { expect, test } from "bun:test";
import fc from "fast-check";
import type { BookLevel, OwnOrder } from "../../src/domain/types";
import {
  computeQuotes,
  outsideBook,
  type QuoteInput,
  type QuoteOrder,
} from "../../src/strategy/quoter";
import { quoteInput } from "./fixtures";

function places(i: QuoteInput): QuoteOrder[] {
  return computeQuotes(i).batches.flatMap((b) => b.place);
}
function resting(i: QuoteInput): QuoteInput {
  const plan = computeQuotes(i);
  const own: OwnOrder[] = plan.batches.flatMap((b) =>
    b.place.map((o, n) => ({
      ...o,
      marketId: i.marketId,
      clientOrderId: `${b.reduceOnly}:${n}`,
      createdAt: i.now,
    })),
  );
  const bids: BookLevel[] = [...i.book.bids];
  const asks: BookLevel[] = [...i.book.asks];
  for (const order of own)
    (order.side === "BID" ? bids : asks).push({
      price: order.price,
      size: order.size,
      clientOrderId: order.clientOrderId,
    });
  bids.sort((a, b) => (a.price > b.price ? -1 : a.price < b.price ? 1 : 0));
  asks.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  return { ...i, ownOrders: own, book: { ...i.book, bids, asks } };
}

test("positive predicted funding selects ASK", () =>
  expect(places(quoteInput())[0]?.side).toBe("ASK"));
test("negative predicted funding selects BID", () => {
  const i = quoteInput();
  i.funding.twaPremiumBp = -100;
  i.book = {
    ...i.book,
    bids: [{ price: 9700n, size: 10000n }],
    asks: [{ price: 10100n, size: 10000n }],
  };
  expect(places(i)[0]?.side).toBe("BID");
});
test("near zero funding cancels accumulation", () => {
  const i = quoteInput();
  i.funding.nearZeroHourly = 1;
  expect(computeQuotes(i).reasons).toContain("no_receiving_side");
  expect(places(i)).toEqual([]);
});
test("exact zero funding never accumulates", () => {
  const i = quoteInput();
  i.funding.twaPremiumBp = 0;
  i.book.asks = [{ price: 10100n, size: 10000n }];
  i.funding.nearZeroHourly = 0;
  expect(places(i)).toEqual([]);
});
test("SOL-like wide book chooses neutral with positive funding", () => {
  const p = computeQuotes(quoteInput());
  expect(p.diagnostics?.target).toBe(10100n);
  expect(p.diagnostics?.target).toBe(p.diagnostics?.neutral);
});
test("BTC-like oracle offset chooses profitability floor", () => {
  const i = quoteInput();
  i.book.bids = [{ price: 10010n, size: 10000n }];
  i.book.asks = [{ price: 10020n, size: 10000n }];
  i.lighterMid = 10100n;
  i.funding.twaPremiumBp = 1;
  i.funding.deltaHours = 0;
  const p = computeQuotes(i);
  expect(p.diagnostics?.target).toBe(p.diagnostics?.floor);
  expect(p.diagnostics?.target).toBeGreaterThan(p.diagnostics?.neutral ?? 0n);
});
test("negative explicit AF maker fee rebate reduces delta", () => {
  const i = quoteInput();
  i.lighterMid = 10500n;
  const a = computeQuotes(i).diagnostics;
  i.costs.makerFeeBp = -2;
  const b = computeQuotes(i).diagnostics;
  expect(b?.deltaBp).toBeCloseTo((a?.deltaBp ?? 0) - 2);
  expect(b?.floor).toBeLessThan(a?.floor ?? 0n);
});
test("positive inventory skew lowers ask floor", () => {
  const i = quoteInput();
  i.inventory = 100n;
  i.strategy.skew = { s1: 10, s3: 10 };
  const p = computeQuotes(i);
  i.strategy.skew = { s1: 0, s3: 0 };
  const zero = computeQuotes(i);
  expect(p.diagnostics?.deltaBp).toBeCloseTo(
    (zero.diagnostics?.deltaBp ?? 0) - 2.08,
  );
});
test("market compression overrides global and default zero respects floor", () => {
  const i = quoteInput();
  i.lighterMid = 10500n;
  const zero = computeQuotes(i);
  i.strategy.compressionBudgetBp = 100;
  const global = computeQuotes(i);
  expect(global.diagnostics?.target).toBeLessThan(
    zero.diagnostics?.target ?? 0n,
  );
  i.compressionBudgetBp = 0;
  expect(computeQuotes(i)).toEqual(zero);
});
for (const inventory of [-500n, -700n, 500n, 700n])
  test(`inventory ${inventory} at/beyond cap quotes reducing side only`, () => {
    const i = quoteInput();
    i.inventory = inventory;
    for (const o of places(i)) {
      expect(o.reduceOnly).toBe(true);
      expect(o.side).toBe(inventory > 0n ? "ASK" : "BID");
      expect(o.size).toBeLessThanOrEqual(
        inventory < 0n ? -inventory : inventory,
      );
    }
    expect(places(i).length).toBe(1);
  });
test("reduction at cap allowed when opening OI capacity exhausted", () => {
  const i = quoteInput();
  i.inventory = 500n;
  i.oi.maxOpenInterest = i.oi.openInterest;
  expect(places(i)[0]?.reduceOnly).toBe(true);
});
test("size is clipped to remaining position room", () => {
  const i = quoteInput();
  i.inventory = 490n;
  expect(places(i)[0]?.size).toBe(10n);
});
test("size is clipped to hedge depth", () => {
  const i = quoteInput();
  i.hedgeDepthBase = 7n;
  expect(places(i)[0]?.size).toBe(7n);
});
test("size is clipped to margin including pending opening orders", () => {
  const i = quoteInput();
  i.marginAvailableBase = 12n;
  i.pendingOpeningBase = 5n;
  expect(places(i)[0]?.size).toBe(7n);
});
test("size is clipped to remaining max OI", () => {
  const i = quoteInput();
  i.oi.maxOpenInterest = 2009n;
  expect(places(i)[0]?.size).toBe(9n);
});
test("size is clipped to half OI position rule", () => {
  const i = quoteInput();
  i.inventory = 490n;
  i.oi.openInterest = 1002n;
  i.maxPositionBase = 1000n;
  expect(places(i)[0]?.size).toBe(11n);
});
test("aggregate multi-level size respects capacity", () => {
  const i = quoteInput();
  i.levels = 3;
  i.hedgeDepthBase = 110n;
  expect(places(i).map((o) => o.size)).toEqual([50n, 50n, 10n]);
});
test("below minimum notional skipped", () => {
  const i = quoteInput();
  i.minNotional = 1000000n;
  expect(places(i)).toEqual([]);
  expect(computeQuotes(i).reasons).toContain("below_min_notional");
});
test("size rounds down to lot", () => {
  const i = quoteInput();
  i.lot = 7n;
  expect(places(i)[0]?.size).toBe(49n);
});
test("no capacity removes previous orders", () => {
  const i = resting(quoteInput());
  i.hedgeDepthBase = 0n;
  const p = computeQuotes(i);
  expect(p.batches.flatMap((b) => b.cancel)).toEqual(["false:0"]);
});
test("unchanged resting plan emits keep only", () => {
  const i = resting(quoteInput());
  const p = computeQuotes(i);
  expect(p.batches.flatMap((b) => b.keep).length).toBe(1);
  expect(p.batches.flatMap((b) => b.cancel)).toEqual([]);
  expect(p.batches.flatMap((b) => b.place)).toEqual([]);
  expect(computeQuotes(i)).toEqual(p);
});
test("within tick and edge band resting price remains untouched", () => {
  const i = resting(quoteInput());
  const own = i.ownOrders[0];
  if (!own) throw Error("missing order");
  own.price += 1n;
  i.book.asks = i.book.asks.map((l) =>
    l.clientOrderId === own.clientOrderId ? { ...l, price: own.price } : l,
  );
  expect(computeQuotes(i).batches.flatMap((b) => b.keep)[0]?.price).toBe(
    own.price,
  );
});
test("outside tick band replaces order", () => {
  const i = resting(quoteInput());
  i.index += 5n;
  expect(computeQuotes(i).batches.flatMap((b) => b.cancel)).toHaveLength(1);
});
test("edge band can be tighter than tick band", () => {
  const i = resting(quoteInput());
  i.index += 1n;
  i.edgeBandBp = 0;
  expect(computeQuotes(i).batches.flatMap((b) => b.cancel)).toHaveLength(1);
});
test("TTL expiry replaces order", () => {
  const i = resting(quoteInput());
  i.now += i.quoteTtlMs;
  expect(computeQuotes(i).batches.flatMap((b) => b.cancel)).toHaveLength(1);
});
test("requote throttling blocks new placements", () => {
  const i = quoteInput();
  i.requotesInLastMinute = 6;
  expect(places(i)).toEqual([]);
  expect(computeQuotes(i).reasons).toContain("requote_throttled");
});
test("requote throttling preserves unchanged resting order", () => {
  const i = resting(quoteInput());
  i.requotesInLastMinute = 6;
  expect(computeQuotes(i).batches.flatMap((b) => b.keep)).toHaveLength(1);
});
test("any failed gate cancels all (market, reduceOnly) batches", () => {
  const i = resting(quoteInput());
  i.ownOrders = [
    ...i.ownOrders,
    {
      ...(i.ownOrders[0] as OwnOrder),
      clientOrderId: "reducing",
      reduceOnly: true,
    },
  ];
  i.gates = [{ ok: false, reason: "stale_af_book" }];
  const p = computeQuotes(i);
  expect(p.batches).toHaveLength(2);
  expect(p.batches.flatMap((b) => b.cancel)).toEqual(["false:0", "reducing"]);
  expect(p.batches.flatMap((b) => b.place)).toEqual([]);
});
test("other market orders never canceled", () => {
  const i = quoteInput();
  i.ownOrders = [
    {
      marketId: "ETH",
      clientOrderId: "other",
      side: "ASK",
      price: 10200n,
      size: 1n,
      reduceOnly: false,
    },
  ];
  i.gates = [{ ok: false, reason: "breaker_latched" }];
  expect(computeQuotes(i).batches).toEqual([]);
});
test("outside aggregated book subtracts owned size at touch", () => {
  const i = quoteInput();
  const own: OwnOrder = {
    marketId: "SOL",
    clientOrderId: "own",
    side: "BID",
    price: 9999n,
    size: 10n,
    reduceOnly: false,
  };
  const book = {
    ...i.book,
    bids: [{ price: 9999n, size: 10n }, ...i.book.bids],
  };
  expect(outsideBook(book, [own])).toEqual(i.book);
});
test("outside aggregated level retains other liquidity", () => {
  const i = quoteInput();
  const own: OwnOrder = {
    marketId: "SOL",
    clientOrderId: "own",
    side: "BID",
    price: 9900n,
    size: 10n,
    reduceOnly: false,
  };
  expect(
    outsideBook({ ...i.book, bids: [{ price: 9900n, size: 30n }] }, [own])
      .bids[0]?.size,
  ).toBe(20n);
});
test("tagged other orders at same price survive own removal", () => {
  const i = quoteInput();
  const own: OwnOrder = {
    marketId: "SOL",
    clientOrderId: "own",
    side: "BID",
    price: 9900n,
    size: 10n,
    reduceOnly: false,
  };
  expect(
    outsideBook(
      {
        ...i.book,
        bids: [
          { price: 9900n, size: 10n, clientOrderId: "own" },
          { price: 9900n, size: 5n, clientOrderId: "other" },
        ],
      },
      [own],
    ).bids,
  ).toEqual([{ price: 9900n, size: 5n, clientOrderId: "other" }]);
});
for (const field of ["tick", "lot", "index", "lighterMid", "usdScale"] as const)
  test(`zero ${field} fails closed`, () => {
    const i = quoteInput();
    i[field] = 0n;
    expect(computeQuotes(i).reasons).toContain("invalid_input");
  });
test("unsorted book fails closed", () => {
  const i = quoteInput();
  i.book.bids = [
    { price: 9900n, size: 10n },
    { price: 9990n, size: 10n },
  ];
  expect(computeQuotes(i).reasons).toContain("invalid_book");
});
test("crossed book fails closed", () => {
  const i = quoteInput();
  i.book.asks = [{ price: 9800n, size: 10n }];
  expect(computeQuotes(i).reasons).toContain("invalid_book");
});
test("empty outside book fails closed", () => {
  const i = quoteInput();
  i.book.asks = [];
  expect(computeQuotes(i).reasons).toContain("empty_outside_book");
});
test("prices above safe integer stay exact", () => {
  const i = quoteInput();
  const factor = 9007199254740993n;
  i.index *= factor;
  i.lighterMid *= factor;
  i.tick *= factor;
  i.book.bids = i.book.bids.map((l) => ({ ...l, price: l.price * factor }));
  i.book.asks = i.book.asks.map((l) => ({ ...l, price: l.price * factor }));
  const p = computeQuotes(i);
  expect(p.diagnostics?.neutral).toBe(10100n * factor);
  expect(p.diagnostics?.target).toBe(10100n * factor);
});

const arb = fc.record({
  index: fc.integer({ min: 10000, max: 10000000 }),
  spread: fc.integer({ min: 20, max: 1000 }),
  offset: fc.integer({ min: -5, max: 5 }),
  inventory: fc.integer({ min: -600, max: 600 }),
  tick: fc.integer({ min: 1, max: 10 }),
  lot: fc.integer({ min: 1, max: 10 }),
  cap: fc.integer({ min: 10, max: 150 }),
  levels: fc.integer({ min: 1, max: 3 }),
});
type RandomBook = {
  index: number;
  spread: number;
  offset: number;
  inventory: number;
  tick: number;
  lot: number;
  cap: number;
  levels: number;
};
function randomInput(v: RandomBook): QuoteInput {
  const i = quoteInput();
  i.index = BigInt(v.index);
  i.lighterMid = i.index;
  i.inventory = BigInt(v.inventory);
  i.tick = BigInt(v.tick);
  i.lot = BigInt(v.lot);
  i.book.bids = [
    {
      price: i.index - BigInt(v.spread) + BigInt(v.offset * v.spread),
      size: 10000n,
    },
  ];
  i.book.asks = [
    {
      price: i.index + BigInt(v.spread) + BigInt(v.offset * v.spread),
      size: 10000n,
    },
  ];
  i.funding.twaPremiumBp = v.offset < 0 ? -100 : 100;
  i.hedgeDepthBase = BigInt(v.cap);
  i.marginAvailableBase = BigInt(v.cap + 5);
  i.levels = v.levels as 1 | 2 | 3;
  return i;
}
const options = { seed: 20261009, numRuns: 1200 };
test("property 1200 books: post-only, index clamp and profitable floor", () => {
  fc.assert(
    fc.property(arb, (v) => {
      const i = randomInput(v);
      const p = computeQuotes(i);
      const d = p.diagnostics;
      expect(d).toBeDefined();
      for (const o of p.batches.flatMap((b) => b.place)) {
        if (!d) throw Error("missing diagnostics");
        if (o.side === "ASK") {
          expect(o.price).toBeGreaterThanOrEqual(
            (i.book.bids[0]?.price ?? 0n) + i.tick,
          );
          if (d.outsidePremiumBp > 0)
            expect(o.price).toBeGreaterThanOrEqual(i.index);
          expect(o.price).toBeGreaterThanOrEqual(d.floor);
        } else {
          expect(o.price).toBeLessThanOrEqual(
            (i.book.asks[0]?.price ?? 0n) - i.tick,
          );
          if (d.outsidePremiumBp < 0)
            expect(o.price).toBeLessThanOrEqual(i.index);
          expect(o.price).toBeLessThanOrEqual(d.floor);
        }
      }
    }),
    options,
  );
});
test("property 1200 books: tick/lot aligned, aggregate caps, reducing side", () => {
  fc.assert(
    fc.property(arb, (v) => {
      const i = randomInput(v);
      const orders = places(i);
      const total = orders.reduce((n, o) => n + o.size, 0n);
      expect(total).toBeLessThanOrEqual(i.hedgeDepthBase);
      if (i.inventory > -500n && i.inventory < 500n)
        expect(total).toBeLessThanOrEqual(
          500n - (i.inventory < 0n ? -i.inventory : i.inventory),
        );
      for (const o of orders) {
        expect(o.price % i.tick).toBe(0n);
        expect(o.size % i.lot).toBe(0n);
        expect(o.size).toBeLessThanOrEqual(i.clipBase);
        if (i.inventory <= -500n || i.inventory >= 500n) {
          expect(o.reduceOnly).toBe(true);
          expect(o.side).toBe(i.inventory > 0n ? "ASK" : "BID");
        }
      }
    }),
    options,
  );
});
test("property 1200 books: inserting our orders at touch leaves quote computation unchanged", () => {
  fc.assert(
    fc.property(arb, (v) => {
      const i = randomInput(v);
      const p = computeQuotes(i);
      const augmented = resting(i);
      const d = computeQuotes(augmented).diagnostics;
      expect(d).toEqual(p.diagnostics);
      expect(computeQuotes(augmented).batches.flatMap((b) => b.cancel)).toEqual(
        [],
      );
    }),
    options,
  );
});
test("property 1200 books: input is immutable and replay deterministic", () => {
  fc.assert(
    fc.property(arb, (v) => {
      const i = resting(randomInput(v));
      const snapshot = structuredClone(i);
      const p = computeQuotes(i);
      expect(computeQuotes(i)).toEqual(p);
      expect(i).toEqual(snapshot);
      expect(p.batches.flatMap((b) => b.cancel)).toEqual([]);
    }),
    options,
  );
});

test("partially filled resting quote with legal size and unchanged price stays", () => {
  const i = resting(quoteInput());
  const o = i.ownOrders[0];
  if (!o) throw Error();
  o.size = 20n;
  i.book.asks = i.book.asks.map((l) =>
    l.clientOrderId === o.clientOrderId ? { ...l, size: 20n } : l,
  );
  const p = computeQuotes(i);
  expect(p.batches.flatMap((b) => b.keep)[0]?.size).toBe(20n);
  expect(p.batches.flatMap((b) => b.cancel)).toEqual([]);
  expect(p.batches.flatMap((b) => b.place)).toEqual([]);
});
test("huge edge band fails closed rather than throwing", () => {
  const i = quoteInput();
  i.edgeBandBp = 1e100;
  expect(computeQuotes(i).reasons).toContain("invalid_input");
});

test("USD clip is converted per level at its actual quote price", () => {
  const i = quoteInput();
  i.clipNotional = 5000n;
  i.levels = 3;
  const p = places(i);
  expect(p).toHaveLength(3);
  for (const o of p)
    expect(o.price * o.size * i.usdScale).toBeLessThanOrEqual(
      i.clipNotional * i.book.priceScale * i.book.sizeScale,
    );
});

for (const side of ["ASK", "BID"] as const)
  test(`maker rebate -0.5 bp shifts ${side} floor by exactly 0.5 bp`, () => {
    const i = quoteInput();
    i.lighterMid = 1000000n;
    i.funding.twaPremiumBp = side === "ASK" ? 100 : -100;
    i.funding.deltaHours = 0;
    i.lighterFunding = { hourlyFraction: 0, mean: 0, kappa: 0 };
    i.strategy.holdHours = 1;
    i.strategy.eta = 0;
    i.strategy.kPhi = 0;
    i.costs.makerFeeBp = 0;
    const zero = computeQuotes(i).diagnostics;
    i.costs.makerFeeBp = -0.5;
    const rebate = computeQuotes(i).diagnostics;
    if (!zero || !rebate) throw Error("expected diagnostics");
    expect(rebate.side).toBe(side);
    expect(rebate.deltaBp - zero.deltaBp).toBe(-0.5);
    expect(rebate.floor - zero.floor).toBe(side === "ASK" ? -50n : 50n);
  });
for (const side of ["ASK", "BID"] as const)
  test(`maker rebate uses conservative fractional-unit ${side} floor rounding`, () => {
    const i = quoteInput();
    i.lighterMid = 10001n;
    i.funding.twaPremiumBp = side === "ASK" ? 100 : -100;
    i.funding.deltaHours = 0;
    i.lighterFunding = { hourlyFraction: 0, mean: 0, kappa: 0 };
    i.strategy.holdHours = 1;
    i.strategy.eta = 0;
    i.strategy.kPhi = 0;
    i.costs.makerFeeBp = -0.5;
    const d = computeQuotes(i).diagnostics;
    if (!d) throw Error("expected diagnostics");
    const factor = side === "ASK" ? 9992n : 10008n;
    const numerator = i.lighterMid * factor;
    expect(d.floor).toBe(
      side === "ASK" ? (numerator + 9999n) / 10000n : numerator / 10000n,
    );
  });
for (const fee of [NaN, Infinity, -Infinity])
  test(`invalid maker fee ${fee} cancels quotes`, () => {
    const i = quoteInput();
    i.costs.makerFeeBp = fee;
    expect(computeQuotes(i).reasons).toContain("invalid_input");
    expect(places(i)).toEqual([]);
  });
test("missing maker fee fails closed", () => {
  const i = quoteInput();
  delete (i.costs as Partial<QuoteInput["costs"]>).makerFeeBp;
  expect(computeQuotes(i).reasons).toContain("invalid_input");
});
