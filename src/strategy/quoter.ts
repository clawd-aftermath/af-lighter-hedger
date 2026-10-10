import {
  abs,
  type Book,
  type BookLevel,
  ceilDiv,
  min,
  type OwnOrder,
  type Side,
} from "../domain/types";
import { type CarryInput, carryBp, effectiveCarryBp } from "../funding/carry";
import { relaxedTwa } from "../funding/model";
import { failedReasons, type GateReason, type GateResult } from "../risk/gates";
import { marginCapacity, oiCapacity } from "../risk/limits";

export interface QuoteOrder {
  side: Side;
  price: bigint;
  size: bigint;
  reduceOnly: boolean;
}

export type QuoteReason =
  | GateReason
  | "empty_outside_book"
  | "invalid_book"
  | "no_receiving_side"
  | "below_min_notional"
  | "capacity"
  | "requote_throttled";
export interface QuoteBatch {
  marketId: string;
  reduceOnly: boolean;
  keep: readonly OwnOrder[];
  cancel: readonly string[];
  place: readonly QuoteOrder[];
}
export interface QuotePlan {
  // Execute all cancellations before new placements across these batches.
  batches: readonly QuoteBatch[];
  reasons: readonly QuoteReason[];
  diagnostics?: {
    side: Side;
    outsidePremiumBp: number;
    predictedAfHourly: number;
    carryBp: number;
    effectiveCarryBp: number;
    deltaBp: number;
    floor: bigint;
    neutral: bigint;
    target: bigint;
  };
}

export interface QuoteInput {
  marketId: string;
  book: Book;
  ownOrders: readonly OwnOrder[];
  index: bigint;
  lighterMid: bigint;
  tick: bigint;
  lot: bigint;
  inventory: bigint;
  clipBase: bigint;
  // Optional USD clip on usdScale; when provided it also caps each level's notional.
  clipNotional?: bigint;
  maxPositionBase: bigint;
  levels: 1 | 2 | 3;
  minNotional: bigint;
  usdScale: bigint;
  hedgeDepthBase: bigint;
  marginAvailableBase: bigint;
  // Submitted/opening orders outside this replacement batch, on the book's base scale.
  pendingOpeningBase: bigint;
  oi: {
    openInterest: bigint;
    maxOpenInterest: bigint;
    halfOiThreshold: bigint;
  };
  gates: readonly GateResult[];
  funding: {
    twaPremiumBp: number;
    deltaHours: number;
    omegaHours: number;
    f: number;
    rhoHours: number;
    nearZeroHourly: number;
    mean: number;
    kappa: number;
  };
  lighterFunding: CarryInput["lighter"];
  // Precomputed hedge, exit and margin costs in bp, excluding the AF maker fee.
  costs: {
    hedgeBp: number;
    exitBp: number;
    marginBp: number;
    // AF maker fee in bp, negative = rebate.
    makerFeeBp: number;
  };
  strategy: {
    holdHours: number;
    eta: number;
    kPhi: number;
    sigmaPhi: number;
    epsInBp: number;
    skew: { s1: number; s3: number };
    compressionBudgetBp: number;
  };
  compressionBudgetBp?: number;
  minRequoteTicks: number;
  edgeBandBp: number;
  now: number;
  quoteTtlMs: number;
  requotesInLastMinute: number;
  maxRequotesPerMinute: number;
}

// Removes tagged orders directly, or subtracts owned size from aggregated levels.
export function outsideBook(book: Book, ownOrders: readonly OwnOrder[]): Book {
  const ids = new Set(ownOrders.map((o) => o.clientOrderId));
  function remove(levels: readonly BookLevel[], side: Side): BookLevel[] {
    const tagged = new Set(
      levels.flatMap((l) => (l.clientOrderId ? [l.clientOrderId] : [])),
    );
    const byPrice = new Map<bigint, bigint>();
    for (const order of ownOrders) {
      if (order.side === side && !tagged.has(order.clientOrderId))
        byPrice.set(order.price, (byPrice.get(order.price) ?? 0n) + order.size);
    }
    return levels.flatMap((level) => {
      if (level.clientOrderId && ids.has(level.clientOrderId)) return [];
      const owned = level.clientOrderId
        ? 0n
        : min(byPrice.get(level.price) ?? 0n, level.size);
      if (!level.clientOrderId)
        byPrice.set(level.price, (byPrice.get(level.price) ?? 0n) - owned);
      const size = level.size - owned;
      return size > 0n ? [{ ...level, size }] : [];
    });
  }
  return {
    ...book,
    bids: remove(book.bids, "BID"),
    asks: remove(book.asks, "ASK"),
  };
}

