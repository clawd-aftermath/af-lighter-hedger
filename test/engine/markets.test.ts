import { expect, test } from "bun:test";
import { DEFAULT_MARKETS } from "../../src/config/defaults";
import { AF_SCALE } from "../../src/core/units";
import { convertExact, lcm, resolveMarkets } from "../../src/engine/markets";
import { afMarket, lighterMarket, required } from "./helpers";

for (const symbol of ["BTC", "ETH", "SOL", "SUI"])
  test(`${symbol} resolution and exact signed unit roundtrip`, () => {
    const config = required(DEFAULT_MARKETS.find((m) => m.symbol === symbol));
    const m = required(
      resolveMarkets([config], [afMarket(symbol)], [lighterMarket(symbol)])[0],
    );
    expect(m.af.baseSymbol).toBe(symbol);
    expect(m.jointStep % m.af.lotInt).toBe(0n);
    expect(m.toAf(m.toLighter(-m.jointStep * 7n))).toBe(-m.jointStep * 7n);
    expect(m.minimumAt(100n * AF_SCALE)).toBeGreaterThanOrEqual(100000000n);
  });
test("ambiguous AF and Lighter auto matches are refused", () => {
  const config = required(DEFAULT_MARKETS[2]);
  expect(() =>
    resolveMarkets(
      [config],
      [afMarket(), { ...afMarket(), id: "0xf" }],
      [lighterMarket()],
    ),
  ).toThrow("ambiguous");
  expect(() =>
    resolveMarkets(
      [config],
      [afMarket()],
      [lighterMarket(), { ...lighterMarket(), marketId: 9 }],
    ),
  ).toThrow("ambiguous");
});
test("explicit ids override auto ambiguity", () => {
  const config = {
    ...required(DEFAULT_MARKETS[2]),
    aftermath: { marketId: "0x3" },
    lighter: { marketId: 2 },
  };
  expect(
    resolveMarkets(
      [config],
      [afMarket(), { ...afMarket(), id: "0xf" }],
      [lighterMarket(), { ...lighterMarket(), marketId: 9 }],
    ),
  ).toHaveLength(1);
});
test("missing and inactive markets refuse", () => {
  expect(() =>
    resolveMarkets([required(DEFAULT_MARKETS[2])], [], [lighterMarket()]),
  ).toThrow("missing");
  expect(() =>
    resolveMarkets(
      [required(DEFAULT_MARKETS[2])],
      [afMarket()],
      [{ ...lighterMarket(), status: "inactive" }],
    ),
  ).toThrow("active");
});
test("joint step is lcm and conversion rejects lossy sizes", () => {
  const m = required(
    resolveMarkets(
      [required(DEFAULT_MARKETS[2])],
      [{ ...afMarket(), lotInt: 300000n }],
      [lighterMarket()],
    )[0],
  );
  expect(m.jointStep).toBe(3000000n);
  expect(() => m.toLighter(1n)).toThrow("Inexact");
  expect(lcm(6n, 10n)).toBe(30n);
});
test("sub-nanobase Lighter precision remains exact on AF grid", () => {
  const m = required(
    resolveMarkets(
      [required(DEFAULT_MARKETS[2])],
      [afMarket()],
      [{ ...lighterMarket(), sizeDecimals: 12 }],
    )[0],
  );
  expect(m.toLighter(1n)).toBe(1000n);
  expect(() => m.toAf(1n)).toThrow("Inexact");
  expect(convertExact(-2n, 1n, 10n)).toBe(-20n);
});
test("joint minimum includes base, quote and AF notional", () => {
  const m = required(
    resolveMarkets(
      [required(DEFAULT_MARKETS[2])],
      [{ ...afMarket(), minOrderUsd: 20 }],
      [{ ...lighterMarket(), minBaseAmount: "0.3" }],
    )[0],
  );
  expect(m.minNotional).toBe(20n * AF_SCALE);
  expect(m.minimumAt(100n * AF_SCALE)).toBe(300000000n);
});
