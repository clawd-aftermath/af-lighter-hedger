import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Command } from "commander";

type RecordLine = Record<string, unknown>;
const metrics = [
  "premiumBeforeBp",
  "premiumAfterBp",
  "fundingBeforeHourly",
  "fundingAfterHourly",
] as const;
type Metric = (typeof metrics)[number];
type Projection = Record<Metric, number>;
interface Accumulator {
  quotePlans: number;
  weightedMs: number;
  sums: Projection;
  absoluteSums: Projection;
  positiveMs: number;
  negativeMs: number;
  improvedPlans: number;
  unchangedPlans: number;
  worsenedPlans: number;
  fills: number;
  hedges: number;
  profitFloorPlans: number;
  floorSides: Set<string>;
  active?: { ts: number; values: Projection };
}

export async function summarizeImpact(
  records: Iterable<RecordLine> | AsyncIterable<RecordLine>,
) {
  const markets = new Map<string, Accumulator>();
  let end = -Infinity;
  const get = (market: string) => {
    let row = markets.get(market);
    if (!row) {
      row = {
        quotePlans: 0,
        weightedMs: 0,
        sums: {
          premiumBeforeBp: 0,
          premiumAfterBp: 0,
          fundingBeforeHourly: 0,
          fundingAfterHourly: 0,
        },
        absoluteSums: {
          premiumBeforeBp: 0,
          premiumAfterBp: 0,
          fundingBeforeHourly: 0,
          fundingAfterHourly: 0,
        },
        positiveMs: 0,
        negativeMs: 0,
        improvedPlans: 0,
        unchangedPlans: 0,
        worsenedPlans: 0,
        fills: 0,
        hedges: 0,
        profitFloorPlans: 0,
        floorSides: new Set(),
      };
      markets.set(market, row);
    }
    return row;
  };
  const finish = (row: Accumulator, ts: number) => {
    if (!row.active) return;
    const ms = ts - row.active.ts;
    row.weightedMs += ms;
    for (const key of metrics) {
      row.sums[key] += row.active.values[key] * ms;
      row.absoluteSums[key] += Math.abs(row.active.values[key]) * ms;
    }
    if (row.active.values.premiumBeforeBp > 0) row.positiveMs += ms;
    if (row.active.values.premiumBeforeBp < 0) row.negativeMs += ms;
    row.active = undefined;
  };
  for await (const record of records) {
    const ts =
      typeof record.ts === "number"
        ? record.ts
        : typeof record.ts === "string"
          ? Date.parse(record.ts)
          : NaN;
    if (!Number.isFinite(ts) || ts < end)
      throw new Error(
        "Run log requires valid timestamps in chronological order",
      );
    end = ts;
    if (
      record.type === "run_summary" ||
      (record.type === "fail_closed" &&
        (!record.market || record.market === "all"))
    )
      for (const row of markets.values()) finish(row, ts);
    if (typeof record.market !== "string" || record.market === "all") continue;
    const row = get(record.market);
    if (record.type === "fill") row.fills++;
    if (record.type === "hedge_sent") row.hedges++;
    if (
      record.type === "fail_closed" ||
      (record.type === "market_status" &&
        typeof record.status === "string" &&
        record.status.startsWith("paused")) ||
      (record.type === "af_tx" &&
        (record.kind === "cancel" || record.status === "failure"))
    )
      finish(row, ts);
    if (record.type !== "quote_plan") continue;
    finish(row, ts);
    const count =
      record.restingOrders ??
      (typeof record.ordersToPlace === "number" &&
      typeof record.ordersToKeep === "number"
        ? record.ordersToPlace + record.ordersToKeep
        : NaN);
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0)
      throw new Error(`Invalid resting order count for ${record.market}`);
    if (!count) continue;
    const values = {} as Projection;
    for (const key of metrics) {
      const value = record[key];
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(
          `Missing or invalid ${key} for ${record.market}; use a run log with funding-impact metrics`,
        );
      values[key] = value;
    }
    row.quotePlans++;
    const change =
      Math.abs(values.premiumAfterBp) - Math.abs(values.premiumBeforeBp);
    if (Math.abs(change) <= 1e-9) row.unchangedPlans++;
    else if (change < 0) row.improvedPlans++;
    else row.worsenedPlans++;
    if (record.profitFloorLimited === true) {
      row.profitFloorPlans++;
      if (typeof record.side === "string") row.floorSides.add(record.side);
    }
    row.active = { ts, values };
  }
  for (const row of markets.values()) finish(row, end);
  return [...markets]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([market, row]) => {
      const mean = (sums: Projection, key: Metric) =>
        row.weightedMs > 0 ? sums[key] / row.weightedMs : null;
      const before = mean(row.absoluteSums, "fundingBeforeHourly");
      const after = mean(row.absoluteSums, "fundingAfterHourly");
      const share = (ms: number) =>
        row.weightedMs > 0 ? (ms / row.weightedMs) * 100 : null;
      return {
        market,
        quotePlansWithRestingOrders: row.quotePlans,
        weightedSeconds: row.weightedMs / 1000,
        absolutePremiumBeforeBp: mean(row.absoluteSums, "premiumBeforeBp"),
        absolutePremiumAfterBp: mean(row.absoluteSums, "premiumAfterBp"),
        absoluteFundingBeforeHourly: before,
        absoluteFundingAfterHourly: after,
        absoluteFundingBeforeAprPct:
          before === null ? null : before * 8760 * 100,
        absoluteFundingAfterAprPct: after === null ? null : after * 8760 * 100,
        signedPremiumBeforeBp: mean(row.sums, "premiumBeforeBp"),
        signedPremiumAfterBp: mean(row.sums, "premiumAfterBp"),
        signedFundingBeforeHourly: mean(row.sums, "fundingBeforeHourly"),
        signedFundingAfterHourly: mean(row.sums, "fundingAfterHourly"),
        premiumPositiveTimePct: share(row.positiveMs),
        premiumNegativeTimePct: share(row.negativeMs),
        premiumZeroTimePct: share(
          row.weightedMs - row.positiveMs - row.negativeMs,
        ),
        improvedPlans: row.improvedPlans,
        unchangedPlans: row.unchangedPlans,
        worsenedPlans: row.worsenedPlans,
        premiumRemovedPct:
          row.absoluteSums.premiumBeforeBp > 0
            ? (1 -
                row.absoluteSums.premiumAfterBp /
                  row.absoluteSums.premiumBeforeBp) *
              100
            : null,
        fills: row.fills,
        hedges: row.hedges,
        profitFloorPlans: row.profitFloorPlans,
        note: row.profitFloorPlans
          ? `Profit floor kept ${row.profitFloorPlans} quote plan(s) ${row.floorSides.size === 1 && row.floorSides.has("ASK") ? "above" : row.floorSides.size === 1 && row.floorSides.has("BID") ? "below" : "away from"} the zero-premium price.`
          : null,
      };
    });
}

