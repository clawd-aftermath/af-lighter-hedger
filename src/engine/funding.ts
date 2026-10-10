import { AF_SCALE } from "../core/units";
import type { FundingPayment, StateStore } from "../state/store";
export interface CumulativeFunding {
  long: number;
  short: number;
  ts: number;
}
// Cumulative funding is USD per base unit; positive changes debit longs.
export function recordAfFunding(
  store: StateStore,
  market: string,
  base: bigint,
  current: CumulativeFunding,
): FundingPayment[] {
  const key = `af:funding_checkpoint:${market}`;
  const previous = store.get<CumulativeFunding & { base: bigint }>(key);
  const payments: FundingPayment[] = [];
  store.transaction(() => {
    if (previous && current.ts > previous.ts) {
      const change =
        previous.base >= 0n
          ? current.long - previous.long
          : current.short - previous.short;
      const rate = BigInt(Math.round(change * 1e9));
      const payment: FundingPayment = {
        venue: "af",
        market,
        ts: current.ts,
        source: "derived",
        amount: (-previous.base * rate) / AF_SCALE,
        key: `${market}:${current.ts}`,
      };
      if (store.funding(payment)) payments.push(payment);
    }
    if (!previous || current.ts >= previous.ts)
      store.set(key, { ...current, base });
  });
  return payments;
}
export function hourlyPayment(
  base: bigint,
  price: bigint,
  hourlyRate: number,
): bigint {
  if (!Number.isFinite(hourlyRate))
    throw new Error("Invalid hourly funding rate");
  const rate = BigInt(Math.round(hourlyRate * 1e12));
  return (-((base * price) / AF_SCALE) * rate) / 1000000000000n;
}