const BP_SCALE = 1000000n;
const BP_DENOMINATOR = 10000n * BP_SCALE;

function bpInteger(bp: number): bigint {
  if (
    !Number.isFinite(bp) ||
    Math.abs(bp * Number(BP_SCALE)) > Number.MAX_SAFE_INTEGER
  )
    throw new Error("bp: out of supported range");
  return BigInt(Math.floor(bp * Number(BP_SCALE)));
}

function multiplyBp(price: bigint, bp: number, up: boolean): bigint {
  // Round in the conservative direction even below the model's micro-bp grid.
  const scaled = bp * Number(BP_SCALE);
  if (!Number.isFinite(scaled) || Math.abs(scaled) > Number.MAX_SAFE_INTEGER)
    throw new Error("bp: out of supported range");
  const factor =
    BP_DENOMINATOR + BigInt(up ? Math.ceil(scaled) : Math.floor(scaled));
  if (factor <= 0n) throw new Error("bp: nonpositive price factor");
  const numerator = price * factor;
  return up ? ceilDiv(numerator, BP_DENOMINATOR) : numerator / BP_DENOMINATOR;
}

function ratioBp(numerator: bigint, denominator: bigint): number {
  return Number((numerator * BP_DENOMINATOR) / denominator) / Number(BP_SCALE);
}

function validBook(book: Book): boolean {
  return (
    book.priceScale > 0n &&
    book.sizeScale > 0n &&
    [book.bids, book.asks].every((levels, side) =>
      levels.every((l, index) => {
        const previous = levels[index - 1];
        return (
          l.price > 0n &&
          l.size > 0n &&
          (!previous ||
            (side === 0
              ? previous.price >= l.price
              : previous.price <= l.price))
        );
      }),
    )
  );
}

