import { expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeImpact } from "../../src/cli/commands/measure";
import { main } from "../../src/cli/main";

const plan = (ts: number, market = "SOL", before = 100, after = 50) => ({
  type: "quote_plan",
  ts,
  market,
  side: "ASK",
  ordersToPlace: 1,
  ordersToKeep: 0,
  premiumBeforeBp: before,
  premiumAfterBp: after,
  fundingBeforeHourly: before / 10000 / 8,
  fundingAfterHourly: after / 10000 / 8,
});
const log = [
  { type: "run_summary", ts: 0 },
  { ...plan(0), profitFloorLimited: true },
  plan(0, "BTC", -40, -10),
  { type: "fill", ts: 5000, market: "SOL" },
  { type: "hedge_sent", ts: 5000, market: "SOL" },
  { type: "hedge_result", ts: 5000, market: "SOL", status: "filled" },
  { ...plan(10000, "SOL", 200, 0), ordersToPlace: 0, ordersToKeep: 1 },
  { ...plan(20000, "BTC"), ordersToPlace: 0 },
  { type: "market_status", ts: 40000, market: "SOL" },
];

test("impact weights elapsed time, includes kept orders and counts fills and hedge sends", async () => {
  const rows = await summarizeImpact(log);
  expect(rows.map((row) => row.market)).toEqual(["BTC", "SOL"]);
  expect(rows[0]).toMatchObject({
    quotePlansWithRestingOrders: 1,
    weightedSeconds: 20,
    absolutePremiumBeforeBp: 40,
    absolutePremiumAfterBp: 10,
    signedPremiumBeforeBp: -40,
    signedPremiumAfterBp: -10,
    premiumRemovedPct: 75,
  });
  expect(rows[1]).toMatchObject({
    quotePlansWithRestingOrders: 2,
    weightedSeconds: 40,
    absolutePremiumBeforeBp: 175,
    absolutePremiumAfterBp: 12.5,
    fills: 1,
    hedges: 1,
    profitFloorPlans: 1,
    note: "Profit floor kept 1 quote plan(s) above the zero-premium price.",
  });
  expect(rows[1]?.absoluteFundingBeforeHourly).toBeCloseTo(175 / 10000 / 8, 12);
  expect(rows[1]?.absoluteFundingAfterHourly).toBeCloseTo(12.5 / 10000 / 8, 12);
  expect(rows[1]?.absoluteFundingBeforeAprPct).toBeCloseTo(
    (175 / 10000 / 8) * 8760 * 100,
    8,
  );
  expect(rows[1]?.absoluteFundingAfterAprPct).toBeCloseTo(
    (12.5 / 10000 / 8) * 8760 * 100,
    8,
  );
  expect(rows[1]?.premiumRemovedPct).toBeCloseTo((1 - 12.5 / 175) * 100, 8);
});

for (const stop of [
  { type: "fail_closed", market: "all" },
  { type: "af_tx", market: "SOL", kind: "cancel", status: "success" },
  { type: "af_tx", market: "SOL", kind: "quote", status: "failure" },
  { type: "market_status", market: "SOL", status: "paused(stale)" },
  { type: "run_summary" },
])
  test(`impact stops weighting on ${JSON.stringify(stop)}`, async () => {
    const row = (
      await summarizeImpact([
        plan(0),
        { ...stop, ts: 10000 },
        { type: "market_status", ts: 30000, market: "SOL" },
      ])
    )[0];
    expect(row?.weightedSeconds).toBe(10);
  });

test("absolute premium removal survives a sign change without cancellation", async () => {
  const rows = await summarizeImpact([
    plan(0),
    plan(1000, "SOL", -100, -25),
    { type: "market_status", market: "SOL", ts: 2000 },
  ]);
  expect(rows[0]?.absolutePremiumBeforeBp).toBe(100);
  expect(rows[0]?.signedPremiumBeforeBp).toBe(0);
  expect(rows[0]?.premiumRemovedPct).toBe(62.5);
});

