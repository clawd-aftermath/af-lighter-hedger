import { abs } from "../domain/types";

export type GateReason =
  | "stale_af_book"
  | "stale_af_oracle"
  | "stale_lighter_book"
  | "basis_band"
  | "funding_sign_flip"
  | "session_closed"
  | "margin_headroom"
  | "unhedged_notional"
  | "unhedged_age"
  | "oi_headroom"
  | "breaker_latched"
  | "invalid_input"
  | "market_notional"
  | "global_notional"
  | "daily_loss";
export type GateResult = { ok: true } | { ok: false; reason: GateReason };

export interface GateInput {
  now: number;
  afBookTs: number;
  afOracleTs: number;
  lighterBookTs: number;
  stalenessMs: { afBook: number; afOracle: number; lighterBook: number };
  basisBp: number;
  basisEmaBp: number;
  basisBandBp: number;
  predictedAfHourly: number;
  inventory: bigint;
  sessionOpen: boolean;
  pauseWhenSessionClosed: boolean;
  marginHeadroomPct: number;
  minMarginHeadroomPct: number;
  unhedgedUsd: bigint;
  maxUnhedgedUsd: bigint;
  unhedgedSince: number | null;
  maxUnhedgedAgeMs: number;
  oiHeadroom: bigint;
  breakerLatched: boolean;
}

export function evaluateGates(i: GateInput): readonly GateResult[] {
  const results: GateResult[] = [];
  const check = (failed: boolean, reason: GateReason) =>
    results.push(failed ? { ok: false, reason } : { ok: true });
  const numbers = [
    i.now,
    i.afBookTs,
    i.afOracleTs,
    i.lighterBookTs,
    ...Object.values(i.stalenessMs),
    i.basisBp,
    i.basisEmaBp,
    i.basisBandBp,
    i.predictedAfHourly,
    i.marginHeadroomPct,
    i.minMarginHeadroomPct,
    i.maxUnhedgedAgeMs,
  ];
  check(
    !numbers.every(Number.isFinite) ||
      Object.values(i.stalenessMs).some((v) => v < 0) ||
      i.basisBandBp < 0 ||
      i.maxUnhedgedUsd < 0n ||
      i.maxUnhedgedAgeMs < 0 ||
      i.minMarginHeadroomPct < 0 ||
      i.minMarginHeadroomPct > 100 ||
      i.marginHeadroomPct < 0 ||
      i.marginHeadroomPct > 100 ||
      (i.unhedgedSince !== null &&
        (!Number.isFinite(i.unhedgedSince) || i.unhedgedSince > i.now)),
    "invalid_input",
  );
  check(
    i.afBookTs > i.now || i.now - i.afBookTs > i.stalenessMs.afBook,
    "stale_af_book",
  );
  check(
    i.afOracleTs > i.now || i.now - i.afOracleTs > i.stalenessMs.afOracle,
    "stale_af_oracle",
  );
  check(
    i.lighterBookTs > i.now ||
      i.now - i.lighterBookTs > i.stalenessMs.lighterBook,
    "stale_lighter_book",
  );
  check(Math.abs(i.basisBp - i.basisEmaBp) > i.basisBandBp, "basis_band");
  check(
    (i.inventory > 0n && i.predictedAfHourly > 0) ||
      (i.inventory < 0n && i.predictedAfHourly < 0),
    "funding_sign_flip",
  );
  check(i.pauseWhenSessionClosed && !i.sessionOpen, "session_closed");
  check(i.marginHeadroomPct < i.minMarginHeadroomPct, "margin_headroom");
  check(abs(i.unhedgedUsd) > i.maxUnhedgedUsd, "unhedged_notional");
  check(
    i.unhedgedUsd !== 0n &&
      (i.unhedgedSince === null ||
        i.now - i.unhedgedSince > i.maxUnhedgedAgeMs),
    "unhedged_age",
  );
  check(i.oiHeadroom <= 0n, "oi_headroom");
  check(i.breakerLatched, "breaker_latched");
  return results;
}

export function failedReasons(results: readonly GateResult[]): GateReason[] {
  return results.flatMap((r) => (r.ok ? [] : [r.reason]));
}
