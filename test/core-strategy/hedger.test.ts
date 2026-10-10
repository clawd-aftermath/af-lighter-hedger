import { expect, test } from "bun:test";
import type { Fill } from "../../src/domain/types";
import {
  type HedgeEvent,
  type HedgerState,
  initialHedgerState,
  reduceHedge,
} from "../../src/strategy/hedger";
import { hedgePolicy } from "./fixtures";

function fill(
  size = 10n,
  side: Fill["side"] = "BID",
  orderId = "o1",
  txDigest = "tx1",
  now = 10,
): HedgeEvent {
  return {
    type: "af_fill",
    now,
    fill: {
      marketId: "SOL",
      txDigest,
      orderId,
      side,
      size,
      price: 1n,
      ts: now,
    },
  };
}
function start(): HedgerState {
  return reduceHedge(initialHedgerState("SOL"), fill(), hedgePolicy()).state;
}
function confirm(
  state: HedgerState,
  status: "filled" | "partial" | "canceled" | "failed",
  size: bigint,
  now = 20,
  terminal?: boolean,
) {
  const id = state.active?.intent.clientOrderIndex;
  if (id === undefined) throw Error("missing active");
  return reduceHedge(
    state,
    {
      type: "hedge_confirmed",
      result: { clientOrderIndex: id, status, filledSize: size },
      now,
      terminal,
    },
    hedgePolicy(),
  );
}

