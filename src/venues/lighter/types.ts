import { ConfigError } from "../../core/errors";
import { parseIdString } from "../../core/units";

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConfigError("Invalid Lighter object");
  return value as JsonObject;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ConfigError("Invalid Lighter array");
  return value;
}
export function text(value: unknown): string {
  if (typeof value !== "string")
    throw new ConfigError("Invalid Lighter string");
  return value;
}
export function decimal(value: unknown): string {
  const result = text(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(result))
    throw new ConfigError("Invalid Lighter decimal");
  return result;
}
export function integer(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n))
    throw new ConfigError("Invalid Lighter integer");
  return n;
}
// Protect bare JSON integer IDs before JSON.parse can round them. Quoted strings
// (including embedded info/event_info JSON) are left intact. No dependency needed.
export function parseJsonLossless(input: string): unknown {
  return JSON.parse(
    input.replace(
      /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      (token) => {
        if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)))
          return `"${token}"`;
        return token;
      },
    ),
  );
}
export interface Market {
  marketId: number;
  symbol: string;
  marketType: string;
  status: string;
  sizeDecimals: number;
  priceDecimals: number;
  minBaseAmount: string;
  minQuoteAmount: string;
  makerFee: string;
  takerFee: string;
  baseInterestRate?: string;
  fundingClampSmall?: string;
  fundingClampBig?: string;
  fundingPremiumMultiplier?: number;
}
export function parseMarket(v: unknown): Market {
  const r = object(v);
  const sizeDecimals = integer(r.size_decimals);
  const priceDecimals = integer(r.price_decimals);
  if (
    sizeDecimals < 0 ||
    sizeDecimals > 18 ||
    priceDecimals < 0 ||
    priceDecimals > 18
  )
    throw new ConfigError("Invalid market decimals");
  return {
    marketId: integer(r.market_id),
    symbol: text(r.symbol),
    marketType: text(r.market_type),
    status: text(r.status),
    sizeDecimals,
    priceDecimals,
    minBaseAmount: decimal(r.min_base_amount),
    minQuoteAmount: decimal(r.min_quote_amount),
    makerFee: decimal(r.maker_fee),
    takerFee: decimal(r.taker_fee),
    baseInterestRate:
      r.base_interest_rate === undefined
        ? undefined
        : decimal(r.base_interest_rate),
    fundingClampSmall:
      r.funding_clamp_small === undefined
        ? undefined
        : decimal(r.funding_clamp_small),
    fundingClampBig:
      r.funding_clamp_big === undefined
        ? undefined
        : decimal(r.funding_clamp_big),
    fundingPremiumMultiplier:
      r.funding_premium_multiplier === undefined
        ? undefined
        : integer(r.funding_premium_multiplier),
  };
}
export interface Position {
  marketId: number;
  sign: -1 | 0 | 1;
  position: string;
  avgEntryPrice: string;
  totalFundingPaidOut?: string;
  liquidationPrice?: string;
  unrealizedPnl?: string;
  marginMode?: number;
}
export function parsePosition(v: unknown): Position {
  const r = object(v);
  const sign = integer(r.sign);
  if (sign !== -1 && sign !== 0 && sign !== 1)
    throw new ConfigError("Invalid position sign");
  const position = decimal(r.position);
  if (position.startsWith("-") || (sign === 0 && Number(position) !== 0))
    throw new ConfigError("Invalid position magnitude");
  return {
    marketId: integer(r.market_id),
    sign,
    position,
    avgEntryPrice: decimal(r.avg_entry_price),
    totalFundingPaidOut:
      r.total_funding_paid_out === undefined
        ? undefined
        : decimal(r.total_funding_paid_out),
    liquidationPrice:
      r.liquidation_price === undefined
        ? undefined
        : decimal(r.liquidation_price),
    unrealizedPnl:
      r.unrealized_pnl === undefined ? undefined : decimal(r.unrealized_pnl),
    marginMode:
      r.margin_mode === undefined ? undefined : integer(r.margin_mode),
  };
}
export interface Account {
  accountIndex: bigint;
  collateral?: string;
  availableBalance?: string;
  positions?: Position[];
}
export function parseAccount(v: unknown): Account {
  const r = object(v);
  return {
    accountIndex: parseIdString(r.account_index ?? r.index ?? r.account),
    collateral: r.collateral === undefined ? undefined : decimal(r.collateral),
    availableBalance:
      r.available_balance === undefined
        ? undefined
        : decimal(r.available_balance),
    positions:
      r.positions === undefined
        ? undefined
        : (Array.isArray(r.positions)
            ? r.positions
            : Object.values(object(r.positions))
          ).map(parsePosition),
  };
}
export interface BookOrder {
  orderIndex: bigint;
  price: string;
  remainingBaseAmount: string;
  initialBaseAmount: string;
}
export function parseBookOrder(v: unknown): BookOrder {
  const r = object(v);
  return {
    orderIndex: parseIdString(r.order_id ?? r.order_index),
    price: decimal(r.price),
    remainingBaseAmount: decimal(r.remaining_base_amount),
    initialBaseAmount: decimal(r.initial_base_amount),
  };
}
export const orderStatuses = [
  "in-progress",
  "pending",
  "open",
  "filled",
  "canceled",
  "canceled-post-only",
  "canceled-reduce-only",
  "canceled-position-not-allowed",
  "canceled-margin-not-allowed",
  "canceled-too-much-slippage",
  "canceled-not-enough-liquidity",
  "canceled-self-trade",
  "canceled-expired",
  "canceled-oco",
  "canceled-child",
  "canceled-liquidation",
  "canceled-invalid-balance",
] as const;
export interface Order {
  clientOrderIndex: bigint;
  orderIndex?: bigint;
  marketId: number;
  status: string;
  filledBase: string;
  filledQuote: string;
  fee?: string;
}
export function parseOrder(v: unknown): Order {
  const r = object(v);
  return {
    clientOrderIndex: parseIdString(r.client_order_id ?? r.client_order_index),
    orderIndex:
      r.order_id === undefined && r.order_index === undefined
        ? undefined
        : parseIdString(r.order_id ?? r.order_index),
    marketId: integer(r.market_index ?? r.market_id),
    status: text(r.status),
    filledBase: decimal(r.filled_base_amount),
    filledQuote: decimal(r.filled_quote_amount),
    fee: r.fee === undefined ? undefined : decimal(r.fee),
  };
}
export type TxState = "executed" | "failed" | "pending" | "unknown";
export interface Transaction {
  hash: string;
  nonce?: bigint;
  state: TxState;
  info?: JsonObject;
  eventInfo?: unknown;
}
export function parseTransaction(v: unknown): Transaction {
  const r = object(v);
  const status = integer(r.status);
  return {
    hash: text(r.hash ?? r.tx_hash),
    nonce: r.nonce === undefined ? undefined : parseIdString(r.nonce),
    state:
      status === 0
        ? "failed"
        : status === 2
          ? "executed"
          : status === 1 || status === 3
            ? "pending"
            : "unknown",
    info:
      typeof r.info === "string"
        ? object(parseJsonLossless(r.info))
        : undefined,
    eventInfo:
      typeof r.event_info === "string"
        ? parseJsonLossless(r.event_info)
        : r.event_info,
  };
}
export interface SendTxResult {
  code: number;
  message?: string;
  txHash?: string;
  predictedExecutionTimeMs?: number;
  volumeQuotaRemaining?: bigint;
}
export interface FundingRow {
  timestamp: number;
  rate: string;
  direction: "long" | "short";
  value: string;
}
export interface FundingRateRow {
  marketId: number;
  exchange: string;
  symbol: string;
  rate: number;
}
export interface PositionFunding {
  fundingId: bigint;
  marketId: number;
  timestamp: number;
  change: string;
  rate: string;
  positionSize: string;
  positionSide: "long" | "short";
  discount: string;
}
export interface AccountLimits {
  userTier: string;
  userTierName: string;
  effectiveLitStakes: string;
  makerFeeTick: number;
  takerFeeTick: number;
}
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}
export const systemClock: Clock = {
  now: Date.now,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
