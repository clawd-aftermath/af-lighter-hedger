import { ConfigError } from "../../core/errors";
import type { FundingRateRow, FundingRow, Market } from "./types";
import type { MarketStats } from "./ws";

export interface HourlyFunding {
  marketId: number;
  predictedHourly: number | null;
  lastHourly: number | null;
  interestBaseline: number | null;
  indicative: boolean;
}
function number(value: string): number {
  if (!/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))
    throw new ConfigError("Invalid funding value");
  return Number(value);
}
export function percentHourly(value: string): number {
  return number(value) / 100;
}
export function historyHourly(row: FundingRow): number {
  const rate = number(row.rate);
  if (rate < 0 || (row.direction !== "long" && row.direction !== "short"))
    throw new ConfigError("Invalid unsigned funding row");
  return ((row.direction === "short" ? -1 : 1) * rate) / 100;
}
export function normalizeFunding(
  stats: MarketStats,
  market?: Market,
): HourlyFunding {
  const interest = stats.baseInterestRate ?? market?.baseInterestRate;
  return {
    marketId: stats.marketId,
    predictedHourly:
      stats.currentFundingRate === undefined
        ? null
        : percentHourly(stats.currentFundingRate),
    lastHourly:
      stats.fundingRate === undefined ? null : percentHourly(stats.fundingRate),
    interestBaseline:
      interest === undefined ? null : number(interest) / 100 / 8,
    indicative: false,
  };
}
export function indicativeFunding(row: FundingRateRow): HourlyFunding {
  if (row.exchange.toLowerCase() !== "lighter" || !Number.isFinite(row.rate))
    throw new ConfigError("Expected Lighter funding-rates row");
  // Cross-venue endpoint interval is inferred, not guaranteed by its schema.
  return {
    marketId: row.marketId,
    predictedHourly: row.rate / 8,
    lastHourly: null,
    interestBaseline: null,
    indicative: true,
  };
}
export class LighterFunding {
  private values = new Map<number, HourlyFunding>();
  updateStats(stats: MarketStats, market?: Market): HourlyFunding {
    const result = normalizeFunding(stats, market);
    this.values.set(stats.marketId, result);
    return result;
  }
  updateHistory(marketId: number, rows: FundingRow[]): void {
    const row = rows.reduce<FundingRow | undefined>(
      (last, r) => (!last || r.timestamp > last.timestamp ? r : last),
      undefined,
    );
    if (!row) return;
    const previous = this.values.get(marketId);
    this.values.set(marketId, {
      marketId,
      predictedHourly: previous?.predictedHourly ?? null,
      lastHourly: historyHourly(row),
      interestBaseline: previous?.interestBaseline ?? null,
      indicative: previous?.indicative ?? false,
    });
  }
  get(marketId: number): HourlyFunding {
    return (
      this.values.get(marketId) ?? {
        marketId,
        predictedHourly: null,
        lastHourly: null,
        interestBaseline: null,
        indicative: false,
      }
    );
  }
}