export function computeQuotes(i: QuoteInput): QuotePlan {
  const own = i.ownOrders.filter((o) => o.marketId === i.marketId);
  const batches: QuoteBatch[] = [];
  function cancelAll(reasons: QuoteReason[]): QuotePlan {
    return {
      reasons,
      batches: [false, true]
        .map((reduceOnly) => ({
          marketId: i.marketId,
          reduceOnly,
          keep: [],
          place: [],
          cancel: own
            .filter((o) => o.reduceOnly === reduceOnly)
            .map((o) => o.clientOrderId),
        }))
        .filter((b) => b.cancel.length > 0),
    };
  }
  const gates = failedReasons(i.gates);
  if (gates.length) return cancelAll(gates);
  const values = [
    i.now,
    i.quoteTtlMs,
    i.edgeBandBp,
    i.minRequoteTicks,
    i.requotesInLastMinute,
    i.maxRequotesPerMinute,
    ...Object.values(i.costs),
    i.costs.makerFeeBp,
    i.funding.twaPremiumBp,
    i.funding.f,
    i.funding.rhoHours,
    i.funding.nearZeroHourly,
    i.strategy.epsInBp,
    i.strategy.skew.s1,
    i.strategy.skew.s3,
    i.compressionBudgetBp ?? i.strategy.compressionBudgetBp,
  ];
  if (
    !values.every(Number.isFinite) ||
    i.index <= 0n ||
    i.lighterMid <= 0n ||
    i.tick <= 0n ||
    i.lot <= 0n ||
    i.maxPositionBase <= 0n ||
    i.clipBase <= 0n ||
    i.usdScale <= 0n ||
    i.minNotional < 0n ||
    (i.clipNotional !== undefined && i.clipNotional <= 0n) ||
    i.hedgeDepthBase < 0n ||
    i.marginAvailableBase < 0n ||
    i.pendingOpeningBase < 0n ||
    i.quoteTtlMs <= 0 ||
    i.minRequoteTicks < 0 ||
    !Number.isInteger(i.minRequoteTicks) ||
    i.edgeBandBp < 0 ||
    i.funding.f <= 0 ||
    i.funding.rhoHours <= 0 ||
    i.funding.nearZeroHourly < 0 ||
    (i.compressionBudgetBp ?? i.strategy.compressionBudgetBp) < 0 ||
    ![1, 2, 3].includes(i.levels)
  )
    return cancelAll(["invalid_input"]);
  if (!validBook(i.book)) return cancelAll(["invalid_book"]);
  const outside = outsideBook(i.book, own);
  const bid = outside.bids[0]?.price;
  const ask = outside.asks[0]?.price;
  if (bid === undefined || ask === undefined)
    return cancelAll(["empty_outside_book"]);
  if (bid >= ask) return cancelAll(["invalid_book"]);
  const premiumBp = ratioBp(bid + ask - 2n * i.index, 2n * i.index);
  let predicted: number;
  let k: number;
  let kx: number;
  let side: Side;
  const reduceOnly = abs(i.inventory) >= i.maxPositionBase;
  try {
    predicted =
      ((relaxedTwa(
        i.funding.twaPremiumBp,
        premiumBp,
        i.funding.deltaHours,
        i.funding.omegaHours,
      ) /
        10000) *
        i.funding.f) /
      i.funding.rhoHours;
    if (reduceOnly) side = i.inventory > 0n ? "ASK" : "BID";
    else if (Math.abs(predicted) < i.funding.nearZeroHourly || predicted === 0)
      return cancelAll(["no_receiving_side"]);
    else side = predicted > 0 ? "ASK" : "BID";
    k = carryBp(side, i.strategy.holdHours, {
      af: {
        hourlyFraction: predicted,
        mean: i.funding.mean,
        kappa: i.funding.kappa,
      },
      lighter: i.lighterFunding,
    });
    kx = effectiveCarryBp(
      k,
      i.strategy.eta,
      i.strategy.kPhi,
      i.strategy.sigmaPhi,
      i.strategy.holdHours,
    );
  } catch {
    return cancelAll(["invalid_input"]);
  }
  const u =
    Number((i.inventory * BP_SCALE) / i.maxPositionBase) / Number(BP_SCALE);
  const skew = i.strategy.skew.s1 * u + i.strategy.skew.s3 * u ** 3;
  const delta =
    i.strategy.epsInBp +
    i.costs.hedgeBp +
    i.costs.exitBp +
    i.costs.marginBp +
    i.costs.makerFeeBp -
    kx +
    (side === "ASK" ? -skew : skew);
  let floor: bigint;
  let allowance: bigint;
  let target: bigint;
  const neutral = side === "ASK" ? 2n * i.index - bid : 2n * i.index - ask;
  try {
    floor = multiplyBp(
      i.lighterMid,
      side === "ASK" ? delta : -delta,
      side === "ASK",
    );
    allowance =
      (i.lighterMid *
        bpInteger(i.compressionBudgetBp ?? i.strategy.compressionBudgetBp)) /
      BP_DENOMINATOR;
    target =
      side === "ASK"
        ? neutral > floor - allowance
          ? neutral
          : floor - allowance
        : min(neutral, floor + allowance);
    if (side === "ASK") {
      target = target > bid + i.tick ? target : bid + i.tick;
      if (premiumBp > 0) target = target > i.index ? target : i.index;
      target = ceilDiv(target, i.tick) * i.tick;
    } else {
      target = min(target, ask - i.tick);
      if (premiumBp < 0) target = min(target, i.index);
      target = (target / i.tick) * i.tick;
    }
  } catch {
    return cancelAll(["invalid_input"]);
  }
  if (target <= 0n) return cancelAll(["invalid_input"]);
  let capacity: bigint;
  try {
    capacity = reduceOnly
      ? min(abs(i.inventory), i.hedgeDepthBase)
      : min(
          i.maxPositionBase > abs(i.inventory) + i.pendingOpeningBase
            ? i.maxPositionBase - abs(i.inventory) - i.pendingOpeningBase
            : 0n,
          i.hedgeDepthBase,
          marginCapacity(i.marginAvailableBase, i.pendingOpeningBase),
          oiCapacity({
            ...i.oi,
            position: i.inventory,
            pendingIncrease: i.pendingOpeningBase,
          }),
        );
  } catch {
    return cancelAll(["invalid_input"]);
  }
  const orders: QuoteOrder[] = [];
  for (let level = 0; level < i.levels; level++) {
    const price = target + (side === "ASK" ? 1n : -1n) * BigInt(level) * i.tick;
    const clip =
      i.clipNotional === undefined || price <= 0n
        ? i.clipBase
        : min(
            i.clipBase,
            (i.clipNotional * i.book.priceScale * i.book.sizeScale) /
              (price * i.usdScale),
          );
    const size = (min(clip, capacity) / i.lot) * i.lot;
    if (
      price <= 0n ||
      size <= 0n ||
      price * size * i.usdScale <
        i.minNotional * i.book.priceScale * i.book.sizeScale
    )
      break;
    orders.push({ side, price, size, reduceOnly });
    capacity -= size;
  }
  const reasons: QuoteReason[] = orders.length
    ? []
    : [capacity < i.lot ? "capacity" : "below_min_notional"];
  const available = [...own];
  const keep: OwnOrder[] = [];
  const place: QuoteOrder[] = [];
  let band: bigint;
  try {
    band = (i.lighterMid * bpInteger(i.edgeBandBp)) / BP_DENOMINATOR;
  } catch {
    return cancelAll(["invalid_input"]);
  }
  for (const order of orders) {
    const matching = available.find(
      (o) =>
        o.side === side &&
        o.reduceOnly === reduceOnly &&
        o.size > 0n &&
        o.size <= order.size &&
        o.price * o.size * i.usdScale >=
          i.minNotional * i.book.priceScale * i.book.sizeScale &&
        (i.clipNotional === undefined ||
          o.price * o.size * i.usdScale <=
            i.clipNotional * i.book.priceScale * i.book.sizeScale) &&
        o.price % i.tick === 0n &&
        o.size % i.lot === 0n &&
        abs(o.price - order.price) <= BigInt(i.minRequoteTicks) * i.tick &&
        abs(o.price - order.price) <= band &&
        (o.createdAt === undefined ||
          (o.createdAt <= i.now && i.now - o.createdAt < i.quoteTtlMs)) &&
        (side === "ASK"
          ? o.price >= bid + i.tick &&
            (premiumBp <= 0 || o.price >= i.index) &&
            o.price >= floor - allowance
          : o.price <= ask - i.tick &&
            (premiumBp >= 0 || o.price <= i.index) &&
            o.price <= floor + allowance),
    );
    if (matching) {
      keep.push(matching);
      available.splice(available.indexOf(matching), 1);
    } else place.push(order);
  }
  if (i.requotesInLastMinute >= i.maxRequotesPerMinute && place.length > 0) {
    place.length = 0;
    reasons.push("requote_throttled");
  }
  for (const ro of [false, true]) {
    const batch: QuoteBatch = {
      marketId: i.marketId,
      reduceOnly: ro,
      keep: keep.filter((o) => o.reduceOnly === ro),
      cancel: available
        .filter((o) => o.reduceOnly === ro)
        .map((o) => o.clientOrderId),
      place: place.filter((o) => o.reduceOnly === ro),
    };
    if (batch.keep.length || batch.cancel.length || batch.place.length)
      batches.push(batch);
  }
  return {
    batches,
    reasons,
    diagnostics: {
      side,
      outsidePremiumBp: premiumBp,
      predictedAfHourly: predicted,
      carryBp: k,
      effectiveCarryBp: kx,
      deltaBp: delta,
      floor,
      neutral,
      target,
    },
  };
}
