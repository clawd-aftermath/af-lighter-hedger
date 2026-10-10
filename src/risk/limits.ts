import { abs, min } from "../domain/types";
import type { GateResult } from "./gates";

export function evaluateLimits(i: {
  marketNotional: bigint;
  pendingMarketNotional: bigint;
  maxMarketNotional: bigint;
  totalNotional: bigint;
  pendingTotalNotional: bigint;
  maxTotalNotional: bigint;
  dailyPnl: bigint;
  dailyLossLimit: bigint;
}): GateResult[] {
  if (
    [
      i.marketNotional,
      i.pendingMarketNotional,
      i.maxMarketNotional,
      i.totalNotional,
      i.pendingTotalNotional,
      i.maxTotalNotional,
      i.dailyLossLimit,
    ].some((v) => v < 0n)
  )
    return [{ ok: false, reason: "invalid_input" }];
  return [
    i.marketNotional + i.pendingMarketNotional > i.maxMarketNotional
      ? { ok: false, reason: "market_notional" }
      : { ok: true },
    i.totalNotional + i.pendingTotalNotional > i.maxTotalNotional
      ? { ok: false, reason: "global_notional" }
      : { ok: true },
    i.dailyPnl <= -i.dailyLossLimit
      ? { ok: false, reason: "daily_loss" }
      : { ok: true },
  ];
}

// All quantities are base units on one common scale. pendingIncrease includes
// resting and submitted opening orders, including other sides conservatively.
export function oiCapacity(i: {
  openInterest: bigint;
  maxOpenInterest: bigint;
  position: bigint;
  pendingIncrease: bigint;
  halfOiThreshold: bigint;
}): bigint {
  if (
    i.openInterest < 0n ||
    i.maxOpenInterest < 0n ||
    i.pendingIncrease < 0n ||
    i.halfOiThreshold < 0n
  )
    throw new Error("OI: invalid input");
  const total = i.maxOpenInterest - i.openInterest - i.pendingIncrease;
  const half =
    i.openInterest > i.halfOiThreshold
      ? i.openInterest / 2n - abs(i.position) - i.pendingIncrease
      : total;
  return min(total > 0n ? total : 0n, half > 0n ? half : 0n);
}

export function marginCapacity(
  availableBase: bigint,
  pendingBase: bigint,
): bigint {
  if (availableBase < 0n || pendingBase < 0n)
    throw new Error("margin: invalid input");
  return availableBase > pendingBase ? availableBase - pendingBase : 0n;
}
