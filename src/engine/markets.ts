import type { MarketConfig } from "../config/schema";
import { AF_SCALE, lighterToInt } from "../core/units";
import { ceilDiv } from "../domain/types";
import type { AfMarket } from "../venues/aftermath";
import type { Market } from "../venues/lighter";

export function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
export function lcm(a: bigint, b: bigint): bigint {
  if (a <= 0n || b <= 0n) throw new Error("Positive increments required");
  return (a / gcd(a, b)) * b;
}
export function convertExact(value: bigint, from: bigint, to: bigint): bigint {
  if (from <= 0n || to <= 0n || (value * to) % from !== 0n)
    throw new Error("Inexact unit conversion");
  return (value * to) / from;
}
export interface ResolvedMarket {
  config: MarketConfig;
  af: AfMarket;
  lighter: Market;
  jointStep: bigint;
  minBase: bigint;
  minNotional: bigint;
  toLighter(base: bigint): bigint;
  toAf(base: bigint): bigint;
  minimumAt(price: bigint): bigint;
}
function one<T>(candidates: T[], name: string): T {
  if (candidates.length !== 1)
    throw new Error(
      `${name}: ${candidates.length ? "ambiguous" : "missing"} market`,
    );
  return candidates[0] as T;
}
function baseSymbol(m: AfMarket): string {
  return (m.baseSymbol || m.symbol.split("/")[0] || m.symbol)
    .replace(/USD$/, "")
    .toUpperCase();
}
export function resolveMarkets(
  configs: readonly MarketConfig[],
  afMarkets: readonly AfMarket[],
  lighterMarkets: readonly Market[],
): ResolvedMarket[] {
  const resolved = configs
    .filter((c) => c.enabled)
    .map((config) => {
      const af = one(
        afMarkets.filter((m) =>
          config.aftermath.marketId === "auto"
            ? baseSymbol(m) === config.symbol
            : m.id === config.aftermath.marketId,
        ),
        `AF ${config.symbol}`,
      );
      const lighter = one(
        lighterMarkets.filter((m) =>
          config.lighter.marketId === "auto"
            ? m.symbol === config.symbol
            : m.marketId === config.lighter.marketId,
        ),
        `Lighter ${config.symbol}`,
      );
      if (lighter.status !== "active" || lighter.marketType !== "perp")
        throw new Error("Lighter market must be an active perp");
      const scale = 10n ** BigInt(lighter.sizeDecimals);
      // Sub-nanobase Lighter steps still share a 1e9 representable grid with AF.
      const jointStep = lcm(af.lotInt, AF_SCALE / gcd(AF_SCALE, scale));
      const minBase = lighterToInt(lighter.minBaseAmount, 9, "up");
      const afMinimum = BigInt(Math.ceil(af.minOrderUsd * Number(AF_SCALE)));
      const lighterMinimum = lighterToInt(lighter.minQuoteAmount, 9, "up");
      const minNotional =
        afMinimum > lighterMinimum ? afMinimum : lighterMinimum;
      return {
        config,
        af,
        lighter,
        jointStep,
        minBase,
        minNotional,
        toLighter: (base: bigint) => convertExact(base, AF_SCALE, scale),
        toAf: (base: bigint) => convertExact(base, scale, AF_SCALE),
        minimumAt: (price: bigint) => {
          if (price <= 0n)
            throw new Error("Positive minimum reference price required");
          const quoteBase = ceilDiv(minNotional * AF_SCALE, price);
          return (
            ceilDiv(minBase > quoteBase ? minBase : quoteBase, jointStep) *
            jointStep
          );
        },
      };
    });
  if (
    new Set(resolved.map((m) => m.af.id)).size !== resolved.length ||
    new Set(resolved.map((m) => m.lighter.marketId)).size !== resolved.length
  )
    throw new Error("Multiple configured symbols resolve to one market");
  return resolved;
}