test("AF buy fill hedges with sell and persists intent BEFORE send", () => {
  const r = reduceHedge(initialHedgerState("SOL"), fill(), hedgePolicy());
  expect(r.commands.map((c) => c.type)).toEqual([
    "persist_intent",
    "place_hedge",
  ]);
  expect(r.state.active?.intent).toEqual({
    marketId: "SOL",
    clientOrderIndex: 1n,
    side: "ASK",
    size: 10n,
    slippageBps: 50,
  });
  expect(r.state.nextClientOrderIndex).toBe(2n);
});
test("AF sell fill hedges with buy", () => {
  const r = reduceHedge(
    initialHedgerState("SOL"),
    fill(10n, "ASK"),
    hedgePolicy(),
  );
  expect(r.state.active?.intent.side).toBe("BID");
  expect(r.state.unhedgedBase).toBe(-10n);
});
test("duplicate AF fill never double hedges", () => {
  const s = start();
  const r = reduceHedge(s, fill(), hedgePolicy());
  expect(r.state).toEqual(s);
  expect(r.commands).toEqual([]);
});
test("same order in different transaction is a new fill", () => {
  const s = start();
  const r = reduceHedge(s, fill(5n, "BID", "o1", "tx2", 11), hedgePolicy());
  expect(r.state.unhedgedBase).toBe(15n);
  expect(r.commands).toEqual([]);
});
test("different order in same transaction is a new fill", () => {
  const r = reduceHedge(
    start(),
    fill(5n, "BID", "o2", "tx1", 11),
    hedgePolicy(),
  );
  expect(r.state.unhedgedBase).toBe(15n);
});
test("structured idempotency keys avoid concatenation collisions", () => {
  const p = hedgePolicy();
  p.minSize = 100n;
  const a = reduceHedge(
    initialHedgerState("SOL"),
    fill(2n, "BID", "b:c", "a"),
    p,
  );
  const b = reduceHedge(a.state, fill(2n, "BID", "c", "a:b"), p);
  expect(b.state.unhedgedBase).toBe(4n);
  expect(b.state.seenFills).toHaveLength(2);
});
test("duplicate fill after confirmed hedge stays idempotent", () => {
  const s = confirm(start(), "filled", 10n).state;
  expect(
    reduceHedge(s, fill(10n, "BID", "o1", "tx1", 30), hedgePolicy()).commands,
  ).toEqual([]);
});
test("accepted event tracks order without resending", () => {
  const s = start();
  const r = reduceHedge(
    s,
    { type: "hedge_accepted", clientOrderIndex: 1n, now: 15 },
    hedgePolicy(),
  );
  expect(r.state.active?.status).toBe("accepted");
  expect(r.commands).toEqual([]);
});
test("confirmed full hedge clears residual", () => {
  const r = confirm(start(), "filled", 10n);
  expect(r.state.unhedgedBase).toBe(0n);
  expect(r.state.active).toBeNull();
  expect(r.state.unhedgedSince).toBeNull();
  expect(r.commands).toEqual([]);
});
test("partial hedge applies cumulative fills once and reserves remaining", () => {
  const r = confirm(start(), "partial", 4n);
  expect(r.state.unhedgedBase).toBe(6n);
  expect(r.state.active?.filledSize).toBe(4n);
  expect(r.commands).toEqual([]);
  const again = confirm(r.state, "partial", 4n, 21);
  expect(again.state.unhedgedBase).toBe(6n);
  expect(again.commands).toEqual([]);
});
test("later cumulative confirmation subtracts only incremental size", () => {
  const s = confirm(start(), "partial", 4n).state;
  const r = confirm(s, "filled", 10n);
  expect(r.state.unhedgedBase).toBe(0n);
});
test("terminal partial rehedges remaining size with emergency slippage", () => {
  const r = confirm(start(), "partial", 4n, 20, true);
  expect(r.state.active?.intent.size).toBe(6n);
  expect(r.state.active?.intent.clientOrderIndex).toBe(2n);
  expect(r.state.active?.intent.slippageBps).toBe(100);
  expect(r.commands[0]?.type).toBe("escalate_slippage");
});
test("subminimum residual accumulates without sending", () => {
  const r = reduceHedge(initialHedgerState("SOL"), fill(2n), hedgePolicy());
  expect(r.state.unhedgedBase).toBe(2n);
  expect(r.commands).toEqual([]);
});
test("accumulated residual sends exactly once when minimum reached", () => {
  const s = reduceHedge(
    initialHedgerState("SOL"),
    fill(2n),
    hedgePolicy(),
  ).state;
  const r = reduceHedge(s, fill(3n, "BID", "o2", "tx2", 15), hedgePolicy());
  expect(r.state.active?.intent.size).toBe(5n);
  expect(r.commands.map((c) => c.type)).toEqual([
    "persist_intent",
    "place_hedge",
  ]);
  expect(r.state.unhedgedSince).toBe(15);
});
test("opposite residuals net out without hedging", () => {
  const s = reduceHedge(
    initialHedgerState("SOL"),
    fill(2n),
    hedgePolicy(),
  ).state;
  const r = reduceHedge(s, fill(2n, "ASK", "o2", "tx2", 15), hedgePolicy());
  expect(r.state.unhedgedBase).toBe(0n);
  expect(r.state.unhedgedSince).toBeNull();
  expect(r.commands).toEqual([]);
});
test("size rounds to lot and preserves dust", () => {
  const p = hedgePolicy();
  p.lot = 3n;
  const r = reduceHedge(initialHedgerState("SOL"), fill(), p);
  expect(r.state.active?.intent.size).toBe(9n);
  const completed = reduceHedge(
    r.state,
    {
      type: "hedge_confirmed",
      result: { clientOrderIndex: 1n, status: "filled", filledSize: 9n },
      now: 20,
    },
    p,
  );
  expect(completed.state.unhedgedBase).toBe(1n);
  expect(completed.commands).toEqual([]);
});
test("min notional is distinct from min size", () => {
  const p = hedgePolicy();
  p.minNotional = 20n;
  const r = reduceHedge(initialHedgerState("SOL"), fill(), p);
  expect(r.commands).toEqual([]);
});
test("fill during hedge accumulates then next intent uses fresh index", () => {
  const s = reduceHedge(
    start(),
    fill(7n, "BID", "o2", "tx2", 15),
    hedgePolicy(),
  ).state;
  const r = confirm(s, "filled", 10n);
  expect(r.state.unhedgedBase).toBe(7n);
  expect(r.state.active?.intent.clientOrderIndex).toBe(2n);
  expect(r.state.active?.intent.size).toBe(7n);
});
test("unknown outcome emits resolution and never resends", () => {
  const r = reduceHedge(
    start(),
    { type: "unknown_outcome", clientOrderIndex: 1n, now: 20 },
    hedgePolicy(),
  );
  expect(r.commands.map((c) => c.type)).toEqual(["resolve_unknown"]);
  expect(r.state.active?.status).toBe("unknown");
  const tick = reduceHedge(
    r.state,
    { type: "timeout_tick", now: 500 },
    hedgePolicy(),
  );
  expect(tick.commands).toEqual([]);
  expect(tick.state.active?.intent.clientOrderIndex).toBe(1n);
});
test("new fill during unknown outcome cannot cause another send", () => {
  const s = reduceHedge(
    start(),
    { type: "unknown_outcome", clientOrderIndex: 1n, now: 20 },
    hedgePolicy(),
  ).state;
  const r = reduceHedge(s, fill(10n, "BID", "o2", "tx2", 30), hedgePolicy());
  expect(r.commands).toEqual([]);
  expect(r.state.unhedgedBase).toBe(20n);
});
test("unknown resolved as filled clears active without reissue", () => {
  const s = reduceHedge(
    start(),
    { type: "unknown_outcome", clientOrderIndex: 1n, now: 20 },
    hedgePolicy(),
  ).state;
  const r = confirm(s, "filled", 10n, 30);
  expect(r.commands).toEqual([]);
  expect(r.state.active).toBeNull();
});
test("unknown resolved as canceled can escalate and reissue", () => {
  const s = reduceHedge(
    start(),
    { type: "unknown_outcome", clientOrderIndex: 1n, now: 20 },
    hedgePolicy(),
  ).state;
  const r = confirm(s, "canceled", 0n, 30);
  expect(r.state.active?.intent.clientOrderIndex).toBe(2n);
  expect(r.commands.map((c) => c.type)).toEqual([
    "escalate_slippage",
    "persist_intent",
    "place_hedge",
  ]);
});
test("timeout enters unknown rather than blindly retrying", () => {
  const r = reduceHedge(
    start(),
    { type: "timeout_tick", now: 110 },
    hedgePolicy(),
  );
  expect(r.commands.map((c) => c.type)).toEqual(["resolve_unknown"]);
});
test("before timeout no commands", () =>
  expect(
    reduceHedge(start(), { type: "timeout_tick", now: 109 }, hedgePolicy())
      .commands,
  ).toEqual([]));
