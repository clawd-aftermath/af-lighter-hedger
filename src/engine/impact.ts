import { afIntToDecimal } from "../core/units";
import type { Book, Side } from "../domain/types";
import { validBook } from "./book";

export interface RestingQuote {
  side: Side;
  price: bigint;
  size: bigint;
}

// Projected book-mid premium, independent of the existing premium TWA.
export function quoteImpact(
  outside: Book,
  index: bigint,
  orders: readonly RestingQuote[],
  frequencyMs: number,
  rhoMs: number,
) {
  const bid = outside.bids[0]?.price;
  const ask = outside.asks[0]?.price;
  const prices = {
    index: afIntToDecimal(index),
    outsideBestBid: bid === undefined ? null : afIntToDecimal(bid),
    outsideBestAsk: ask === undefined ? null : afIntToDecimal(ask),
  };
  if (
    bid === undefined ||
    ask === undefined ||
    !validBook(outside) ||
    index <= 0n
  )
    return {
      ...prices,
      premiumBeforeBp: null,
      premiumAfterBp: null,
      fundingBeforeHourly: null,
      fundingAfterHourly: null,
      restingOrders: 0,
    };
  let bestBid = bid;
  let bestAsk = ask;
  let restingOrders = 0;
  for (const order of orders) {
    // A crossed post-only order cannot rest or contribute to the projection.
    if (
      order.size <= 0n ||
      order.price <= 0n ||
      (order.side === "ASK" ? order.price <= bestBid : order.price >= bestAsk)
    )
      continue;
    restingOrders++;
    if (order.side === "ASK" && order.price < bestAsk) bestAsk = order.price;
    if (order.side === "BID" && order.price > bestBid) bestBid = order.price;
  }
  const premium = (b: bigint, a: bigint) =>
    Number(((b + a - 2n * index) * 1000000000000n) / (2n * index)) / 1e8;
  const premiumBeforeBp = premium(bid, ask);
  const premiumAfterBp = premium(bestBid, bestAsk);
  const funding = (bp: number) =>
    Number.isFinite(frequencyMs) &&
    Number.isFinite(rhoMs) &&
    frequencyMs > 0 &&
    rhoMs > 0
      ? (Math.max(-500, Math.min(500, bp)) / 10000) * (frequencyMs / rhoMs)
      : null;
  return {
    ...prices,
    premiumBeforeBp,
    premiumAfterBp,
    fundingBeforeHourly: funding(premiumBeforeBp),
    fundingAfterHourly: funding(premiumAfterBp),
    restingOrders,
  };
}
