import { expect, test } from "bun:test";
import { reconcile } from "../../src/strategy/reconciler";
import { reconcileInput } from "./fixtures";

test("balanced positions noop", () =>
  expect(reconcile(reconcileInput())).toEqual({ type: "noop" }));
for (let mask = 0; mask < 7; mask++)
  test(`fail closed freshness matrix ${mask}`, () => {
    const i = reconcileInput();
    i.fresh = {
      af: (mask & 1) !== 0,
      lighter: (mask & 2) !== 0,
      hedges: (mask & 4) !== 0,
    };
    expect(reconcile(i).type).toBe("failClosed");
  });
for (const name of ["af", "lighter"] as const)
  test(`unknown ${name} position fails closed`, () => {
    const i = reconcileInput();
    i[name] = null;
    expect(reconcile(i)).toEqual({
      type: "failClosed",
      reason: "unknown_position",
    });
  });
test("unknown hedge outcome fails closed", () => {
  const i = reconcileInput();
  i.inFlight = [
    {
      marketId: "SOL",
      remainingSignedBase: { value: -10n, scale: 100n },
      known: false,
    },
  ];
  expect(reconcile(i)).toEqual({ type: "failClosed", reason: "unknown_hedge" });
});
for (const residual of [-2n, -1n, 0n, 1n, 2n])
  test(`within inclusive lot tolerance ${residual}`, () => {
    const i = reconcileInput();
    if (!i.af) throw Error();
    i.af.base.value += residual;
    expect(reconcile(i)).toEqual({ type: "noop" });
  });
for (const residual of [-3n, 3n, -10n, 10n])
  test(`outside tolerance ${residual} rounds hedge to L lot`, () => {
    const i = reconcileInput();
    if (!i.af) throw Error();
    i.af.base.value += residual;
    expect(reconcile(i)).toEqual({
      type: "hedge",
      delta: { value: -((residual / 2n) * 2n), scale: 100n },
    });
  });
test("known in-flight hedge prevents duplicate reconcile", () => {
  const i = reconcileInput();
  if (!i.lighter) throw Error();
  i.lighter.base.value = -90n;
  i.inFlight = [
    {
      marketId: "SOL",
      remainingSignedBase: { value: -10n, scale: 100n },
      known: true,
    },
  ];
  expect(reconcile(i)).toEqual({ type: "noop" });
});
test("partial in-flight only offsets its remainder", () => {
  const i = reconcileInput();
  if (!i.lighter) throw Error();
  i.lighter.base.value = -90n;
  i.inFlight = [
    {
      marketId: "SOL",
      remainingSignedBase: { value: -4n, scale: 100n },
      known: true,
    },
  ];
  expect(reconcile(i)).toEqual({
    type: "hedge",
    delta: { value: -6n, scale: 100n },
  });
});
test("different position scales reconcile without number conversion", () => {
  const i = reconcileInput();
  if (!i.lighter) throw Error();
  i.lighter.base = { value: -1000n, scale: 1000n };
  expect(reconcile(i)).toEqual({ type: "noop" });
});
test("non-decimal scales use exact LCM", () => {
  const i = reconcileInput();
  if (!i.af || !i.lighter) throw Error();
  i.af.base = { value: 1n, scale: 3n };
  i.lighter.base = { value: -2n, scale: 6n };
  expect(reconcile(i)).toEqual({ type: "noop" });
});
test("positions above safe integer remain exact", () => {
  const i = reconcileInput();
  if (!i.af || !i.lighter) throw Error();
  i.af.base.value = 9007199254740993123n;
  i.lighter.base.value = -9007199254740993113n;
  expect(reconcile(i)).toEqual({
    type: "hedge",
    delta: { value: -10n, scale: 100n },
  });
});
test("mismatched markets fail closed", () => {
  const i = reconcileInput();
  if (!i.lighter) throw Error();
  i.lighter.marketId = "ETH";
  expect(reconcile(i)).toEqual({
    type: "failClosed",
    reason: "market_mismatch",
  });
});
test("foreign in-flight market fails closed", () => {
  const i = reconcileInput();
  i.inFlight = [
    {
      marketId: "ETH",
      remainingSignedBase: { value: 1n, scale: 100n },
      known: true,
    },
  ];
  expect(reconcile(i)).toEqual({
    type: "failClosed",
    reason: "market_mismatch",
  });
});
for (const unit of ["afLot", "lighterLot"] as const)
  test(`invalid ${unit} fails closed`, () => {
    const i = reconcileInput();
    i[unit].value = 0n;
    expect(reconcile(i)).toEqual({
      type: "failClosed",
      reason: "invalid_units",
    });
  });
test("invalid scale fails closed", () => {
  const i = reconcileInput();
  if (!i.af) throw Error();
  i.af.base.scale = 0n;
  expect(reconcile(i)).toEqual({ type: "failClosed", reason: "invalid_units" });
});
test("reconciler never mutates inputs", () => {
  const i = reconcileInput();
  const copy = structuredClone(i);
  reconcile(i);
  expect(i).toEqual(copy);
});