async function* readLog(file: string): AsyncGenerator<RecordLine> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`Invalid NDJSON at line ${lineNumber}`);
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Invalid log record at line ${lineNumber}`);
      yield value as RecordLine;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

export function registerMeasure(
  program: Command,
  getDeps: () => { write?: (text: string) => void },
) {
  program
    .command("measure")
    .description("Measure run-log metrics")
    .command("impact")
    .description(
      "Projected book-mid premium with and without the bot's resting quotes and the implied hourly funding",
    )
    .requiredOption("--file <path>", "NDJSON run log")
    .option("--json", "Emit structured metrics")
    .action(async (options: { file: string; json?: boolean }) => {
      const rows = await summarizeImpact(readLog(options.file));
      const write = getDeps().write ?? console.log;
      if (options.json) {
        write(JSON.stringify(rows, null, 2));
        return;
      }
      write(
        "Projected book-mid premium with and without the bot's resting quotes and the implied hourly funding. Headlines use time-weighted mean absolute values; signed means are separate. Means weight resting-order plans by elapsed log time through the next plan or log end, excluding pauses/cancels. APR = absolute hourly fraction × 8760; removed = reduction in time-weighted absolute premium. Plan counts compare absolute premium with 1e-9 bp tolerance. Time shares use the outside premium. Hedges count sends.",
      );
      const number = (value: number | null, digits = 2) =>
        value === null ? "n/a" : value.toFixed(digits);
      const hourlyPct = (value: number | null) =>
        number(value === null ? null : value * 100, 6);
      for (const row of rows) {
        write(
          `${row.market} | plans=${row.quotePlansWithRestingOrders} | weighted=${number(row.weightedSeconds)}s | |premium|=${number(row.absolutePremiumBeforeBp)} → ${number(row.absolutePremiumAfterBp)} bp | |funding|=${hourlyPct(row.absoluteFundingBeforeHourly)} → ${hourlyPct(row.absoluteFundingAfterHourly)} %/h | APR=${number(row.absoluteFundingBeforeAprPct)} → ${number(row.absoluteFundingAfterAprPct)}% | removed=${number(row.premiumRemovedPct)}% | improvedPlans=${row.improvedPlans} | unchangedPlans=${row.unchangedPlans} | worsenedPlans=${row.worsenedPlans} | fills=${row.fills} | hedges=${row.hedges}`,
        );
        write(
          `  signed premium=${number(row.signedPremiumBeforeBp)} → ${number(row.signedPremiumAfterBp)} bp | signed funding=${hourlyPct(row.signedFundingBeforeHourly)} → ${hourlyPct(row.signedFundingAfterHourly)} %/h | outside premium time: positive=${number(row.premiumPositiveTimePct)}% | negative=${number(row.premiumNegativeTimePct)}% | zero=${number(row.premiumZeroTimePct)}%`,
        );
        if (row.note) write(`  ${row.note}`);
      }
      if (!rows.length) write("No market records found.");
    });
}
