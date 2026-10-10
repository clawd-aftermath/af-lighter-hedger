import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  historyHourly,
  indicativeFunding,
  LighterFunding,
  normalizeFunding,
  percentHourly,
} from "../../../src/venues/lighter/funding";
import { market } from "./helpers";

test("BTC 0.0012 percent/h is 1.2e-5", () => {
  expect(percentHourly("0.0012")).toBeCloseTo(1.2e-5, 12);
});
test("BRENT -0.0477 percent/h is -4.77e-4", () => {
  expect(percentHourly("-0.0477")).toBeCloseTo(-4.77e-4, 12);
});
test("stats predicted and last are independent signed hourly percentages", () => {
  const f = normalizeFunding({
    marketId: 1,
    symbol: "BTC",
    currentFundingRate: "-0.0012",
    fundingRate: "0.0012",
    baseInterestRate: "0.0100",
  });
  expect(f.predictedHourly).toBeCloseTo(-1.2e-5, 12);
  expect(f.lastHourly).toBeCloseTo(1.2e-5, 12);
  expect(f.interestBaseline).toBeCloseTo(1.25e-5, 12);
  expect(f.indicative).toBe(false);
});
test("interest baseline falls back to market params", () => {
  expect(
    normalizeFunding({ marketId: 1, symbol: "BTC" }, market).interestBaseline,
  ).toBeCloseTo(1.25e-5, 12);
});
test("history long positive and short negative", () => {
  expect(
    historyHourly({
      timestamp: 1,
      rate: "0.0012",
      value: "1",
      direction: "long",
    }),
  ).toBeCloseTo(1.2e-5, 12);
  expect(
    historyHourly({
      timestamp: 1,
      rate: "0.0012",
      value: "1",
      direction: "short",
    }),
  ).toBeCloseTo(-1.2e-5, 12);
});
test("unsigned history rejects signed rate", () => {
  expect(() =>
    historyHourly({
      timestamp: 1,
      rate: "-0.01",
      value: "1",
      direction: "long",
    }),
  ).toThrow("unsigned");
});
test("cross-venue lighter decimal rate is indicative 8h divided by8", () => {
  const f = indicativeFunding({
    marketId: 1,
    exchange: "lighter",
    symbol: "BTC",
    rate: 0.000096,
  });
  expect(f.predictedHourly).toBeCloseTo(1.2e-5, 12);
  expect(f.indicative).toBe(true);
});
test("non-lighter cross venue rows refused", () => {
  expect(() =>
    indicativeFunding({
      marketId: 1,
      exchange: "binance",
      symbol: "BTC",
      rate: 0.01,
    }),
  ).toThrow("Lighter");
});
test("recorded history normalized without confusing payment value with rate", async () => {
  const d = JSON.parse(
    await readFile(
      new URL("../../fixtures/lighter/fundings.json", import.meta.url),
      "utf8",
    ),
  );
  for (const row of d.fundings) {
    expect(Math.abs(historyHourly(row))).toBeCloseTo(
      Number(row.rate) / 100,
      12,
    );
  }
});
test("latest history chosen by timestamp; missing funding is unknown", () => {
  const f = new LighterFunding();
  expect(f.get(1).predictedHourly).toBeNull();
  f.updateStats({ marketId: 1, symbol: "BTC", currentFundingRate: "0.0012" });
  f.updateHistory(1, [
    { timestamp: 2, rate: "0.0002", value: "0", direction: "short" },
    { timestamp: 1, rate: "0.0012", value: "0", direction: "long" },
  ]);
  expect(f.get(1).lastHourly).toBeCloseTo(-2e-6, 12);
  expect(f.get(1).predictedHourly).toBeCloseTo(1.2e-5, 12);
});
