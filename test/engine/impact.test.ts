import { expect, test } from "bun:test";
import { Logger } from "../../src/core/logger";
import { AF_SCALE } from "../../src/core/units";
import { Engine } from "../../src/engine/engine";
import { quoteImpact } from "../../src/engine/impact";
import { book, fixture } from "./helpers";

const price = (n: number) => BigInt(Math.round(n * 1e9));
for (const [side, bid, ask, quotes, expected] of [
  ["ASK", 99, 103, [102, 101], 0],
  ["ASK", 99, 103, [104, 103], 100],
  ["BID", 97, 101, [98, 99], 0],
  ["BID", 97, 101, [96, 97], -100],
] as const)
  test(`${side} projected mid for quotes ${quotes}`, () => {
    const impact = quoteImpact(
      book(0, bid, ask),
      price(100),
      quotes.map((p) => ({ side, price: price(p), size: AF_SCALE })),
      3600000,
      8 * 3600000,
    );
    expect(impact.premiumBeforeBp).toBe(side === "ASK" ? 100 : -100);
    expect(impact.premiumAfterBp).toBe(expected);
    expect(impact.fundingAfterHourly).toBe(expected / 10000 / 8);
    expect(impact.restingOrders).toBe(2);
    expect(impact.index).toBe("100");
    expect(impact.outsideBestBid).toBe(String(bid));
    expect(impact.outsideBestAsk).toBe(String(ask));
  });

for (const side of ["ASK", "BID"] as const)
  test(`${side} quotes crossing or locking the opposite touch cannot rest`, () => {
    const impact = quoteImpact(
      book(0, 99, 101),
      price(100),
      [side === "ASK" ? 99 : 101, side === "ASK" ? 98 : 102].map((p) => ({
        side,
        price: price(p),
        size: AF_SCALE,
      })),
      3600000,
      8 * 3600000,
    );
    expect(impact.restingOrders).toBe(0);
    expect(impact.premiumAfterBp).toBe(0);
  });

for (const rhoHours of [8, 168])
  for (const direction of [-1, 1])
    test(`funding clips ${direction > 0 ? "+" : "-"}5% with rho=${rhoHours}h`, () => {
      const impact = quoteImpact(
        book(0, 99 + 10 * direction, 101 + 10 * direction),
        price(100),
        [],
        3600000,
        rhoHours * 3600000,
      );
      expect(impact.premiumBeforeBp).toBe(direction * 1000);
      expect(impact.fundingBeforeHourly).toBeCloseTo(
        (direction * 0.05) / rhoHours,
        12,
      );
      expect(impact.fundingAfterHourly).toBe(impact.fundingBeforeHourly);
    });

test("clip is applied separately before and after, with live frequency", () => {
  const impact = quoteImpact(
    book(0, 99, 121),
    price(100),
    [{ side: "ASK", price: price(103), size: AF_SCALE }],
    2 * 3600000,
    168 * 3600000,
  );
  expect(impact.premiumBeforeBp).toBe(1000);
  expect(impact.premiumAfterBp).toBe(100);
  expect(impact.fundingBeforeHourly).toBeCloseTo((0.05 * 2) / 168, 12);
  expect(impact.fundingAfterHourly).toBeCloseTo((0.01 * 2) / 168, 12);
});

test("missing outside side reports unavailable rather than an invented mid", () => {
  const outside = { ...book(0), asks: [] };
  expect(quoteImpact(outside, price(100), [], 3600000, 28800000)).toMatchObject(
    {
      outsideBestAsk: null,
      premiumBeforeBp: null,
      premiumAfterBp: null,
      fundingBeforeHourly: null,
      fundingAfterHourly: null,
    },
  );
});

test("decimal prices retain all nine digits", () => {
  expect(quoteImpact(book(0), 100000000001n, [], 3600000, 28800000).index).toBe(
    "100.000000001",
  );
});

for (const side of ["ASK", "BID"] as const)
  for (const budget of [0, 400])
    test(`${side} profit-floor flag accounts for compression budget=${budget}`, async () => {
      const f = fixture();
      f.config.risk.basisBandBp = 1000;
      f.config.strategy.compressionBudgetBp = budget;
      f.feeds.view("SOL").lighterBook =
        side === "ASK"
          ? book(f.clock.now(), 102, 104)
          : book(f.clock.now(), 96, 98);
      if (side === "BID") {
        f.feeds.view("SOL").afBook = book(f.clock.now(), 97, 101);
        f.feeds.view("SOL").af.premiumTwap = -1;
        f.feeds.view("SOL").af.estimatedFundingRate = -0.00125;
      }
      const events: Record<string, unknown>[] = [];
      const engine = new Engine({
        ...f.options,
        logger: new Logger({ write: (line) => events.push(JSON.parse(line)) }),
      });
      try {
        await engine.start(false);
        await engine.tick();
        const plan = events.find((e) => e.type === "quote_plan");
        expect(plan?.side).toBe(side);
        expect(plan?.restingOrders).toBe(1);
        expect(plan?.profitFloorLimited).toBe(budget === 0);
      } finally {
        await engine.shutdown();
        f.store.close();
      }
    });

test("quote_plan projects places and kept orders using the live rho", async () => {
  const f = fixture();
  const events: Record<string, unknown>[] = [];
  const engine = new Engine({
    ...f.options,
    logger: new Logger({
      now: () => new Date(f.clock.now()),
      write: (line) => events.push(JSON.parse(line)),
    }),
  });
  try {
    await engine.start(false);
    await engine.tick();
    const first = events.find((e) => e.type === "quote_plan");
    expect(first).toMatchObject({
      index: "100",
      outsideBestBid: "99",
      outsideBestAsk: "103",
      premiumBeforeBp: 100,
      restingOrders: 1,
      side: "ASK",
    });
    const order = f.af.orders[0];
    if (!order) throw new Error("Missing planned quote");
    expect(first?.premiumAfterBp).toBeCloseTo(
      ((Number(order.price) / 1e9 + 99 - 200) / 200) * 10000,
      7,
    );
    // Fake venue doesn't include our orders in its feed: tag and add them explicitly.
    f.feeds.view("SOL").afBook.asks = [
      {
        price: order.price,
        size: order.size,
        clientOrderId: order.clientOrderId,
      },
      ...f.feeds.view("SOL").afBook.asks,
    ];
    f.clock.advance(1000);
    f.feeds.fresh();
    await engine.tick();
    const last = events.filter((e) => e.type === "quote_plan").at(-1);
    expect(last?.ordersToKeep).toBe(1);
    expect(last?.ordersToPlace).toBe(0);
    expect(last?.premiumAfterBp).toBe(first?.premiumAfterBp);
    expect(last?.fundingAfterHourly).toBe(first?.fundingAfterHourly);
    f.feeds.view("SOL").af.fundingPeriodMs = 168 * 3600000;
    f.clock.advance(1000);
    f.feeds.fresh();
    await engine.tick();
    const changed = events.filter((e) => e.type === "quote_plan").at(-1);
    expect(changed?.fundingBeforeHourly).toBeCloseTo(0.01 / 168, 12);
    expect(changed?.fundingAfterHourly).toBeCloseTo(
      Number(changed?.premiumAfterBp) / 10000 / 168,
      12,
    );
  } finally {
    await engine.shutdown();
    f.store.close();
  }
});
