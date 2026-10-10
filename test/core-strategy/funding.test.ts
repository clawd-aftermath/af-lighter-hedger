import { expect, test } from "bun:test";
import { carryBp, effectiveCarryBp } from "../../src/funding/carry";
import {
  afHourly,
  ema,
  fundingIntegral,
  integrateHistory,
  lighterHourlyFromPublished,
  lighterInterestBaselineHourly,
  predictAfHourly,
  relaxedTwa,
} from "../../src/funding/model";

test("AF identity with premium in USD and hourly fraction", () => {
  expect(afHourly(0.8, 100, 1, 8)).toBeCloseTo(0.001, 12);
});
test("dynamic rho 8 vs 168 yields 21x", () => {
  expect(afHourly(1, 100, 1, 8) / afHourly(1, 100, 1, 168)).toBeCloseTo(21, 12);
});
for (const rho of [8, 24, 168])
  test(`AF rho=${rho} is hours`, () => {
    expect(afHourly(2, 200, 0.5, rho)).toBeCloseTo(0.005 / rho, 14);
  });
test("AF negative premium gives negative rate", () =>
  expect(afHourly(-1, 100, 1, 8)).toBeLessThan(0));
test("zero premium gives zero rate", () =>
  expect(afHourly(0, 100, 1, 8)).toBe(0));
test("Lighter published positive sample converts percent to hourly fraction", () =>
  expect(lighterHourlyFromPublished(0.0012)).toBeCloseTo(0.000012, 14));
test("Lighter baseline diagnostic converts eight-hour percent to hourly fraction", () =>
  expect(lighterInterestBaselineHourly(0.01)).toBeCloseTo(0.0000125, 14));
test("Lighter published negative sample preserves sign and hourly units", () =>
  expect(lighterHourlyFromPublished(-0.0477)).toBeCloseTo(-0.000477, 14));
test("TWA at zero horizon is current", () =>
  expect(relaxedTwa(5, 2, 0, 1)).toBe(5));
test("TWA converges to outside premium", () =>
  expect(relaxedTwa(5, 2, 100, 1)).toBeCloseTo(2, 14));
test("TWA relaxation exact one time constant", () =>
  expect(relaxedTwa(5, 2, 1, 1)).toBeCloseTo(2 + 3 / Math.E, 14));
test("prediction composes relaxation and AF rate", () =>
  expect(
    predictAfHourly({
      twaNow: 5,
      outsidePremium: 2,
      deltaHours: 1,
      omegaHours: 1,
      index: 100,
      f: 1,
      rhoHours: 8,
    }),
  ).toBeCloseTo(afHourly(2 + 3 / Math.E, 100, 1, 8), 14));
test("EMA oldest-first history", () => expect(ema([1, 3, 5], 0.5)).toBe(3.5));
test("EMA alpha one uses latest", () => expect(ema([1, 3, 5], 1)).toBe(5));
test("injected history controls integral mean", () =>
  expect(
    integrateHistory({
      hourlyFraction: 0.1,
      history: [0.02, 0.04],
      alpha: 0.5,
      kappa: 1,
      holdHours: 4,
    }),
  ).toBeCloseTo(fundingIntegral(0.1, 0.03, 1, 4), 14));
test("OU zero horizon", () => expect(fundingIntegral(1, 2, 3, 0)).toBe(0));
test("OU kappa zero analytic limit", () =>
  expect(fundingIntegral(0.002, 0.001, 0, 8)).toBe(0.016));
test("OU kappa nearly zero avoids cancellation", () =>
  expect(fundingIntegral(0.002, 0.001, 1e-15, 8)).toBeCloseTo(0.016, 14));
test("OU infinite horizon slope approaches mean", () =>
  expect(fundingIntegral(0.002, 0.001, 2, 1e6) / 1e6).toBeCloseTo(0.001, 8));
test("OU finite correction at long horizon", () =>
  expect(fundingIntegral(3, 1, 2, 100)).toBeCloseTo(101, 12));
test("OU constant rate is linear", () =>
  expect(fundingIntegral(0.001, 0.001, 0.1, 8)).toBe(0.008));
const input = {
  af: { hourlyFraction: 0.001, mean: 0.001, kappa: 1 },
  lighter: { hourlyFraction: 0.0000125, mean: 0.0000125, kappa: 1 },
};
test("ASK carry: short AF receives, long L pays", () =>
  expect(carryBp("ASK", 8, input)).toBeCloseTo(79, 12));
test("BID carry flips both legs", () =>
  expect(carryBp("BID", 8, input)).toBeCloseTo(-79, 12));
test("carry zero horizon", () => expect(carryBp("ASK", 0, input)).toBe(0));
test("positive carry discounted with uncertainty", () =>
  expect(effectiveCarryBp(100, 0.2, 2, 0.0001, 4)).toBe(76));
for (const k of [0, -1, -100])
  test(`nonpositive carry ${k} is not discounted`, () =>
    expect(effectiveCarryBp(k, 1, 10, 1, 8)).toBe(k));
test("positive carry haircut can yield negative effective edge", () =>
  expect(effectiveCarryBp(1, 1, 1, 0.001, 1)).toBe(-10));
for (const [name, fn] of [
  ["index", () => afHourly(1, 0, 1, 8)],
  ["rho", () => afHourly(1, 1, 1, 0)],
  ["f", () => afHourly(1, 1, -1, 8)],
  ["NaN", () => afHourly(NaN, 1, 1, 8)],
  ["omega", () => relaxedTwa(1, 2, 1, 0)],
  ["delta", () => relaxedTwa(1, 2, -1, 1)],
  ["empty history", () => ema([], 0.5)],
  ["alpha", () => ema([1], 0)],
  ["kappa", () => fundingIntegral(1, 2, -1, 1)],
  ["hours", () => fundingIntegral(1, 2, 1, -1)],
  ["interest", () => lighterInterestBaselineHourly(Infinity)],
  ["eta", () => effectiveCarryBp(1, 2, 1, 1, 1)],
] as const)
  test(`invalid ${name} rejected`, () => expect(fn).toThrow());

test("Lighter published zero remains zero without an interest top-up", () =>
  expect(lighterHourlyFromPublished(0)).toBe(0));
for (const value of [NaN, Infinity, -Infinity])
  test(`Lighter invalid published rate ${value} rejected`, () =>
    expect(() => lighterHourlyFromPublished(value)).toThrow(
      "ratePercentPerHour",
    ));
test("carry uses published Lighter final rate without adding the baseline", () => {
  const rate = lighterHourlyFromPublished(0.0012);
  const model = {
    af: { hourlyFraction: 0, mean: 0, kappa: 0 },
    lighter: { hourlyFraction: rate, mean: rate, kappa: 0 },
  };
  expect(carryBp("ASK", 8, model)).toBeCloseTo(-0.96, 12);
  expect(carryBp("BID", 8, model)).toBeCloseTo(0.96, 12);
  expect(lighterInterestBaselineHourly(0.01)).toBeCloseTo(0.0000125, 14);
  expect(model.lighter.hourlyFraction).toBe(rate);
});
