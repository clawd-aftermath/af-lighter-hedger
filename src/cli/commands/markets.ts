import type { Command } from "commander";
import { AF_SCALE } from "../../core/units";
import { type ResolvedMarket, resolveMarkets } from "../../engine/markets";
import {
  type Check,
  CheckFailure,
  defaultMarket,
  type OperatorClients,
  type OperatorDependencies,
  type OperatorOptions,
  operatorClients,
  operatorSettings,
  printChecks,
} from "../../ops/operator";
import { oiCapacity } from "../../risk/limits";
import {
  hourlyFundingRate,
  normalizeMarket,
} from "../../venues/aftermath/markets";
import type { MarketData } from "../../venues/aftermath/types";
import { historyHourly } from "../../venues/lighter/funding";

export interface MarketRow {
  symbol: string;
  configured: boolean;
  enabled: boolean;
  exclusion: string | null;
  afHourlyPct: number;
  afAprPct: number;
  lighterHourlyPct: number | null;
  lighterAprPct: number | null;
  shortAfLongLighterHourlyPct: number | null;
  longAfShortLighterHourlyPct: number | null;
  rhoHours: number;
  afSpreadBps: number | null;
  afBidDepth1PctUsd: number | null;
  afAskDepth1PctUsd: number | null;
  lighterSpreadBps: number | null;
  lighterBidDepthUsd: number | null;
  lighterAskDepthUsd: number | null;
  lighterSell500Bps: number | null;
  lighterBuy500Bps: number | null;
  afOiHeadroomUsd: number | null;
  afMinOrderUsd: number;
  lighterMinBase: string;
  lighterMinQuoteUsd: string;
  session: string;
  afNextSettlement: string;
  lighterNextSettlement: string;
  lighterFundingAsOf: string | null;
  warnings: string[];
}
export interface Level {
  price: number;
  size: number;
}
export function bookMetrics(
  bids: Level[],
  asks: Level[],
  clipUsd: number,
  bps = 100,
) {
  const valid = (levels: Level[], ascending: boolean) =>
    levels
      .filter(
        (l) =>
          Number.isFinite(l.price) &&
          l.price > 0 &&
          Number.isFinite(l.size) &&
          l.size > 0,
      )
      .sort((a, b) => (ascending ? a.price - b.price : b.price - a.price));
  bids = valid(bids, false);
  asks = valid(asks, true);
  const bid = bids[0]?.price;
  const ask = asks[0]?.price;
  if (!bid || !ask || bid >= ask)
    throw new Error("Missing or crossed order book");
  const mid = (bid + ask) / 2;
  const depth = (levels: Level[]) =>
    levels
      .filter((l) => Math.abs(l.price / mid - 1) * 10000 <= bps)
      .reduce((s, l) => s + l.price * l.size, 0);
  const impact = (levels: Level[]) => {
    let remaining = clipUsd / mid;
    let worst = 0;
    for (const l of levels) {
      const take = Math.min(remaining, l.size);
      if (take > 0) worst = Math.abs(l.price / mid - 1) * 10000;
      remaining -= take;
      if (remaining <= 1e-12) return worst;
    }
    return null;
  };
  return {
    mid,
    spreadBps: ((ask - bid) / mid) * 10000,
    bidDepthUsd: depth(bids),
    askDepthUsd: depth(asks),
    sellClipBps: impact(bids),
    buyClipBps: impact(asks),
  };
}
export function oiHeadroom(data: MarketData): number | null {
  const oi = Number(data.market.marketState.openInterest);
  if (!Number.isFinite(oi) || oi < 0) return null;
  const af = normalizeMarket(data.market, data.metadata);
  const units = (n: number) => BigInt(Math.floor(n * Number(AF_SCALE)));
  return (
    (Number(
      oiCapacity({
        openInterest: units(oi),
        maxOpenInterest: units(af.maxOpenInterestBase),
        position: 0n,
        pendingIncrease: 0n,
        halfOiThreshold: units(af.maxOpenInterestThresholdBase),
      }),
    ) /
      Number(AF_SCALE)) *
    af.indexPrice
  );
}
export async function catalog(clients: OperatorClients) {
  const [datas, lighter] = await Promise.all([
    clients.afMarkets(),
    clients.lighterMarkets(),
  ]);
  return {
    datas,
    af: datas.map((d) => normalizeMarket(d.market, d.metadata)),
    lighter,
  };
}
export async function marketRows(
  options: OperatorOptions & { all?: boolean; markets?: string },
  deps: OperatorDependencies,
) {
  const { config, markets } = operatorSettings(options);
  const clients = operatorClients(config, deps);
  const data = await catalog(clients);
  const selected = options.markets
    ?.split(",")
    .map((s) => s.trim().toUpperCase());
  if (selected?.some((s) => !s || !data.lighter.some((m) => m.symbol === s)))
    throw new Error("Unknown --markets symbol");
  const symbols = [...new Set(data.lighter.map((m) => m.symbol))];
  const rows: MarketRow[] = [];
  for (const symbol of symbols) {
    if (selected && !selected.includes(symbol)) continue;
    const configured = markets.find((m) => m.symbol === symbol);
    // Explicit configured IDs take precedence, exactly as in the engine.
    const entry = { ...(configured ?? defaultMarket(symbol)), enabled: true };
    let resolved: ResolvedMarket | undefined;
    try {
      resolved = resolveMarkets([entry], data.af, data.lighter)[0];
    } catch {
      continue;
    }
    if (!resolved) continue;
    const { af, lighter } = resolved;
    if (!options.all && symbol === "BYD") continue;
    const raw = data.datas.find(
      (d) => d.market.objectId === af.id,
    ) as MarketData;
    const warnings: string[] = [];
    const snapshot = async <T>(name: string, read: () => Promise<T>) => {
      try {
        return await read();
      } catch {
        warnings.push(`${name} unavailable; retry before trading`);
        return null;
      }
    };
    const [afDepth, lDepth, history] = await Promise.all([
      snapshot("AF book", async () => {
        const book = (await clients.afBooks([af.id])).find(
          (b) => b.marketId === af.id,
        )?.orderbook;
        if (!book) throw new Error("Missing book");
        return bookMetrics(book.bids, book.asks, 500);
      }),
      snapshot("Lighter book", async () => {
        const book = await clients.lighterBook(lighter.marketId);
        return bookMetrics(
          book.bids.map((l) => ({
            price: Number(l.price),
            size: Number(l.remainingBaseAmount),
          })),
          book.asks.map((l) => ({
            price: Number(l.price),
            size: Number(l.remainingBaseAmount),
          })),
          500,
          config.lighter.maxSlippageBps,
        );
      }),
      snapshot("Lighter funding", () =>
        clients.lighterFunding(lighter.marketId),
      ),
    ]);
    const funding = history ?? [];
    const latest = funding.reduce<(typeof funding)[number] | undefined>(
      (last, row) => (!last || row.timestamp > last.timestamp ? row : last),
      undefined,
    );
    const afHourly = (hourlyFundingRate(af) * 3600000) / af.fundingFrequencyMs;
    const lighterHourly = latest ? historyHourly(latest) : null;
    const diff = lighterHourly === null ? null : afHourly - lighterHourly;
    rows.push({
      symbol,
      configured: !!configured,
      enabled: configured?.enabled ?? false,
      exclusion:
        symbol === "BYD" ? "different underlying; do not enable" : null,
      afHourlyPct: afHourly * 100,
      afAprPct: afHourly * 8760 * 100,
      lighterHourlyPct: lighterHourly === null ? null : lighterHourly * 100,
      lighterAprPct: lighterHourly === null ? null : lighterHourly * 8760 * 100,
      shortAfLongLighterHourlyPct: diff === null ? null : diff * 100,
      longAfShortLighterHourlyPct: diff === null ? null : -diff * 100,
      rhoHours: af.fundingPeriodMs / 3600000,
      afSpreadBps: afDepth?.spreadBps ?? null,
      afBidDepth1PctUsd: afDepth?.bidDepthUsd ?? null,
      afAskDepth1PctUsd: afDepth?.askDepthUsd ?? null,
      lighterSpreadBps: lDepth?.spreadBps ?? null,
      lighterBidDepthUsd: lDepth?.bidDepthUsd ?? null,
      lighterAskDepthUsd: lDepth?.askDepthUsd ?? null,
      lighterSell500Bps: lDepth?.sellClipBps ?? null,
      lighterBuy500Bps: lDepth?.buyClipBps ?? null,
      afOiHeadroomUsd: oiHeadroom(raw),
      afMinOrderUsd: af.minOrderUsd,
      lighterMinBase: lighter.minBaseAmount,
      lighterMinQuoteUsd: lighter.minQuoteAmount,
      session: af.session.isOpen ? "open" : "closed",
      afNextSettlement: new Date(af.nextFundingTimestampMs).toISOString(),
      lighterNextSettlement: new Date(
        (Math.floor((deps.now ?? Date.now)() / 3600000) + 1) * 3600000,
      ).toISOString(),
      lighterFundingAsOf: latest
        ? new Date(latest.timestamp * 1000).toISOString()
        : null,
      warnings,
    });
  }
  if (selected?.some((s) => !rows.some((r) => r.symbol === s)))
    throw new Error("Selected symbol cannot resolve on both venues");
  return rows.sort(
    (a, b) =>
      Math.abs(b.shortAfLongLighterHourlyPct ?? 0) -
      Math.abs(a.shortAfLongLighterHourlyPct ?? 0),
  );
}
async function inspectMarket(
  symbol: string,
  options: OperatorOptions,
  deps: OperatorDependencies,
) {
  symbol = symbol.toUpperCase();
  const { config, markets } = operatorSettings(options);
  const clients = operatorClients(config, deps);
  const checks: Check[] = [];
  const add = (
    status: Check["status"],
    name: string,
    reason: string,
    hint: string,
  ) => checks.push({ status, name, reason, hint });
  const entry = markets.find((m) => m.symbol === symbol);
  if (!entry) {
    add(
      "FAIL",
      "entry",
      `${symbol} is not configured`,
      "Add one entry to the markets YAML",
    );
    printChecks(checks, deps);
    return;
  }
  if (!entry.enabled)
    add(
      "WARN",
      "enabled",
      "Market is disabled",
      "Enable only after validation",
    );
  const data = await catalog(clients);
  let resolved: ResolvedMarket | undefined;
  try {
    resolved = resolveMarkets(
      [{ ...entry, enabled: true }],
      data.af,
      data.lighter,
    )[0];
  } catch {
    add(
      "FAIL",
      "listing",
      "Missing, ambiguous or inactive market",
      "Check symbol and explicit IDs",
    );
    printChecks(checks, deps);
    return;
  }
  if (!resolved) throw new Error("No market resolved");
  const { af, lighter } = resolved;
  add(
    "PASS",
    "listing",
    `AF ${af.id}, Lighter ${lighter.marketId}`,
    "Recheck after venue listing changes",
  );
  const afSymbol = (af.baseSymbol || af.symbol.split("/")[0] || af.symbol)
    .replace(/USD$/, "")
    .toUpperCase();
  add(
    symbol === "BYD" || afSymbol !== symbol || lighter.symbol !== symbol
      ? "FAIL"
      : "WARN",
    "underlying",
    symbol === "BYD"
      ? "Known underlying mismatch: BYD excluded"
      : `${afSymbol}/${lighter.symbol}; matching ticker does not verify index sources`,
    "Compare contract and oracle definitions in both apps",
  );
  const lExtra = data.lighter.find((m) => m.marketId === lighter.marketId);
  if (lExtra?.indexPrice)
    add(
      Math.abs(lExtra.indexPrice / af.indexPrice - 1) * 10000 >
        config.risk.basisBandBp
        ? "WARN"
        : "PASS",
      "index basis",
      `${(Math.abs(lExtra.indexPrice / af.indexPrice - 1) * 10000).toFixed(2)} bp`,
      "Investigate divergent index prices before enabling",
    );
  add(
    "PASS",
    "increments",
    `AF 9 decimals tick=${af.tickInt} lot=${af.lotInt}; Lighter price=${lighter.priceDecimals} size=${lighter.sizeDecimals}; joint base step=${Number(resolved.jointStep) / 1e9}`,
    "Keep sizes on the shared grid",
  );
  const price = BigInt(Math.round(af.indexPrice * 1e9));
  const minimum = (Number(resolved.minimumAt(price)) / 1e9) * af.indexPrice;
  const base =
    (BigInt(Math.floor((entry.clipUsd / af.indexPrice) * 1e9)) /
      resolved.jointStep) *
    resolved.jointStep;
  add(
    base >= resolved.minimumAt(price) ? "PASS" : "FAIL",
    "minimum clip",
    `rounded clip=${(Number(base) / 1e9) * af.indexPrice} USD; minimum=${minimum} USD (AF ${af.minOrderUsd}, Lighter ${lighter.minQuoteAmount} USD / ${lighter.minBaseAmount} base)`,
    "Raise clipUsd above the rounded joint minimum",
  );
  const book = await clients.lighterBook(lighter.marketId);
  const depth = bookMetrics(
    book.bids.map((l) => ({
      price: Number(l.price),
      size: Number(l.remainingBaseAmount),
    })),
    book.asks.map((l) => ({
      price: Number(l.price),
      size: Number(l.remainingBaseAmount),
    })),
    entry.clipUsd,
    config.lighter.maxSlippageBps,
  );
  const good = [depth.buyClipBps, depth.sellClipBps].every(
    (v) => v !== null && v <= config.lighter.maxSlippageBps,
  );
  add(
    good ? "PASS" : "FAIL",
    "hedge depth",
    `buy=${depth.buyClipBps ?? "insufficient"} sell=${depth.sellClipBps ?? "insufficient"} bp for ${entry.clipUsd} USD; limit=${config.lighter.maxSlippageBps} bp`,
    "Reduce clipUsd or wait for more depth",
  );
  const raw = data.datas.find((d) => d.market.objectId === af.id) as MarketData;
  const headroom = oiHeadroom(raw);
  add(
    headroom !== null && headroom >= entry.maxPositionUsd ? "PASS" : "FAIL",
    "OI headroom",
    `${headroom ?? "unknown"} USD for a new flat account; position limit=${entry.maxPositionUsd} USD`,
    "Lower maxPositionUsd; existing positions and orders reduce capacity",
  );
  add(
    af.session.isOpen ? "PASS" : "WARN",
    "session",
    `${af.session.isOpen ? "open" : "closed"}; rho=${af.fundingPeriodMs / 3600000} hours`,
    "Keep pauseWhenSessionClosed enabled",
  );
  const reserve = 1 - config.risk.minMarginHeadroomPct / 100;
  const afMargin =
    reserve > 0 ? (entry.maxPositionUsd * af.imr) / reserve : Infinity;
  const lMargin =
    lExtra?.initialMarginFraction && reserve > 0
      ? (entry.maxPositionUsd * lExtra.initialMarginFraction) / reserve
      : null;
  add(
    lMargin === null || !Number.isFinite(afMargin) ? "WARN" : "PASS",
    "margin estimate",
    `AF >=${afMargin.toFixed(2)} USD; Lighter default margin >=${lMargin?.toFixed(2) ?? "unknown"} USD plus fees, losses and pending orders`,
    "Check actual leverage and available margin in both apps",
  );
  printChecks(checks, deps);
}
export async function checkMarket(
  symbol: string,
  options: OperatorOptions,
  deps: OperatorDependencies,
) {
  try {
    await inspectMarket(symbol, options, deps);
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    printChecks(
      [
        {
          status: "FAIL",
          name: "validation",
          reason: "Configuration, catalog or market snapshot unavailable",
          hint: "Check YAML, endpoints and both venue books; retry before enabling",
        },
      ],
      deps,
    );
  }
}
export function registerMarkets(
  program: Command,
  getDeps: () => OperatorDependencies,
) {
  const markets = program
    .command("markets")
    .description("Discover and validate paired markets");
  const common = (c: Command) =>
    c
      .option("--config <path>", "Runtime YAML")
      .option("--markets-file <path>", "Market YAML");
  common(
    markets
      .command("list")
      .description(
        "List shared active perpetuals, sorted by funding differential",
      ),
  )
    .option("--all", "Include known excluded candidates such as BYD")
    .option("--json", "Emit structured metrics with explicit units")
    .action(
      async (options: OperatorOptions & { all?: boolean; json?: boolean }) => {
        const deps = getDeps();
        const rows = await marketRows(options, deps);
        const write = deps.write ?? console.log;
        if (options.json) write(JSON.stringify(rows, null, 2));
        else {
          write(
            "AF funding is estimated; Lighter funding is last settled. APR is simple annualization, not a forecast. Depth is a snapshot of returned levels.",
          );
          const number = (value: number | null, digits = 2) =>
            value === null ? "unknown" : value.toFixed(digits);
          for (const r of rows) {
            write(
              `${r.symbol} | configured=${r.configured} enabled=${r.enabled} | session=${r.session} | rho=${r.rhoHours}h${r.exclusion ? ` | EXCLUDED: ${r.exclusion}` : ""}`,
            );
            write(
              `  Funding: AF ${number(r.afHourlyPct, 6)} %/h (${number(r.afAprPct)}% APR); Lighter last ${number(r.lighterHourlyPct, 6)} %/h (${number(r.lighterAprPct)}% APR); short-AF/long-L ${number(r.shortAfLongLighterHourlyPct, 6)} %/h; long-AF/short-L ${number(r.longAfShortLighterHourlyPct, 6)} %/h`,
            );
            write(
              `  Books: AF spread ${number(r.afSpreadBps)} bp, 1% depth bid/ask $${number(r.afBidDepth1PctUsd)}/$${number(r.afAskDepth1PctUsd)}; Lighter spread ${number(r.lighterSpreadBps)} bp, bounded depth bid/ask $${number(r.lighterBidDepthUsd)}/$${number(r.lighterAskDepthUsd)}, $500 sell/buy ${number(r.lighterSell500Bps)}/${number(r.lighterBuy500Bps)} bp`,
            );
            write(
              `  Limits: AF OI headroom $${number(r.afOiHeadroomUsd)}, minimum $${r.afMinOrderUsd}; Lighter minimum $${r.lighterMinQuoteUsd} and ${r.lighterMinBase} base. Lighter funding as of ${r.lighterFundingAsOf ?? "unknown"}.`,
            );
            for (const warning of r.warnings) write(`  WARN ${warning}`);
          }
          if (!rows.length)
            write(
              "WARN No active market pair resolved; check venue catalogs and configured IDs.",
            );
        }
      },
    );
  common(
    markets
      .command("check <symbol>")
      .description("Check a configured market before enabling it"),
  ).action((symbol: string, options: OperatorOptions) =>
    checkMarket(symbol, options, getDeps()),
  );
}
