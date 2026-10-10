import type { RuntimeConfig } from "../config/schema";
import type { Book, Fill, HedgeIntent, OwnOrder, Side } from "../domain/types";
import type { AlertSink } from "../ops/alerts";
import type { FundingPayment, Intent, StateStore } from "../state/store";
import type { Clock, HedgeResult } from "../venues/lighter";
import type { ResolvedMarket } from "./markets";

export type Mode = "paper" | "dry" | "live";
export interface AccountPosition {
  base: bigint; // AF 1e9 base units on both adapter boundaries.
  exists: boolean;
  fresh: boolean;
  ts: number;
  marginHeadroomPct: number;
  availableUsd: bigint;
  equityUsd: bigint;
  orders: readonly OwnOrder[];
}
export interface MarketView {
  afBook: Book;
  lighterBook: Book; // Both books normalized to 1e9 price and base scales.
  index: bigint;
  oracleTs: number;
  marketTs: number;
  statsTs: number;
  afConnected: boolean;
  lighterConnected: boolean;
  af: ResolvedMarket["af"];
  openInterest: bigint;
  lighterHourlyFunding: number;
  fundingObserved: boolean;
  cumulativeFunding?: { long: number; short: number; ts: number };
  afFrameTs?: number;
  lighterFrameTs?: number;
}
export interface QuoteRequest {
  market: string;
  orders: readonly OwnOrder[];
  cancel: readonly string[];
  reduceOnly: boolean;
  hasPosition: boolean;
  expiryTimestamp: number;
  postOnly: true;
  maxOrderNotional?: bigint;
  shouldAbortOnMissingId: false;
}
export interface AfReceipt {
  status: "success" | "failure";
  digest: string;
  // null when there are no executed or gRPC-simulated transaction events.
  updatedPremiumTwap: boolean | null;
  gasUsd: bigint;
  gasUsedMist?: bigint;
  simulated?: boolean;
  placedOrders?: readonly OwnOrder[];
}
export interface HedgeSubmission {
  intent: HedgeIntent;
  baseAmount: bigint;
  refPrice: bigint;
  reduceOnly: boolean;
  benchmarkPrice?: bigint;
}
export type Resolution =
  | { status: "unknown" }
  | {
      status: "confirmed" | "failed" | "abandoned";
      result?: AfReceipt | HedgeResult;
    };
export interface SendContext {
  intent: Intent;
  beforeSend(hash: string): void;
}
export interface AfVenue {
  position(market: string): Promise<AccountPosition>;
  quote(request: QuoteRequest, context: SendContext): Promise<AfReceipt>;
  cancel(
    market: string,
    orders: readonly OwnOrder[],
    context: SendContext,
  ): Promise<AfReceipt>;
  flatten(
    market: string,
    side: Side,
    size: bigint,
    slippageBps: number,
    context: SendContext,
  ): Promise<AfReceipt>;
  resolve(intent: Intent): Promise<Resolution>;
  funding?(): Promise<FundingPayment[]>;
}
export interface LighterVenue {
  position(market: string): Promise<AccountPosition>;
  hedge(request: HedgeSubmission, context: SendContext): Promise<HedgeResult>;
  resolve(intent: Intent): Promise<Resolution>;
  funding?(): Promise<FundingPayment[]>;
}
export type FeedEvent =
  | { type: "market"; market: string; view: MarketView }
  | { type: "fill"; fill: Fill; fee?: bigint }
  | {
      type: "position";
      market: string;
      afPosition?: Pick<AccountPosition, "base" | "exists">;
    }
  | { type: "disconnect"; venue: "af" | "lighter" }
  | { type: "reconnect"; venue: "af" | "lighter" };
export interface Feeds {
  view(market: string): MarketView;
  refresh(): Promise<void>;
  start(listener: (event: FeedEvent) => void): void;
  stop(): void;
}
export interface EngineOptions {
  mode: Mode;
  config: RuntimeConfig;
  markets: readonly ResolvedMarket[];
  store: StateStore;
  af: AfVenue;
  lighter: LighterVenue;
  feeds: Feeds;
  alerts: AlertSink;
  clock: Clock;
  minQuoteIntervalMs?: number;
  logger?: import("../core/logger").Logger;
}