test("slippage escalates once then breaker on definite second failure", () => {
  const first = confirm(start(), "failed", 0n);
  const second = confirm(first.state, "failed", 0n, 30);
  expect(
    first.commands.filter((c) => c.type === "escalate_slippage"),
  ).toHaveLength(1);
  expect(second.state.latched).toBe(true);
  expect(second.commands.map((c) => c.type)).toEqual([
    "pull_quotes",
    "trip_breaker",
  ]);
  expect(second.state.active).toBeNull();
});
test("successful escalation resets retry budget for future exposure", () => {
  const s = confirm(
    confirm(start(), "failed", 0n).state,
    "filled",
    10n,
    30,
  ).state;
  expect(s.escalated).toBe(false);
  const r = reduceHedge(s, fill(10n, "BID", "o2", "tx2", 40), hedgePolicy());
  expect(r.state.active?.intent.slippageBps).toBe(50);
});
test("unhedged USD breach pulls quotes and trips while immediately hedging", () => {
  const r = reduceHedge(initialHedgerState("SOL"), fill(101n), hedgePolicy());
  expect(r.commands.map((c) => c.type)).toEqual([
    "pull_quotes",
    "trip_breaker",
    "persist_intent",
    "place_hedge",
  ]);
  expect(r.state.latched).toBe(true);
});
test("partial AF fill dust never trips unhedged age or USD caps", () => {
  const p = { ...hedgePolicy(), maxUnhedgedUsd: 1n };
  const s = reduceHedge(initialHedgerState("SOL"), fill(2n), p).state;
  const r = reduceHedge(s, { type: "timeout_tick", now: 1011 }, p);
  expect(r.commands).toEqual([]);
  expect(r.state.hedgeableBase).toBe(0n);
  expect(r.state.dustBase).toBe(2n);
  expect(r.state.unhedgedSince).toBeNull();
  expect(r.state.latched).toBe(false);
});
test("aged dust crossing the minimum hedges and starts a fresh age", () => {
  const p = hedgePolicy();
  const s = reduceHedge(initialHedgerState("SOL"), fill(2n), p).state;
  const aged = reduceHedge(s, { type: "timeout_tick", now: 1011 }, p).state;
  const r = reduceHedge(aged, fill(4n, "BID", "o2", "tx2", 1020), p);
  expect(r.state.active?.intent.size).toBe(6n);
  expect(r.state.hedgeableBase).toBe(6n);
  expect(r.state.dustBase).toBe(0n);
  expect(r.state.unhedgedSince).toBe(1020);
  expect(r.state.latched).toBe(false);
  expect(r.commands.map((c) => c.type)).toEqual([
    "persist_intent",
    "place_hedge",
  ]);
});
test("unknown can eventually trip age cap without resend", () => {
  const s = reduceHedge(
    start(),
    { type: "unknown_outcome", clientOrderIndex: 1n, now: 20 },
    hedgePolicy(),
  ).state;
  const r = reduceHedge(s, { type: "timeout_tick", now: 1011 }, hedgePolicy());
  expect(r.commands.map((c) => c.type)).toEqual([
    "pull_quotes",
    "trip_breaker",
  ]);
  expect(r.state.active?.intent.clientOrderIndex).toBe(1n);
});
test("caps are inclusive at equality", () => {
  const p = hedgePolicy();
  const r = reduceHedge(initialHedgerState("SOL"), fill(100n), p);
  expect(r.state.latched).toBe(false);
  expect(
    reduceHedge(r.state, { type: "timeout_tick", now: 1010 }, p).state.latched,
  ).toBe(false);
});
test("unmatched confirmations ignored", () => {
  const s = start();
  expect(
    reduceHedge(
      s,
      {
        type: "hedge_confirmed",
        result: { clientOrderIndex: 5n, status: "filled", filledSize: 10n },
        now: 20,
      },
      hedgePolicy(),
    ).state,
  ).toEqual(s);
});
test("decreasing cumulative filled size trips", () => {
  const s = confirm(start(), "partial", 4n).state;
  expect(confirm(s, "partial", 3n, 30).state.latched).toBe(true);
});
test("overfilled hedge trips", () =>
  expect(confirm(start(), "filled", 11n).state.latched).toBe(true));
