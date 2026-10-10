export type Side = "BID" | "ASK";
export type MarketId = string;

// Prices, base sizes and USD amounts each carry an explicit integer scale.
export interface Scaled {
  value: bigint;
  scale: bigint;
}

export interface BookLevel {
  price: bigint;
  size: bigint;
  clientOrderId?: string;
}

// Bids descend and asks ascend. Tagged levels identify individual orders;
// untagged levels aggregate size at a price.
export interface Book {
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
  priceScale: bigint;
  sizeScale: bigint;
  ts: number;
}

export interface OwnOrder {
  marketId: MarketId;
  clientOrderId: string;
  side: Side;
  price: bigint;
  size: bigint;
  reduceOnly: boolean;
  createdAt?: number;
}

export interface Position {
  marketId: MarketId;
  base: Scaled;
}

export interface Fill {
  marketId: MarketId;
  txDigest: string;
  orderId: string;
  side: Side;
  price: bigint;
  size: bigint;
  ts: number;
}

export interface HedgeIntent {
  marketId: MarketId;
  clientOrderIndex: bigint;
  side: Side;
  size: bigint;
  slippageBps: number;
}

export interface HedgeResult {
  clientOrderIndex: bigint;
  status: "filled" | "partial" | "canceled" | "failed";
  filledSize: bigint;
}

export interface FundingSnapshot {
  hourlyFraction: number;
  rhoHours: number;
  source: "observed" | "predicted" | "history";
  ts: number;
}

export function opposite(side: Side): Side {
  return side === "BID" ? "ASK" : "BID";
}

export function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function min(...values: bigint[]): bigint {
  if (values.length === 0) throw new Error("min requires values");
  return values.reduce((a, b) => (a < b ? a : b));
}

export function ceilDiv(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new Error("ceilDiv requires n >= 0, d > 0");
  return (n + d - 1n) / d;
}
