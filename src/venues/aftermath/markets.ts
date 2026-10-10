import type { AfHttp } from "./http";
import {
  type AfMarket,
  type FundingPoint,
  type MarketData,
  type MarketMetadata,
  type MarketPrice,
  marketSchema,
  type Orderbook,
  type RawMarket,
  type SessionSchedule,
} from "./types";

function safeInteger(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("Unsafe market integer");
  return n;
}
export function normalizeMarket(
  input: unknown,
  metadata: MarketMetadata | null = null,
  price?: MarketPrice,
): AfMarket {
  const m = marketSchema.parse(input);
  const p = m.marketParams;
  if (
    p.tickSize <= 0n ||
    p.lotSize <= 0n ||
    p.fundingFrequencyMs <= 0n ||
    p.fundingPeriodMs <= 0n
  )
    throw new Error("Invalid market increments or funding periods");
  return {
    id: m.objectId,
    packageId: m.packageId,
    symbol: metadata?.symbol ?? p.baseAssetSymbol,
    baseSymbol: p.baseAssetSymbol.replace(/USD$/, ""),
    category: metadata?.category ?? null,
    tickInt: p.tickSize,
    lotInt: p.lotSize,
    minOrderUsd: p.minOrderUsdValue,
    makerFee: p.makerFee,
    takerFee: p.takerFee,
    priorityTakerFee: p.priorityTakerFee ?? null,
    imr: p.marginRatioInitial,
    mmr: p.marginRatioMaintenance,
    maxLeverage: 1 / p.marginRatioInitial,
    maxOpenInterestBase: p.maxOpenInterest,
    maxOpenInterestThresholdBase: p.maxOpenInterestThreshold,
    maxOpenInterestPositionPercent: p.maxOpenInterestPositionPercent,
    maxPendingOrders: safeInteger(p.maxPendingOrders),
    fundingFrequencyMs: safeInteger(p.fundingFrequencyMs),
    fundingPeriodMs: safeInteger(p.fundingPeriodMs),
    premiumTwap: m.marketState.premiumTwap,
    indexPrice: m.indexPrice,
    markPrice: price?.markPrice ?? m.markPrice ?? null,
    estimatedFundingRate: m.estimatedFundingRate,
    nextFundingTimestampMs: safeInteger(m.nextFundingTimestampMs),
    session: metadata?.session
      ? {
          isOpen: metadata.session.isOpen,
          nextTransitionAt: metadata.session.nextTransitionAt ?? null,
        }
      : { isOpen: true, nextTransitionAt: null },
  };
}
// f and rho are the market's dynamic funding frequency and period. The live
// estimatedFundingRate uses this ratio (frequency is currently one hour).
export function hourlyFundingRate(m: AfMarket): number {
  return (
    (m.premiumTwap / m.indexPrice) * (m.fundingFrequencyMs / m.fundingPeriodMs)
  );
}
export class AfMarkets {
  constructor(readonly http: AfHttp) {}
  async allMarkets(collateralCoinType: string): Promise<RawMarket[]> {
    const r = await this.http.read<{ markets: unknown[] }>(
      "/api/perpetuals/all-markets",
      { collateralCoinType },
    );
    return r.markets.map((m) => marketSchema.parse(m));
  }
  async markets(marketIds?: string[]): Promise<MarketData[]> {
    const r = await this.http.read<{
      marketDatas: { market: unknown; metadata: MarketMetadata | null }[];
    }>("/api/perpetuals/markets", { marketIds });
    return r.marketDatas.map((d) => ({
      ...d,
      market: marketSchema.parse(d.market),
    }));
  }
  async prices(marketIds: string[]): Promise<MarketPrice[]> {
    return (
      await this.http.read<{ marketsPrices: MarketPrice[] }>(
        "/api/perpetuals/markets/prices",
        { marketIds },
      )
    ).marketsPrices;
  }
  async orderbooks(
    marketIds: string[],
  ): Promise<{ marketId: string; orderbook: Orderbook }[]> {
    return (
      await this.http.read<{
        orderbooks: { marketId: string; orderbook: Orderbook }[];
      }>("/api/perpetuals/markets/orderbooks", { marketIds })
    ).orderbooks;
  }
  async sessions(days = 7): Promise<SessionSchedule[]> {
    if (!Number.isInteger(days) || days < 1 || days > 14)
      throw new Error("Session days must be 1..14");
    return (
      await this.http.read<{ sessions: SessionSchedule[] }>(
        "/api/perpetuals/markets/sessions",
        { days },
      )
    ).sessions;
  }
  async fundingHistory(
    marketId: string,
    fromTimestamp: number,
    toTimestamp: number,
    limit?: number,
  ): Promise<FundingPoint[]> {
    return (
      await this.http.read<{ history: FundingPoint[] }>(
        "/api/perpetuals/market/funding-history",
        { marketId, fromTimestamp, toTimestamp, limit },
      )
    ).history;
  }
  async normalized(marketIds?: string[]): Promise<AfMarket[]> {
    const datas = await this.markets(marketIds);
    const prices = new Map(
      (await this.prices(datas.map((d) => d.market.objectId))).map((p) => [
        p.marketId,
        p,
      ]),
    );
    return datas.map((d) =>
      normalizeMarket(d.market, d.metadata, prices.get(d.market.objectId)),
    );
  }
}
export function marketPackageIds(
  markets: readonly Pick<RawMarket, "packageId">[],
): string[] {
  return [...new Set(markets.map((m) => m.packageId))];
}