test("filled status with missing size trips", () =>
  expect(confirm(start(), "filled", 9n).state.latched).toBe(true));
test("foreign market fill ignored", () => {
  const e = fill();
  if (e.type !== "af_fill") throw Error();
  e.fill.marketId = "ETH";
  expect(
    reduceHedge(initialHedgerState("SOL"), e, hedgePolicy()).commands,
  ).toEqual([]);
});
test("invalid allocator cannot reuse order index", () => {
  const p = hedgePolicy();
  p.allocate = (next) => ({ clientOrderIndex: next, next });
  const r = reduceHedge(initialHedgerState("SOL"), fill(), p);
  expect(r.commands.map((c) => c.type)).toEqual([
    "pull_quotes",
    "trip_breaker",
  ]);
});
test("backward clock fails closed", () =>
  expect(
    reduceHedge(start(), { type: "timeout_tick", now: 0 }, hedgePolicy()).state
      .latched,
  ).toBe(true));
test("invalid slippage fails closed", () => {
  const p = hedgePolicy();
  p.emergencySlippageBps = 401;
  expect(reduceHedge(initialHedgerState("SOL"), fill(), p).state.latched).toBe(
    true,
  );
});
test("state and event remain immutable", () => {
  const s = start();
  const e: HedgeEvent = {
    type: "hedge_confirmed",
    result: { clientOrderIndex: 1n, status: "partial", filledSize: 5n },
    now: 20,
  };
  const snapshot = structuredClone(s);
  reduceHedge(s, e, hedgePolicy());
  expect(s).toEqual(snapshot);
  expect(e.result.filledSize).toBe(5n);
});
test("pure allocation makes replay deterministic", () => {
  const s = initialHedgerState("SOL");
  const e = fill();
  expect(reduceHedge(s, e, hedgePolicy())).toEqual(
    reduceHedge(s, e, hedgePolicy()),
  );
});

