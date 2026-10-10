import type { GateInput } from "../../src/risk/gates";
import type { HedgePolicy } from "../../src/strategy/hedger";
import type { QuoteInput } from "../../src/strategy/quoter";
import type { ReconcileInput } from "../../src/strategy/reconciler";

export function quoteInput(): QuoteInput {
  return {
    marketId: "SOL",
    book: {
      bids: [{ price: 9900n, size: 10000n }],
      asks: [{ price: 10300n, size: 10000n }],
      priceScale: 100n,
      sizeScale: 100n,
      ts: 1000,
    },
    ownOrders: [],
    index: 10000n,
    lighterMid: 10000n,
    tick: 1n,
    lot: 1n,
    inventory: 0n,
    clipBase: 50n,
    maxPositionBase: 500n,
    levels: 1,
    minNotional: 100n,
    usdScale: 100n,
    hedgeDepthBase: 1000n,
    marginAvailableBase: 1000n,
    pendingOpeningBase: 0n,
    oi: {
      openInterest: 2000n,
      maxOpenInterest: 10000n,
      halfOiThreshold: 1000n,
    },
    gates: [],
    funding: {
      twaPremiumBp: 100,
      deltaHours: 1,
      omegaHours: 1,
      f: 1,
      rhoHours: 8,
      nearZeroHourly: 1e-8,
      mean: 0,
      kappa: 0,
    },
    lighterFunding: { hourlyFraction: 0.0000125, mean: 0.0000125, kappa: 0 },
    costs: { hedgeBp: 1, exitBp: 2, marginBp: 1, makerFeeBp: 0 },
    strategy: {
      holdHours: 8,
      eta: 0.25,
      kPhi: 1,
      sigmaPhi: 0,
      epsInBp: 1,
      skew: { s1: 0, s3: 0 },
      compressionBudgetBp: 0,
    },
    minRequoteTicks: 2,
    edgeBandBp: 10,
    now: 1000,
    quoteTtlMs: 600000,
    requotesInLastMinute: 0,
    maxRequotesPerMinute: 6,
  };
}

export function gateInput(): GateInput {
  return {
    now: 1000,
    afBookTs: 1000,
    afOracleTs: 1000,
    lighterBookTs: 1000,
    stalenessMs: { afBook: 50, afOracle: 50, lighterBook: 50 },
    basisBp: 0,
    basisEmaBp: 0,
    basisBandBp: 10,
    predictedAfHourly: 0.001,
    inventory: 0n,
    sessionOpen: true,
    pauseWhenSessionClosed: true,
    marginHeadroomPct: 30,
    minMarginHeadroomPct: 20,
    unhedgedUsd: 0n,
    maxUnhedgedUsd: 100n,
    unhedgedSince: null,
    maxUnhedgedAgeMs: 100,
    oiHeadroom: 1n,
    breakerLatched: false,
  };
}

export function hedgePolicy(): HedgePolicy {
  return {
    lot: 1n,
    minSize: 5n,
    minNotional: 5n,
    price: 1n,
    priceScale: 1n,
    sizeScale: 1n,
    usdScale: 1n,
    maxUnhedgedUsd: 100n,
    maxUnhedgedAgeMs: 1000,
    outcomeTimeoutMs: 100,
    slippageBps: 50,
    emergencySlippageBps: 100,
    allocate: (next) => ({ clientOrderIndex: next, next: next + 1n }),
  };
}

export function reconcileInput(): ReconcileInput {
  return {
    af: { marketId: "SOL", base: { value: 100n, scale: 100n } },
    lighter: { marketId: "SOL", base: { value: -100n, scale: 100n } },
    inFlight: [],
    fresh: { af: true, lighter: true, hedges: true },
    afLot: { value: 1n, scale: 100n },
    lighterLot: { value: 2n, scale: 100n },
  };
}
