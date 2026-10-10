import { expect, test } from "bun:test";
import { ema, lighterHourlyFromPublished } from "../../src/funding/model";
import { Breaker } from "../../src/risk/breaker";
import { evaluateGates } from "../../src/risk/gates";
import { evaluateLimits } from "../../src/risk/limits";
import { initialHedgerState, reduceHedge } from "../../src/strategy/hedger";
import { computeQuotes } from "../../src/strategy/quoter";
import { reconcile } from "../../src/strategy/reconciler";
import { configuredStrategy } from "../fixtures/config";
import { gateInput, hedgePolicy, quoteInput, reconcileInput } from "./fixtures";

test("paper quote -> AF fill -> hedge -> balanced positions without I/O", () => {
  const input = quoteInput();
  input.strategy = {
    ...input.strategy,
    ...configuredStrategy,
    sigmaPhi: 0,
  };
  input.funding.mean = ema([0.001, 0.001], 0.5);
  input.lighterFunding.hourlyFraction = lighterHourlyFromPublished(0.00125);
  input.gates = evaluateGates(gateInput());
  const quote = computeQuotes(input).batches.flatMap((b) => b.place)[0];
  if (!quote) throw Error("expected quote");
  const p = hedgePolicy();
  p.price = input.index;
  p.priceScale = input.book.priceScale;
  p.sizeScale = input.book.sizeScale;
  p.usdScale = input.usdScale;
  p.maxUnhedgedUsd = 10000n;
  const placed = reduceHedge(
    initialHedgerState("SOL"),
    {
      type: "af_fill",
      now: 1000,
      fill: {
        marketId: "SOL",
        txDigest: "tx",
        orderId: "1",
        side: quote.side,
        price: quote.price,
        size: quote.size,
        ts: 1000,
      },
    },
    p,
  );
  const hedge = placed.state.active?.intent;
  if (!hedge) throw Error("expected hedge");
  expect(hedge.side).toBe("BID");
  expect(placed.commands.map((c) => c.type)).toEqual([
    "persist_intent",
    "place_hedge",
  ]);
  const confirmed = reduceHedge(
    placed.state,
    {
      type: "hedge_confirmed",
      now: 1001,
      result: {
        clientOrderIndex: hedge.clientOrderIndex,
        status: "filled",
        filledSize: hedge.size,
      },
    },
    p,
  );
  expect(confirmed.state.unhedgedBase).toBe(0n);
  const r = reconcileInput();
  if (!r.af || !r.lighter) throw Error();
  r.af.base.value = -quote.size;
  r.lighter.base.value = hedge.size;
  expect(reconcile(r)).toEqual({ type: "noop" });
});

test("breaker latch feeds gate and cancels market quotes", () => {
  const breaker = new Breaker({ load: () => null, save: () => {} }, () => 1000);
  breaker.trip("hedge_failed_after_escalation");
  const i = quoteInput();
  i.ownOrders = [
    {
      marketId: "SOL",
      clientOrderId: "resting",
      side: "ASK",
      size: 50n,
      price: 10100n,
      reduceOnly: false,
    },
  ];
  i.gates = evaluateGates({
    ...gateInput(),
    breakerLatched: breaker.state.latched,
  });
  const p = computeQuotes(i);
  expect(p.reasons).toContain("breaker_latched");
  expect(p.batches.flatMap((b) => b.cancel)).toEqual(["resting"]);
  expect(p.batches.flatMap((b) => b.place)).toEqual([]);
});

test("global limit failure feeds quoter fail-closed plan", () => {
  const i = quoteInput();
  i.gates = evaluateLimits({
    marketNotional: 0n,
    pendingMarketNotional: 0n,
    maxMarketNotional: 50000n,
    totalNotional: 200000n,
    pendingTotalNotional: 1n,
    maxTotalNotional: 200000n,
    dailyPnl: 0n,
    dailyLossLimit: 10000n,
  });
  const p = computeQuotes(i);
  expect(p.reasons).toEqual(["global_notional"]);
  expect(p.batches.flatMap((b) => b.place)).toEqual([]);
});
