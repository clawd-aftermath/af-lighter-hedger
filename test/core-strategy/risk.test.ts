import { expect, test } from "bun:test";
import {
  Breaker,
  type BreakerState,
  type BreakerStore,
} from "../../src/risk/breaker";
import {
  evaluateGates,
  failedReasons,
  type GateInput,
  type GateReason,
} from "../../src/risk/gates";
import {
  evaluateLimits,
  marginCapacity,
  oiCapacity,
} from "../../src/risk/limits";
import { gateInput } from "./fixtures";

test("all gates open on healthy input", () =>
  expect(failedReasons(evaluateGates(gateInput()))).toEqual([]));
const failures: [GateReason, Partial<GateInput>][] = [
  ["stale_af_book", { afBookTs: 949 }],
  ["stale_af_oracle", { afOracleTs: 949 }],
  ["stale_lighter_book", { lighterBookTs: 949 }],
  ["basis_band", { basisBp: 11 }],
  ["basis_band", { basisBp: -11 }],
  ["funding_sign_flip", { inventory: 1n, predictedAfHourly: 0.001 }],
  ["funding_sign_flip", { inventory: -1n, predictedAfHourly: -0.001 }],
  ["session_closed", { sessionOpen: false }],
  ["margin_headroom", { marginHeadroomPct: 19.9 }],
  ["unhedged_notional", { unhedgedUsd: 101n, unhedgedSince: 1000 }],
  ["unhedged_age", { unhedgedUsd: 1n, unhedgedSince: 899 }],
  ["unhedged_age", { unhedgedUsd: 1n }],
  ["oi_headroom", { oiHeadroom: 0n }],
  ["breaker_latched", { breakerLatched: true }],
  ["invalid_input", { basisBp: NaN }],
  ["stale_af_book", { afBookTs: 1001 }],
];
for (const [n, [reason, override]] of failures.entries())
  test(`gate ${n} returns typed ${reason}`, () =>
    expect(
      failedReasons(evaluateGates({ ...gateInput(), ...override })),
    ).toContain(reason));
for (const [name, override] of [
  [
    "freshness exact edge",
    { afBookTs: 950, afOracleTs: 950, lighterBookTs: 950 },
  ],
  ["basis exact edge", { basisBp: 10 }],
  ["margin exact edge", { marginHeadroomPct: 20 }],
  ["unhedged caps exact edge", { unhedgedUsd: 100n, unhedgedSince: 900 }],
  ["receiving short inventory", { inventory: -1n }],
  ["receiving long inventory", { inventory: 1n, predictedAfHourly: -0.001 }],
  [
    "session explicitly allowed",
    { sessionOpen: false, pauseWhenSessionClosed: false },
  ],
] as [string, Partial<GateInput>][])
  test(`gate allows ${name}`, () =>
    expect(
      failedReasons(evaluateGates({ ...gateInput(), ...override })),
    ).toEqual([]));
test("basis gate compares to EMA rather than zero", () =>
  expect(
    failedReasons(
      evaluateGates({ ...gateInput(), basisBp: 100, basisEmaBp: 100 }),
    ),
  ).toEqual([]));
const limitInput = {
  marketNotional: 50n,
  pendingMarketNotional: 10n,
  maxMarketNotional: 100n,
  totalNotional: 100n,
  pendingTotalNotional: 10n,
  maxTotalNotional: 200n,
  dailyPnl: -1n,
  dailyLossLimit: 10n,
};
test("notional limits include pending orders", () =>
  expect(
    failedReasons(
      evaluateLimits({ ...limitInput, pendingMarketNotional: 51n }),
    ),
  ).toEqual(["market_notional"]));
test("global notional aggregates pending", () =>
  expect(
    failedReasons(
      evaluateLimits({ ...limitInput, pendingTotalNotional: 101n }),
    ),
  ).toEqual(["global_notional"]));
test("daily loss limit trips at equality", () =>
  expect(
    failedReasons(evaluateLimits({ ...limitInput, dailyPnl: -10n })),
  ).toEqual(["daily_loss"]));
test("daily profit is allowed", () =>
  expect(
    failedReasons(evaluateLimits({ ...limitInput, dailyPnl: 100n })),
  ).toEqual([]));
test("notional equality is allowed", () =>
  expect(
    failedReasons(
      evaluateLimits({
        ...limitInput,
        marketNotional: 90n,
        totalNotional: 190n,
      }),
    ),
  ).toEqual([]));
