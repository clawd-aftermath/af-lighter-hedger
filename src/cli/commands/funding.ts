import type { Command } from "commander";
import { resolveMarkets } from "../../engine/markets";
import {
  defaultMarket,
  type OperatorDependencies,
  type OperatorOptions,
  operatorClients,
  operatorSettings,
} from "../../ops/operator";
import { hourlyFundingRate } from "../../venues/aftermath/markets";
import { historyHourly } from "../../venues/lighter/funding";
import { catalog } from "./markets";

export async function fundingRows(
  options: OperatorOptions & { markets?: string },
  deps: OperatorDependencies,
) {
  const { config, markets } = operatorSettings(options);
  const clients = operatorClients(config, deps);
  const data = await catalog(clients);
  const selected = options.markets
    ? options.markets.split(",").map((s) => s.trim().toUpperCase())
    : markets.filter((m) => m.enabled).map((m) => m.symbol);
  if (selected.some((s) => !s)) throw new Error("Empty funding symbol");
  const configs = selected.map((symbol) => ({
    ...(markets.find((m) => m.symbol === symbol) ?? defaultMarket(symbol)),
    enabled: true,
  }));
  const resolved = resolveMarkets(configs, data.af, data.lighter);
  const rows = [];
  for (const m of resolved) {
    const history = await clients.lighterFunding(m.lighter.marketId);
    const latest = history.reduce<(typeof history)[number] | undefined>(
      (last, r) => (!last || r.timestamp > last.timestamp ? r : last),
      undefined,
    );
    const afHourly =
      (hourlyFundingRate(m.af) * 3600000) / m.af.fundingFrequencyMs;
    const lHourly = latest ? historyHourly(latest) : null;
    rows.push({
      symbol: m.config.symbol,
      afHourlyPct: afHourly * 100,
      afAprPct: afHourly * 8760 * 100,
      lighterHourlyPct: lHourly === null ? null : lHourly * 100,
      lighterAprPct: lHourly === null ? null : lHourly * 8760 * 100,
      afNextSettlement: new Date(m.af.nextFundingTimestampMs).toISOString(),
      lighterNextSettlement: new Date(
        (Math.floor((deps.now ?? Date.now)() / 3600000) + 1) * 3600000,
      ).toISOString(),
      lighterFundingAsOf: latest
        ? new Date(latest.timestamp * 1000).toISOString()
        : null,
    });
  }
  return rows;
}

export async function funding(
  options: OperatorOptions & { markets?: string; watch?: boolean },
  deps: OperatorDependencies,
) {
  const write = deps.write ?? console.log;
  do {
    if (deps.signal?.aborted) return;
    const rows = await fundingRows(options, deps);
    write(
      "SYMBOL | AF %/h | AF APR % | Lighter last %/h | Lighter APR % | AF next UTC | Lighter next UTC | Lighter rate as of UTC",
    );
    for (const r of rows)
      write(
        `${r.symbol} | ${r.afHourlyPct.toFixed(6)} | ${r.afAprPct.toFixed(2)} | ${r.lighterHourlyPct?.toFixed(6) ?? "unknown"} | ${r.lighterAprPct?.toFixed(2) ?? "unknown"} | ${r.afNextSettlement} | ${r.lighterNextSettlement} | ${r.lighterFundingAsOf ?? "unknown"}`,
      );
    write(
      "AF is estimated; Lighter is last settled. APR = hourly rate × 8760, without compounding. Lighter settles at each hour mark; AF next time is venue-reported.",
    );
    if (!options.watch) return;
    await (
      deps.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(done, ms);
          function done() {
            clearTimeout(timer);
            deps.signal?.removeEventListener("abort", done);
            resolve();
          }
          deps.signal?.addEventListener("abort", done, { once: true });
          if (deps.signal?.aborted) done();
        }))
    )(30000);
  } while (!deps.signal?.aborted);
}
export function registerFunding(
  program: Command,
  getDeps: () => OperatorDependencies,
) {
  program
    .command("funding")
    .description("Normalized funding and next settlement times")
    .option("--config <path>", "Runtime YAML")
    .option("--markets-file <path>", "Market YAML")
    .option(
      "--markets <symbols>",
      "Comma-separated symbols listed on both venues",
    )
    .option("--watch", "Refresh every 30 seconds; Ctrl-C stops")
    .action(
      (options: OperatorOptions & { markets?: string; watch?: boolean }) =>
        funding(options, getDeps()),
    );
}
