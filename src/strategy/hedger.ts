import {
  abs,
  ceilDiv,
  type Fill,
  type HedgeIntent,
  type HedgeResult,
} from "../domain/types";

export interface ActiveHedge {
  intent: HedgeIntent;
  status: "submitted" | "accepted" | "unknown";
  filledSize: bigint;
  sentAt: number;
}

export interface HedgerState {
  marketId: string;
  seenFills: readonly string[];
  // Total signed exposure, including dust, used by reconciliation.
  unhedgedBase: bigint;
  hedgeableBase: bigint;
  dustBase: bigint;
  // Age of hedgeable exposure only.
  unhedgedSince: number | null;
  active: ActiveHedge | null;
  nextClientOrderIndex: bigint;
  escalated: boolean;
  // Stops quoting; exposure reduction continues while this latch is set.
  latched: boolean;
  // Integrity failures require reconciliation/operator intervention before sends resume.
  halted: boolean;
  retryAt: number | null;
  lastNow: number;
}

export type HedgeEvent =
  | { type: "af_fill"; fill: Fill; now: number }
  | { type: "hedge_accepted"; clientOrderIndex: bigint; now: number }
  | {
      type: "hedge_confirmed";
      result: HedgeResult;
      terminal?: boolean;
      now: number;
    }
  | { type: "unknown_outcome"; clientOrderIndex: bigint; now: number }
  | { type: "timeout_tick"; now: number };

export type HedgeCommand =
  | {
      type: "persist_intent";
      intent: HedgeIntent;
      nextClientOrderIndex: bigint;
    }
  | { type: "place_hedge"; intent: HedgeIntent }
  | { type: "resolve_unknown"; clientOrderIndex: bigint }
  | { type: "escalate_slippage"; slippageBps: number }
  | { type: "pull_quotes"; reason: string }
  | { type: "trip_breaker"; reason: string }
  | {
      type: "alert";
      severity: "warning" | "error" | "critical";
      reason: string;
    };

export const DEFAULT_RETRY_BACKOFF_MS = 2000;

export interface HedgePolicy {
  lot: bigint;
  minSize: bigint;
  minNotional: bigint;
  price: bigint;
  priceScale: bigint;
  sizeScale: bigint;
  usdScale: bigint;
  maxUnhedgedUsd: bigint;
  maxUnhedgedAgeMs: number;
  outcomeTimeoutMs: number;
  slippageBps: number;
  emergencySlippageBps: number;
  // Delay after a definite emergency hedge failure; defaults to 2000 ms.
  retryBackoffMs?: number;
  // A pure allocator: input and returned cursor are persisted with the intent.
  allocate: (next: bigint) => { clientOrderIndex: bigint; next: bigint };
}

// The minimum executable size is rounded up to the joint lot. Any remainder
// stays in the net exposure and can accumulate with subsequent AF fills.
export function splitUnhedged(
  base: bigint,
  p: Pick<
    HedgePolicy,
    | "lot"
    | "minSize"
    | "minNotional"
    | "price"
    | "priceScale"
    | "sizeScale"
    | "usdScale"
  >,
): { hedgeableBase: bigint; dustBase: bigint } {
  const quoteMinimum = ceilDiv(
    p.minNotional * p.sizeScale * p.priceScale,
    p.price * p.usdScale,
  );
  const minimum =
    ceilDiv(p.minSize > quoteMinimum ? p.minSize : quoteMinimum, p.lot) * p.lot;
  const rounded = (base / p.lot) * p.lot;
  const hedgeableBase = abs(rounded) >= minimum ? rounded : 0n;
  return { hedgeableBase, dustBase: base - hedgeableBase };
}

export function initialHedgerState(
  marketId: string,
  nextClientOrderIndex = 1n,
): HedgerState {
  return {
    marketId,
    seenFills: [],
    unhedgedBase: 0n,
    hedgeableBase: 0n,
    dustBase: 0n,
    unhedgedSince: null,
    active: null,
    nextClientOrderIndex,
    escalated: false,
    latched: false,
    halted: false,
    retryAt: null,
    lastNow: 0,
  };
}