test("hedge confirmation restarts age when offsetting AF fills previously netted to zero", () => {
  const s = reduceHedge(
    start(),
    fill(10n, "ASK", "o2", "tx2", 15),
    hedgePolicy(),
  ).state;
  expect(s.unhedgedBase).toBe(0n);
  expect(s.unhedgedSince).toBeNull();
  const r = confirm(s, "filled", 10n, 30);
  expect(r.state.unhedgedBase).toBe(-10n);
  expect(r.state.unhedgedSince).toBe(30);
  expect(r.state.active?.intent.side).toBe("BID");
});
test("canceled but fully filled order does not escalate for new AF exposure", () => {
  const s = reduceHedge(
    start(),
    fill(10n, "BID", "o2", "tx2", 15),
    hedgePolicy(),
  ).state;
  const r = confirm(s, "canceled", 10n, 30);
  expect(r.state.active?.intent.slippageBps).toBe(50);
  expect(r.commands.some((c) => c.type === "escalate_slippage")).toBe(false);
});

test("replayed duplicate retains idempotency even with original older event time", () => {
  const s = confirm(start(), "filled", 10n, 20).state;
  const r = reduceHedge(s, fill(), hedgePolicy());
  expect(r.state).toEqual(s);
  expect(r.commands).toEqual([]);
  expect(r.state.latched).toBe(false);
});

