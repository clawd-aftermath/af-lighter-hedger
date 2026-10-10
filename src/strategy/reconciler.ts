import { abs, type Position, type Scaled } from "../domain/types";

export type ReconcileResult =
  | { type: "noop" }
  | { type: "hedge"; delta: Scaled }
  | {
      type: "failClosed";
      reason:
        | "stale_af"
        | "stale_lighter"
        | "stale_hedges"
        | "unknown_position"
        | "unknown_hedge"
        | "market_mismatch"
        | "invalid_units";
    };
export interface ReconcileInput {
  af: Position | null;
  lighter: Position | null;
  inFlight: readonly {
    marketId: string;
    remainingSignedBase: Scaled;
    known: boolean;
  }[];
  fresh: { af: boolean; lighter: boolean; hedges: boolean };
  afLot: Scaled;
  lighterLot: Scaled;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

export function reconcile(i: ReconcileInput): ReconcileResult {
  if (!i.fresh.af) return { type: "failClosed", reason: "stale_af" };
  if (!i.fresh.lighter) return { type: "failClosed", reason: "stale_lighter" };
  if (!i.fresh.hedges) return { type: "failClosed", reason: "stale_hedges" };
  if (!i.af || !i.lighter)
    return { type: "failClosed", reason: "unknown_position" };
  if (i.inFlight.some((h) => !h.known))
    return { type: "failClosed", reason: "unknown_hedge" };
  if (
    i.af.marketId !== i.lighter.marketId ||
    i.inFlight.some((h) => h.marketId !== i.af?.marketId)
  )
    return { type: "failClosed", reason: "market_mismatch" };
  const units = [
    i.af.base,
    i.lighter.base,
    i.afLot,
    i.lighterLot,
    ...i.inFlight.map((h) => h.remainingSignedBase),
  ];
  if (
    units.some((u) => u.scale <= 0n) ||
    i.afLot.value <= 0n ||
    i.lighterLot.value <= 0n
  )
    return { type: "failClosed", reason: "invalid_units" };
  const scale = units.reduce((s, u) => (s / gcd(s, u.scale)) * u.scale, 1n);
  const atScale = (u: Scaled) => u.value * (scale / u.scale);
  const afLot = atScale(i.afLot);
  const lighterLot = atScale(i.lighterLot);
  const tolerance = afLot > lighterLot ? afLot : lighterLot;
  const net =
    atScale(i.af.base) +
    atScale(i.lighter.base) +
    i.inFlight.reduce((n, h) => n + atScale(h.remainingSignedBase), 0n);
  if (abs(net) <= tolerance) return { type: "noop" };
  const delta = -((net / lighterLot) * lighterLot);
  return { type: "hedge", delta: { value: delta, scale } };
}