export function reduceHedge(
  previous: HedgerState,
  event: HedgeEvent,
  p: HedgePolicy,
): { state: HedgerState; commands: HedgeCommand[] } {
  // Ignore already-applied fills before checking their replayed timestamps.
  if (
    event.type === "af_fill" &&
    (event.fill.marketId !== previous.marketId ||
      previous.seenFills.includes(
        JSON.stringify([event.fill.txDigest, event.fill.orderId]),
      ))
  ) {
    return { state: previous, commands: [] };
  }
  if (
    (event.type === "hedge_confirmed" &&
      previous.active?.intent.clientOrderIndex !==
        event.result.clientOrderIndex) ||
    ((event.type === "hedge_accepted" || event.type === "unknown_outcome") &&
      previous.active?.intent.clientOrderIndex !== event.clientOrderIndex)
  ) {
    return { state: previous, commands: [] };
  }
  const state: HedgerState = {
    ...previous,
    seenFills: [...previous.seenFills],
    active: previous.active
      ? { ...previous.active, intent: { ...previous.active.intent } }
      : null,
  };
  const commands: HedgeCommand[] = [];
  const retryBackoffMs = p.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const tripQuoting = (reason: string) => {
    if (!state.latched)
      commands.push(
        { type: "pull_quotes", reason },
        { type: "trip_breaker", reason },
      );
    state.latched = true;
  };
  const halt = (reason: string) => {
    tripQuoting(reason);
    state.halted = true;
  };
  if (
    p.lot <= 0n ||
    p.minSize < 0n ||
    p.minNotional < 0n ||
    p.price <= 0n ||
    p.priceScale <= 0n ||
    p.sizeScale <= 0n ||
    p.usdScale <= 0n ||
    p.maxUnhedgedUsd < 0n ||
    ![
      event.now,
      p.maxUnhedgedAgeMs,
      p.outcomeTimeoutMs,
      p.slippageBps,
      p.emergencySlippageBps,
    ].every(Number.isFinite) ||
    p.maxUnhedgedAgeMs < 0 ||
    p.outcomeTimeoutMs <= 0 ||
    p.slippageBps < 0 ||
    p.emergencySlippageBps < p.slippageBps ||
    p.emergencySlippageBps > 400 ||
    !Number.isSafeInteger(retryBackoffMs) ||
    retryBackoffMs <= 0 ||
    event.now < state.lastNow
  ) {
    halt("invalid_hedge_input");
    return { state, commands };
  }
  state.lastNow = event.now;
  if (event.type === "af_fill") {
    const key = JSON.stringify([event.fill.txDigest, event.fill.orderId]);
    if (
      event.fill.size <= 0n ||
      !Number.isFinite(event.fill.ts) ||
      event.fill.ts > event.now
    ) {
      halt("invalid_fill");
      return { state, commands };
    }
    state.seenFills = [...state.seenFills, key];
    state.unhedgedBase +=
      (event.fill.side === "BID" ? 1n : -1n) * event.fill.size;
  } else if (event.type === "hedge_confirmed") {
    const active = state.active;
    if (
      !active ||
      active.intent.clientOrderIndex !== event.result.clientOrderIndex
    )
      return { state: previous, commands: [] };
    const filled = event.result.filledSize;
    if (
      filled < active.filledSize ||
      filled > active.intent.size ||
      (event.result.status === "filled" && filled !== active.intent.size)
    ) {
      halt("invalid_hedge_confirmation");
      return { state, commands };
    }
    const incremental = filled - active.filledSize;
    state.unhedgedBase +=
      (active.intent.side === "BID" ? 1n : -1n) * incremental;
    active.filledSize = filled;
    if (event.result.status !== "partial" || event.terminal === true) {
      state.active = null;
      if (
        state.unhedgedBase !== 0n &&
        filled < active.intent.size &&
        (event.result.status === "failed" ||
          event.result.status === "canceled" ||
          event.result.status === "partial")
      ) {
        if (state.escalated) {
          tripQuoting("hedge_failed_after_escalation");
          state.retryAt = event.now + retryBackoffMs;
        } else {
          state.escalated = true;
          commands.push({
            type: "escalate_slippage",
            slippageBps: p.emergencySlippageBps,
          });
        }
      }
    } else {
      // A partial report proves this order is still active; reserve its remainder.
      active.status = "accepted";
    }
  } else if (event.type === "hedge_accepted") {
    if (state.active?.intent.clientOrderIndex !== event.clientOrderIndex)
      return { state: previous, commands: [] };
    state.active.status = "accepted";
  } else if (event.type === "unknown_outcome") {
    if (state.active?.intent.clientOrderIndex !== event.clientOrderIndex)
      return { state: previous, commands: [] };
    if (state.active.status !== "unknown") {
      state.active.status = "unknown";
      commands.push({
        type: "resolve_unknown",
        clientOrderIndex: event.clientOrderIndex,
      });
    }
  } else if (
    state.active &&
    state.active.status !== "unknown" &&
    event.now - state.active.sentAt >= p.outcomeTimeoutMs
  ) {
    state.active.status = "unknown";
    commands.push({
      type: "resolve_unknown",
      clientOrderIndex: state.active.intent.clientOrderIndex,
    });
  }
  Object.assign(state, splitUnhedged(state.unhedgedBase, p));
  if (state.hedgeableBase === 0n) {
    state.unhedgedSince = null;
  } else {
    const since = event.type === "af_fill" ? event.fill.ts : event.now;
    state.unhedgedSince =
      previous.hedgeableBase === 0n || previous.unhedgedSince === null
        ? since
        : Math.min(previous.unhedgedSince, since);
  }
  if (state.unhedgedBase === 0n) {
    if (!state.active) {
      state.escalated = false;
      state.retryAt = null;
    }
  }
  const unhedgedUsd = ceilDiv(
    abs(state.hedgeableBase) * p.price * p.usdScale,
    p.sizeScale * p.priceScale,
  );
  if (unhedgedUsd > p.maxUnhedgedUsd) tripQuoting("max_unhedged_usd");
  if (
    state.unhedgedSince !== null &&
    event.now - state.unhedgedSince > p.maxUnhedgedAgeMs
  )
    tripQuoting("max_unhedged_age");
  if (
    state.halted ||
    state.active ||
    (state.retryAt !== null && event.now < state.retryAt)
  )
    return { state, commands };
  const size = abs(state.hedgeableBase);
  if (size === 0n) return { state, commands };
  let allocated: ReturnType<HedgePolicy["allocate"]>;
  try {
    allocated = p.allocate(state.nextClientOrderIndex);
  } catch {
    halt("invalid_client_order_allocator");
    return { state, commands };
  }
  if (
    !allocated ||
    typeof allocated.clientOrderIndex !== "bigint" ||
    typeof allocated.next !== "bigint" ||
    allocated.clientOrderIndex < 0n ||
    allocated.clientOrderIndex < state.nextClientOrderIndex ||
    allocated.next <= allocated.clientOrderIndex
  ) {
    halt("invalid_client_order_allocator");
    return { state, commands };
  }
  const intent: HedgeIntent = {
    marketId: state.marketId,
    clientOrderIndex: allocated.clientOrderIndex,
    side: state.unhedgedBase > 0n ? "ASK" : "BID",
    size,
    slippageBps: state.escalated ? p.emergencySlippageBps : p.slippageBps,
  };
  state.nextClientOrderIndex = allocated.next;
  state.active = {
    intent,
    status: "submitted",
    filledSize: 0n,
    sentAt: event.now,
  };
  if (state.retryAt !== null) {
    commands.push({
      type: "alert",
      severity: "error",
      reason: "hedge_failed_after_escalation",
    });
    state.retryAt = null;
  }
  commands.push(
    {
      type: "persist_intent",
      intent: { ...intent },
      nextClientOrderIndex: allocated.next,
    },
    { type: "place_hedge", intent: { ...intent } },
  );
  return { state, commands };
}
