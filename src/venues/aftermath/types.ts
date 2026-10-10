import { z } from "zod";
import { parseBigIntN } from "../../core/units";

export const afInteger = z
  .union([z.bigint(), z.string(), z.number()])
  .transform((v) => parseBigIntN(v));
const finite = z.number().finite();
export const marketSchema = z
  .object({
    packageId: z.string(),
    objectId: z.string(),
    collateralCoinType: z.string(),
    marketParams: z
      .object({
        baseAssetSymbol: z.string(),
        tickSize: afInteger,
        lotSize: afInteger,
        minOrderUsdValue: finite.nonnegative(),
        makerFee: finite,
        takerFee: finite,
        priorityTakerFee: finite.nullish(),
        marginRatioInitial: finite.positive(),
        marginRatioMaintenance: finite,
        maxOpenInterest: finite,
        maxOpenInterestThreshold: finite,
        maxOpenInterestPositionPercent: finite,
        maxPendingOrders: afInteger.refine((v) => v > 0n),
        fundingFrequencyMs: afInteger,
        fundingPeriodMs: afInteger,
      })
      .passthrough(),
    marketState: z.object({ premiumTwap: finite }).passthrough(),
    indexPrice: finite.positive(),
    markPrice: finite.nullish(),
    estimatedFundingRate: finite,
    nextFundingTimestampMs: afInteger,
  })
  .passthrough();
export type RawMarket = z.infer<typeof marketSchema>;
export interface SessionState {
  isOpen: boolean;
  nextTransitionAt: number | null;
}
export interface MarketMetadata {
  symbol: string;
  category: string;
  collateralSymbol: string;
  displayName?: string;
  image?: string;
  session?: (SessionState & { id?: string }) | null;
}
export interface MarketData {
  market: RawMarket;
  metadata: MarketMetadata | null;
}
export interface MarketPrice {
  marketId: string;
  basePrice: number;
  collateralPrice: number;
  markPrice: number;
  midPrice?: number | null;
}
export interface AfMarket {
  id: string;
  packageId: string;
  symbol: string;
  baseSymbol: string;
  category: string | null;
  tickInt: bigint;
  lotInt: bigint;
  minOrderUsd: number;
  makerFee: number;
  takerFee: number;
  priorityTakerFee: number | null;
  imr: number;
  mmr: number;
  maxLeverage: number;
  maxOpenInterestBase: number;
  maxOpenInterestThresholdBase: number;
  maxOpenInterestPositionPercent: number;
  maxPendingOrders: number;
  fundingFrequencyMs: number;
  fundingPeriodMs: number;
  premiumTwap: number;
  indexPrice: number;
  markPrice: number | null;
  estimatedFundingRate: number;
  nextFundingTimestampMs: number;
  session: SessionState;
}
export interface Orderbook {
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  bidsTotalSize: number;
  asksTotalSize: number;
  nonce: bigint;
  bestBidPrice?: number | null;
  bestAskPrice?: number | null;
  midPrice?: number | null;
}
export interface SessionSchedule extends SessionState {
  id: string;
  name: string;
  timezone: string;
  hours: string;
  marketIds: string[];
  upcoming: { opensAt: number; closesAt: number }[];
}
export interface FundingPoint {
  marketId: string;
  timestamp: number;
  eventTimestamp: number;
  longFundingRate: number;
  shortFundingRate: number;
  cumulativeLongFundingRate: number;
  cumulativeShortFundingRate: number;
  txDigest: string;
}
export interface AccountCap {
  walletAddress: string;
  accountId: bigint;
  collateralCoinType: string;
  collateral: bigint;
  objectId: string;
  objectVersion: number;
  objectDigest: string;
  accountObjectId: string;
  accountObjectInitialSharedVersion: bigint;
  isAgent: boolean;
  whitelistedAgentCapIds: string[];
}
export interface PendingOrder {
  orderId: bigint;
  clientOrderId: bigint | null;
  side: 0 | 1;
  currentSize: bigint;
  initialSize: bigint;
}
export interface Position {
  marketId: string;
  baseAssetAmount: number;
  entryPrice: number;
  collateral: number;
  collateralUsd: number;
  quoteAssetNotionalAmount: number;
  cumFundingRateLong: number;
  cumFundingRateShort: number;
  asksQuantity: number;
  bidsQuantity: number;
  leverage: number;
  marginRatio: number;
  freeMarginUsd: number;
  freeCollateral: number;
  liquidationPrice: number;
  unrealizedFundingsUsd: number;
  unrealizedPnlUsd: number;
  pendingOrders: PendingOrder[];
}
export interface AccountState {
  accountId: bigint;
  totalEquityUsd: number;
  availableCollateral: number;
  availableCollateralUsd: number;
  totalUnrealizedFundingsUsd: number;
  totalUnrealizedPnlUsd: number;
  positions: Position[];
}
export interface DetailedTrade {
  accountId: bigint;
  marketId: string;
  timestamp: number;
  txDigest: string;
  side: string;
  tradeType: string;
  size: number;
  price: number;
  tradeValueUsd: number;
  feeUsd: number;
  realizedPnlUsd: number;
}
export type GasMode = "sui" | "gas-pool" | "dynamic-gas";
export interface SponsorConfig {
  walletAddress: string;
  bytes: string;
  signature: string;
  gasBudget?: bigint;
}
export interface BuiltTransaction {
  txKind: string;
  sponsorSignature: string | null;
}

export interface AccountOrderEvent {
  timestamp: number;
  txDigest: string;
  marketId: string;
  eventType: string;
  side: 0 | 1;
  price: number;
  size: number;
  orderId?: string;
  pnl?: number;
  fees?: number;
  slTp?: {
    stopLossPrice?: number;
    takeProfitPrice?: number;
    limitOrderId?: bigint;
  };
  stopOrder?: { stopIndexPrice: number };
}