test("emergency failures keep retrying with fresh indices, backoff and one alert per retry", () => {
  const p = hedgePolicy();
  const first = confirm(start(), "failed", 0n, 20);
  const failed = confirm(first.state, "failed", 0n, 30);
  expect(failed.state.latched).toBe(true);
  expect(failed.state.halted).toBe(false);
  expect(failed.state.retryAt).toBe(2030);
  expect(failed.commands.map((c) => c.type)).toEqual([
    "pull_quotes",
    "trip_breaker",
  ]);
  const early = reduceHedge(
    failed.state,
    { type: "timeout_tick", now: 2029 },
    p,
  );
  expect(early.commands).toEqual([]);
  const retry = reduceHedge(
    early.state,
    { type: "timeout_tick", now: 2030 },
    p,
  );
  expect(retry.commands.map((c) => c.type)).toEqual([
    "alert",
    "persist_intent",
    "place_hedge",
  ]);
  expect(retry.commands[0]).toEqual({
    type: "alert",
    severity: "error",
    reason: "hedge_failed_after_escalation",
  });
  expect(retry.state.active?.intent).toEqual({
    marketId: "SOL",
    clientOrderIndex: 3n,
    side: "ASK",
    size: 10n,
    slippageBps: 100,
  });
  expect(retry.state.retryAt).toBeNull();
  const failedAgain = confirm(retry.state, "failed", 0n, 2040);
  expect(failedAgain.commands).toEqual([]);
  expect(failedAgain.state.retryAt).toBe(4040);
  const again = reduceHedge(
    failedAgain.state,
    { type: "timeout_tick", now: 4040 },
    p,
  );
  expect(again.commands.map((c) => c.type)).toEqual([
    "alert",
    "persist_intent",
    "place_hedge",
  ]);
  expect(again.state.active?.intent.clientOrderIndex).toBe(4n);
  expect(again.state.active?.intent.slippageBps).toBe(100);
});
test("explicit retryBackoffMs overrides the default", () => {
  const p = hedgePolicy();
  p.retryBackoffMs = 250;
  const s = confirm(start(), "failed", 0n, 20).state;
  const failed = reduceHedge(
    s,
    {
      type: "hedge_confirmed",
      now: 30,
      result: { clientOrderIndex: 2n, status: "failed", filledSize: 0n },
    },
    p,
  );
  expect(failed.state.retryAt).toBe(280);
  expect(
    reduceHedge(failed.state, { type: "timeout_tick", now: 279 }, p).commands,
  ).toEqual([]);
  expect(
    reduceHedge(
      failed.state,
      { type: "timeout_tick", now: 280 },
      p,
    ).commands.some((c) => c.type === "place_hedge"),
  ).toBe(true);
});
for (const side of ["BID", "ASK"] as const)
  test(`quoting latch does not change sizing or hedge side for AF ${side} fill`, () => {
    const s = initialHedgerState("SOL");
    const e = fill(10n, side);
    const normal = reduceHedge(s, e, hedgePolicy());
    const latched = reduceHedge({ ...s, latched: true }, e, hedgePolicy());
    expect(latched.state.active?.intent).toEqual(normal.state.active?.intent);
    expect(latched.commands).toEqual(normal.commands);
    expect(latched.state.halted).toBe(false);
  });