test("negative limit values fail closed", () =>
  expect(
    failedReasons(evaluateLimits({ ...limitInput, maxMarketNotional: -1n })),
  ).toEqual(["invalid_input"]));
test("OI below threshold has no half-OI rule", () =>
  expect(
    oiCapacity({
      openInterest: 100n,
      maxOpenInterest: 1000n,
      position: 400n,
      pendingIncrease: 0n,
      halfOiThreshold: 100n,
    }),
  ).toBe(900n));
test("OI above threshold limits position to half OI", () =>
  expect(
    oiCapacity({
      openInterest: 102n,
      maxOpenInterest: 1000n,
      position: -40n,
      pendingIncrease: 5n,
      halfOiThreshold: 100n,
    }),
  ).toBe(6n));
test("OI total cap includes pending", () =>
  expect(
    oiCapacity({
      openInterest: 90n,
      maxOpenInterest: 100n,
      position: 0n,
      pendingIncrease: 6n,
      halfOiThreshold: 100n,
    }),
  ).toBe(4n));
test("OI already beyond cap has zero capacity", () =>
  expect(
    oiCapacity({
      openInterest: 101n,
      maxOpenInterest: 100n,
      position: 0n,
      pendingIncrease: 0n,
      halfOiThreshold: 100n,
    }),
  ).toBe(0n));
test("margin pending reservation clipped at zero", () =>
  expect(marginCapacity(5n, 6n)).toBe(0n));
test("invalid OI values rejected", () =>
  expect(() =>
    oiCapacity({
      openInterest: -1n,
      maxOpenInterest: 100n,
      position: 0n,
      pendingIncrease: 0n,
      halfOiThreshold: 100n,
    }),
  ).toThrow());
function store(initial: BreakerState | null = null): BreakerStore {
  let data = initial;
  return {
    load: () => data,
    save: (s) => {
      data = structuredClone(s);
    },
  };
}
test("breaker starts unlatched", () =>
  expect(new Breaker(store(), () => 100).state.latched).toBe(false));
test("breaker latches and deduplicates reasons", () => {
  const b = new Breaker(store(), () => 100);
  b.trip("a");
  b.trip("a");
  b.trip("b");
  expect(b.state).toEqual({
    latched: true,
    reasons: ["a", "b"],
    trippedAt: 100,
  });
});
test("breaker persists and restores across controller instances", () => {
  const s = store();
  new Breaker(s, () => 100).trip("a");
  expect(new Breaker(s, () => 200).state).toEqual({
    latched: true,
    reasons: ["a"],
    trippedAt: 100,
  });
});
test("breaker no automatic reset", () => {
  const b = new Breaker(store(), () => 100);
  b.trip("a");
  expect(b.state.latched).toBe(true);
  expect(b.state.latched).toBe(true);
});
test("breaker reset requires explicit acknowledgement", () => {
  const b = new Breaker(store(), () => 100);
  b.trip("a");
  expect(() =>
    b.reset({ acknowledged: false as true, note: "test" }),
  ).toThrow();
  expect(b.state.latched).toBe(true);
});
test("breaker reset requires meaningful note", () => {
  const b = new Breaker(store(), () => 100);
  b.trip("a");
  expect(() => b.reset({ acknowledged: true, note: " " })).toThrow();
});
test("breaker reset persists and clears latch", () => {
  const s = store();
  const b = new Breaker(s, () => 100);
  b.trip("a");
  b.reset({ acknowledged: true, note: "resolved" });
  expect(new Breaker(s, () => 100).state.latched).toBe(false);
});
test("breaker state snapshots cannot mutate latch", () => {
  const b = new Breaker(store(), () => 100);
  const copy = b.state;
  copy.latched = true;
  expect(b.state.latched).toBe(false);
});
test("breaker trip fails locally closed if store throws", () => {
  const b = new Breaker(
    {
      load: () => null,
      save: () => {
        throw Error("disk");
      },
    },
    () => 100,
  );
  expect(() => b.trip("a")).toThrow("disk");
  expect(b.state.latched).toBe(true);
});
test("breaker failed reset leaves latch set", () => {
  let writes = 0;
  const b = new Breaker(
    {
      load: () => null,
      save: () => {
        if (++writes > 1) throw Error("disk");
      },
    },
    () => 100,
  );
  b.trip("a");
  expect(() => b.reset({ acknowledged: true, note: "fixed" })).toThrow();
  expect(b.state.latched).toBe(true);
});