test("zero baseline and zero observed duration are unavailable", async () => {
  expect((await summarizeImpact([plan(0)]))[0]).toMatchObject({
    quotePlansWithRestingOrders: 1,
    weightedSeconds: 0,
    absolutePremiumBeforeBp: null,
    absoluteFundingBeforeHourly: null,
    absoluteFundingBeforeAprPct: null,
    signedPremiumBeforeBp: null,
    signedFundingBeforeHourly: null,
    premiumPositiveTimePct: null,
    premiumNegativeTimePct: null,
    premiumZeroTimePct: null,
    premiumRemovedPct: null,
  });
  expect(
    (
      await summarizeImpact([plan(0, "SOL", 0, 0), { type: "end", ts: 1000 }])
    )[0]?.premiumRemovedPct,
  ).toBeNull();
});

test("bid-side floor note and a premium increase retain their direction", async () => {
  const rows = await summarizeImpact([
    { ...plan(0, "SOL", -10, -20), side: "BID", profitFloorLimited: true },
    { type: "end", ts: 1000 },
  ]);
  expect(rows[0]?.premiumRemovedPct).toBe(-100);
  expect(rows[0]?.note).toContain("below the zero-premium price");
});

test("impact refuses legacy metrics, invalid rates and backwards timestamps", async () => {
  await expect(
    summarizeImpact([{ ...plan(0), fundingBeforeHourly: undefined }]),
  ).rejects.toThrow("fundingBeforeHourly");
  await expect(
    summarizeImpact([{ ...plan(0), fundingAfterHourly: Infinity }]),
  ).rejects.toThrow("fundingAfterHourly");
  await expect(summarizeImpact([plan(10), plan(0)])).rejects.toThrow(
    "chronological",
  );
});

test("measure impact CLI reads NDJSON and prints text/JSON without clients", async () => {
  const path = join(import.meta.dir, `.impact-${crypto.randomUUID()}.ndjson`);
  writeFileSync(
    path,
    log
      .map((r) => JSON.stringify({ ...r, ts: new Date(r.ts).toISOString() }))
      .join("\n"),
  );
  const output: string[] = [];
  try {
    for (const json of [false, true]) {
      output.length = 0;
      expect(
        await main(
          [
            "bun",
            "hedger",
            "measure",
            "impact",
            "--file",
            path,
            ...(json ? ["--json"] : []),
          ],
          {
            write: (line) => output.push(line),
            error: (line) => {
              throw new Error(line);
            },
            runtime: async () => {
              throw new Error("Must not create runtime");
            },
          },
        ),
      ).toBe(0);
      if (json) {
        const rows = JSON.parse(output.join("\n"));
        expect(rows[1].weightedSeconds).toBe(40);
        expect(rows[0]).toMatchObject({
          absolutePremiumBeforeBp: 40,
          absolutePremiumAfterBp: 10,
          signedPremiumBeforeBp: -40,
          signedPremiumAfterBp: -10,
          absoluteFundingBeforeHourly: 0.0005,
          absoluteFundingAfterHourly: 0.000125,
          absoluteFundingBeforeAprPct: 438,
          absoluteFundingAfterAprPct: 109.5,
          signedFundingBeforeHourly: -0.0005,
          signedFundingAfterHourly: -0.000125,
          premiumPositiveTimePct: 0,
          premiumNegativeTimePct: 100,
          premiumZeroTimePct: 0,
          improvedPlans: 1,
          unchangedPlans: 0,
          worsenedPlans: 0,
        });
      } else {
        expect(output.join("\n")).toContain("SOL | plans=2");
        expect(output.join("\n")).toContain("|premium|=175.00 → 12.50 bp");
        expect(output.join("\n")).toContain(
          "|funding|=0.218750 → 0.015625 %/h",
        );
        expect(output.join("\n")).toContain(
          "signed premium=-40.00 → -10.00 bp",
        );
        expect(output.join("\n")).toContain(
          "signed funding=-0.050000 → -0.012500 %/h",
        );
        expect(output.join("\n")).toContain(
          "outside premium time: positive=0.00% | negative=100.00%",
        );
        expect(output.join("\n")).toContain(
          "improvedPlans=2 | unchangedPlans=0 | worsenedPlans=0",
        );
        expect(output.join("\n")).toContain("Profit floor kept 1");
      }
    }
    writeFileSync(path, "{bad\n");
    expect(
      await main(["bun", "hedger", "measure", "impact", "--file", path], {
        write: () => {},
        error: (s) => output.push(s),
      }),
    ).toBe(1);
    expect(output.at(-1)).toContain("line 1");
  } finally {
    unlinkSync(path);
  }
});