test("age-breached delayed fill immediately hedges without halting", () => {
  const e = fill();
  e.now = 1011;
  const r = reduceHedge(initialHedgerState("SOL"), e, hedgePolicy());
  expect(r.commands.map((c) => c.type)).toEqual([
    "pull_quotes",
    "trip_breaker",
    "persist_intent",
    "place_hedge",
  ]);
  expect(r.state.halted).toBe(false);
  expect(r.state.active?.intent.size).toBe(10n);
});
test("subminimum dust can accumulate and hedge while quoting is already latched", () => {
  const s = reduceHedge(
    { ...initialHedgerState("SOL"), latched: true },
    fill(2n),
    hedgePolicy(),
  ).state;
  const latched = reduceHedge(
    s,
    { type: "timeout_tick", now: 1011 },
    hedgePolicy(),
  );
  const r = reduceHedge(
    latched.state,
    fill(3n, "BID", "o2", "tx2", 1012),
    hedgePolicy(),
  );
  expect(r.commands.map((c) => c.type)).toEqual([
    "persist_intent",
    "place_hedge",
  ]);
  expect(r.state.active?.intent.size).toBe(5n);
  expect(r.state.latched).toBe(true);
});
test("fills during retry backoff accumulate without bypassing the deadline", () => {
  const failed = confirm(
    confirm(start(), "failed", 0n, 20).state,
    "failed",
    0n,
    30,
  );
  const more = reduceHedge(
    failed.state,
    fill(7n, "BID", "o2", "tx2", 40),
    hedgePolicy(),
  );
  expect(more.commands).toEqual([]);
  expect(more.state.retryAt).toBe(2030);
  const retry = reduceHedge(
    more.state,
    { type: "timeout_tick", now: 2030 },
    hedgePolicy(),
  );
  expect(retry.state.active?.intent.size).toBe(17n);
});
test("netted exposure clears a pending retry without an alert or unnecessary send", () => {
  const failed = confirm(
    confirm(start(), "failed", 0n, 20).state,
    "failed",
    0n,
    30,
  );
  const flat = reduceHedge(
    failed.state,
    fill(10n, "ASK", "o2", "tx2", 40),
    hedgePolicy(),
  );
  expect(flat.state.retryAt).toBeNull();
  expect(flat.state.escalated).toBe(false);
  expect(flat.state.latched).toBe(true);
  expect(
    reduceHedge(flat.state, { type: "timeout_tick", now: 2030 }, hedgePolicy())
      .commands,
  ).toEqual([]);
});
test("unknown retry outcome holds the same index and cannot start another retry", () => {
  const failed = confirm(
    confirm(start(), "failed", 0n, 20).state,
    "failed",
    0n,
    30,
  );
  const retried = reduceHedge(
    failed.state,
    { type: "timeout_tick", now: 2030 },
    hedgePolicy(),
  );
  const unknown = reduceHedge(
    retried.state,
    { type: "unknown_outcome", clientOrderIndex: 3n, now: 2040 },
    hedgePolicy(),
  );
  expect(unknown.commands.map((c) => c.type)).toEqual(["resolve_unknown"]);
  const tick = reduceHedge(
    unknown.state,
    { type: "timeout_tick", now: 10000 },
    hedgePolicy(),
  );
  expect(tick.commands).toEqual([]);
  expect(tick.state.active?.intent.clientOrderIndex).toBe(3n);
});
for (const reason of [
  "invalid_hedge_input",
  "invalid_fill",
  "invalid_hedge_confirmation",
  "invalid_client_order_allocator",
] as const)
  test(`${reason} halts all subsequent automated hedge sends`, () => {
    const p = hedgePolicy();
    let r: ReturnType<typeof reduceHedge>;
    if (reason === "invalid_hedge_input")
      r = reduceHedge(initialHedgerState("SOL"), fill(), {
        ...p,
        slippageBps: NaN,
      });
    else if (reason === "invalid_fill")
      r = reduceHedge(initialHedgerState("SOL"), fill(0n), p);
    else if (reason === "invalid_hedge_confirmation")
      r = confirm(start(), "filled", 11n, 20);
    else
      r = reduceHedge(initialHedgerState("SOL"), fill(), {
        ...p,
        allocate: (next) => ({ clientOrderIndex: next, next }),
      });
    expect(r.state.halted).toBe(true);
    expect(r.commands).toContainEqual({ type: "trip_breaker", reason });
    let state = r.state;
    if (state.active)
      state = confirm(state, "filled", state.active.intent.size, 30).state;
    const next = reduceHedge(state, fill(10n, "BID", "o2", "tx2", 40), p);
    expect(next.commands.some((c) => c.type === "place_hedge")).toBe(false);
    expect(next.state.active).toBeNull();
    expect(next.state.halted).toBe(true);
    expect(
      reduceHedge(
        next.state,
        { type: "timeout_tick", now: 3000 },
        p,
      ).commands.some((c) => c.type === "place_hedge"),
    ).toBe(false);
  });
for (const retryBackoffMs of [0, -1, NaN, Infinity, 0.5])
  test(`invalid retry backoff ${retryBackoffMs} halts sends`, () => {
    const r = reduceHedge(initialHedgerState("SOL"), fill(), {
      ...hedgePolicy(),
      retryBackoffMs,
    });
    expect(r.state.halted).toBe(true);
    expect(r.commands.some((c) => c.type === "place_hedge")).toBe(false);
  });
test("retry is deterministic and does not mutate persisted state", () => {
  const s = confirm(
    confirm(start(), "failed", 0n, 20).state,
    "failed",
    0n,
    30,
  ).state;
  const snapshot = structuredClone(s);
  const e: HedgeEvent = { type: "timeout_tick", now: 2030 };
  expect(reduceHedge(s, e, hedgePolicy())).toEqual(
    reduceHedge(s, e, hedgePolicy()),
  );
  expect(s).toEqual(snapshot);
});

