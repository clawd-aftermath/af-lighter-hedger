import { AF_SCALE } from "../core/units";
import { abs, type Book, type Side } from "../domain/types";

export function validBook(book: Book): boolean {
  return (
    book.priceScale === AF_SCALE &&
    book.sizeScale === AF_SCALE &&
    book.bids.length > 0 &&
    book.asks.length > 0 &&
    (book.bids[0]?.price ?? 0n) < (book.asks[0]?.price ?? 0n) &&
    [book.bids, book.asks].every((levels, side) =>
      levels.every(
        (level, index) =>
          level.price > 0n &&
          level.size > 0n &&
          (index === 0 ||
            (side === 0
              ? (levels[index - 1]?.price ?? 0n) >= level.price
              : (levels[index - 1]?.price ?? 0n) <= level.price)),
      ),
    )
  );
}
export function mid(book: Book): bigint {
  if (!validBook(book)) throw new Error("Invalid hedge book");
  return ((book.bids[0]?.price ?? 0n) + (book.asks[0]?.price ?? 0n)) / 2n;
}
export function walk(
  book: Book,
  side: Side,
  size: bigint,
  worst?: bigint,
): {
  filled: bigint;
  quote: bigint;
  average: bigint;
  depth: bigint;
  costBp: number;
} {
  if (!validBook(book) || size <= 0n) throw new Error("Invalid book walk");
  const reference = mid(book);
  let remaining = size;
  let filled = 0n;
  let quote = 0n;
  let depth = 0n;
  for (const level of side === "BID" ? book.asks : book.bids) {
    if (
      worst !== undefined &&
      (side === "BID" ? level.price > worst : level.price < worst)
    )
      break;
    depth += level.size;
    const clip = remaining < level.size ? remaining : level.size;
    filled += clip;
    quote += clip * level.price;
    remaining -= clip;
  }
  const average = filled > 0n ? quote / filled : reference;
  return {
    filled,
    quote,
    average,
    depth,
    costBp: Number((abs(average - reference) * 100000000n) / reference) / 10000,
  };
}
export function clampPostOnly(
  price: bigint,
  side: Side,
  tick: bigint,
  book: Book,
): bigint {
  if (!validBook(book) || tick <= 0n) throw new Error("Invalid clamp book");
  const bid = book.bids[0]?.price ?? 0n;
  const ask = book.asks[0]?.price ?? 0n;
  if (side === "ASK")
    return price > bid
      ? ((price + tick - 1n) / tick) * tick
      : (bid / tick + 1n) * tick;
  return price < ask ? (price / tick) * tick : ((ask - 1n) / tick) * tick;
}