test("sign flip separates compression magnitude from signed means", async () => {
  const row = (
    await summarizeImpact([
      plan(0, "SOL", 10, 2),
      plan(10000, "SOL", -15, -15),
      { type: "end", ts: 20000 },
    ])
  )[0];
  expect(row).toMatchObject({
    absolutePremiumBeforeBp: 12.5,
    absolutePremiumAfterBp: 8.5,
    signedPremiumBeforeBp: -2.5,
    signedPremiumAfterBp: -6.5,
    premiumPositiveTimePct: 50,
    premiumNegativeTimePct: 50,
    premiumZeroTimePct: 0,
    improvedPlans: 1,
    unchangedPlans: 1,
    worsenedPlans: 0,
  });
  expect(row?.premiumRemovedPct).toBeCloseTo(32, 10);
  expect(row?.absoluteFundingBeforeHourly).toBeCloseTo(12.5 / 10000 / 8, 12);
  expect(row?.absoluteFundingAfterHourly).toBeCloseTo(8.5 / 10000 / 8, 12);
  expect(row?.absoluteFundingBeforeAprPct).toBeCloseTo(
    (12.5 / 10000 / 8) * 8760 * 100,
    10,
  );
  expect(row?.absoluteFundingAfterAprPct).toBeCloseTo(
    (8.5 / 10000 / 8) * 8760 * 100,
    10,
  );
  expect(row?.signedFundingBeforeHourly).toBeCloseTo(-2.5 / 10000 / 8, 12);
  expect(row?.signedFundingAfterHourly).toBeCloseTo(-6.5 / 10000 / 8, 12);
});

test("plan counts use absolute magnitudes and a 1e-9 bp tolerance", async () => {
  const row = (
    await summarizeImpact([
      plan(0, "SOL", 1, 1 + 0.5e-9),
      plan(1000, "SOL", -1, -1 + 0.5e-9),
      plan(2000, "SOL", 1, -1),
      plan(3000, "SOL", -1, -1 - 2e-9),
      plan(4000, "SOL", 1, 1 - 2e-9),
      { type: "end", ts: 5000 },
    ])
  )[0];
  expect(row).toMatchObject({
    quotePlansWithRestingOrders: 5,
    improvedPlans: 1,
    unchangedPlans: 3,
    worsenedPlans: 1,
  });
});

test("absolute funding weights the recorded live rates before annualization", async () => {
  const row = (
    await summarizeImpact([
      {
        ...plan(0, "SOL", 10, 2),
        fundingBeforeHourly: 0.001,
        fundingAfterHourly: 0.0002,
      },
      {
        ...plan(1000, "SOL", -15, -15),
        fundingBeforeHourly: -0.0001,
        fundingAfterHourly: -0.0001,
      },
      { type: "end", ts: 2000 },
    ])
  )[0];
  expect(row?.absoluteFundingBeforeHourly).toBeCloseTo(0.00055, 12);
  expect(row?.absoluteFundingAfterHourly).toBeCloseTo(0.00015, 12);
  expect(row?.absoluteFundingBeforeAprPct).toBeCloseTo(481.8, 10);
  expect(row?.absoluteFundingAfterAprPct).toBeCloseTo(131.4, 10);
  expect(row?.signedFundingBeforeHourly).toBeCloseTo(0.00045, 12);
  expect(row?.signedFundingAfterHourly).toBeCloseTo(0.00005, 12);
});

test("direction shares use elapsed outside-premium time, including exact zero", async () => {
  const row = (
    await summarizeImpact([
      plan(0, "SOL", 10, 2),
      plan(1000, "SOL", -15, -15),
      plan(4000, "SOL", 0, 0),
      { type: "fail_closed", market: "SOL", ts: 10000 },
      { type: "end", ts: 20000 },
    ])
  )[0];
  expect(row).toMatchObject({
    weightedSeconds: 10,
    premiumPositiveTimePct: 10,
    premiumNegativeTimePct: 30,
    premiumZeroTimePct: 60,
  });
});

test("measure impact help and required file", async () => {
  const deps = { write: () => {}, error: () => {} };
  expect(
    await main(["bun", "hedger", "measure", "impact", "--help"], deps),
  ).toBe(0);
  expect(await main(["bun", "hedger", "measure", "impact"], deps)).toBe(1);
  expect(
    await main(
      ["bun", "hedger", "measure", "impact", "--file", "/nonexistent"],
      deps,
    ),
  ).toBe(1);
});