test("allocator exception halts subsequent hedge sends without losing exposure", () => {
  const p = hedgePolicy();
  p.allocate = () => {
    throw Error("allocation failed");
  };
  const r = reduceHedge(initialHedgerState("SOL"), fill(), p);
  expect(r.state.halted).toBe(true);
  expect(r.state.unhedgedBase).toBe(10n);
  expect(r.commands).toContainEqual({
    type: "trip_breaker",
    reason: "invalid_client_order_allocator",
  });
  expect(
    reduceHedge(
      r.state,
      { type: "timeout_tick", now: 20 },
      hedgePolicy(),
    ).commands.some((c) => c.type === "place_hedge"),
  ).toBe(false);
});
test("negative allocated hedge index is an integrity halt", () => {
  const r = reduceHedge(initialHedgerState("SOL", -1n), fill(), hedgePolicy());
  expect(r.state.halted).toBe(true);
  expect(r.state.active).toBeNull();
});
test("retry alert is emitted only when accumulated residual meets the hedge minimum", () => {
  const p = hedgePolicy();
  const failed = confirm(
    confirm(start(), "failed", 0n, 20).state,
    "failed",
    6n,
    30,
  );
  expect(failed.state.unhedgedBase).toBe(4n);
  const dust = reduceHedge(
    failed.state,
    { type: "timeout_tick", now: 2030 },
    p,
  );
  expect(dust.commands).toEqual([]);
  expect(dust.state.retryAt).toBe(2030);
  const accumulated = reduceHedge(
    dust.state,
    fill(1n, "BID", "o2", "tx2", 2040),
    p,
  );
  expect(accumulated.commands.map((c) => c.type)).toEqual([
    "alert",
    "persist_intent",
    "place_hedge",
  ]);
  expect(accumulated.state.active?.intent.size).toBe(5n);
  expect(accumulated.state.active?.intent.slippageBps).toBe(100);
});

for (const side of ["BID", "ASK"] as const)
  test(`joint-step and quote minimum classify signed ${side} dust`, () => {
    const p = { ...hedgePolicy(), lot: 3n, minSize: 1n, minNotional: 7n };
    const dust = reduceHedge(initialHedgerState("SOL"), fill(8n, side), p);
    expect(dust.state.hedgeableBase).toBe(0n);
    expect(dust.state.dustBase).toBe(side === "BID" ? 8n : -8n);
    expect(dust.state.unhedgedSince).toBeNull();
    const r = reduceHedge(dust.state, fill(2n, side, "o2", "tx2", 1011), p);
    expect(r.state.hedgeableBase).toBe(side === "BID" ? 9n : -9n);
    expect(r.state.dustBase).toBe(side === "BID" ? 1n : -1n);
    expect(r.state.active?.intent.size).toBe(9n);
    expect(r.state.latched).toBe(false);
    const done = reduceHedge(
      r.state,
      {
        type: "hedge_confirmed",
        now: 1020,
        result: { clientOrderIndex: 1n, status: "filled", filledSize: 9n },
      },
      p,
    );
    expect(done.state.hedgeableBase).toBe(0n);
    expect(done.state.dustBase).toBe(side === "BID" ? 1n : -1n);
    expect(done.state.unhedgedSince).toBeNull();
    expect(
      reduceHedge(done.state, { type: "timeout_tick", now: 3000 }, p).commands,
    ).toEqual([]);
  });

test("USD cap applies only to the hedgeable portion of joint-step exposure", () => {
  const p = { ...hedgePolicy(), lot: 3n, maxUnhedgedUsd: 9n };
  const r = reduceHedge(initialHedgerState("SOL"), fill(10n), p);
  expect(r.state.hedgeableBase).toBe(9n);
  expect(r.state.dustBase).toBe(1n);
  expect(r.state.latched).toBe(false);
  const breach = reduceHedge(r.state, fill(2n, "BID", "o2", "tx2", 11), p);
  expect(breach.state.hedgeableBase).toBe(12n);
  expect(breach.commands).toContainEqual({
    type: "trip_breaker",
    reason: "max_unhedged_usd",
  });
});
