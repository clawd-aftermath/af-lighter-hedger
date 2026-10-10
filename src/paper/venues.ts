import { AF_SCALE, lighterFromInt } from "../core/units";
import { abs, type Fill, type OwnOrder, type Side } from "../domain/types";
import { mid, validBook, walk } from "../engine/book";
import { hourlyPayment } from "../engine/funding";
import type { ResolvedMarket } from "../engine/markets";
import type {
  AccountPosition,
  AfReceipt,
  AfVenue,
  FeedEvent,
  Feeds,
  HedgeSubmission,
  LighterVenue,
  QuoteRequest,
  Resolution,
  SendContext,
} from "../engine/types";
import type { FundingPayment, Intent, StateStore } from "../state/store";
import type { Clock, HedgeResult } from "../venues/lighter";

export class PaperVenues {
  readonly af: AfVenue;
  readonly lighter: LighterVenue;
  readonly feeds: Feeds;
  private listener?: (event: FeedEvent) => void;
  constructor(
    private source: Feeds,
    private markets: readonly ResolvedMarket[],
    private store: StateStore,
    private clock: Clock,
    private simulateFunding = true,
  ) {
    this.af = {
      position: async (symbol) => this.position("af", symbol),
      quote: async (request, context) => this.quote(request, context),
      cancel: async (symbol, _orders, context) => this.cancel(symbol, context),
      flatten: async (symbol, side, size, _slippage, context) =>
        this.flatten(symbol, side, size, context),
      resolve: async (intent) => this.resolve(intent),
      funding: async () => this.funding("af"),
    };
    this.lighter = {
      position: async (symbol) => this.position("lighter", symbol),
      hedge: async (request, context) => this.hedge(request, context),
      resolve: async (intent) => this.resolve(intent),
      funding: async () => this.funding("lighter"),
    };
    this.feeds = {
      view: (symbol) => {
        const view = source.view(symbol);
        const own = this.orders(symbol);
        return {
          ...view,
          afBook: {
            ...view.afBook,
            bids: [
              ...view.afBook.bids,
              ...own
                .filter((o) => o.side === "BID")
                .map((o) => ({
                  price: o.price,
                  size: o.size,
                  clientOrderId: o.clientOrderId,
                })),
            ].sort((a, b) => (a.price > b.price ? -1 : 1)),
            asks: [
              ...view.afBook.asks,
              ...own
                .filter((o) => o.side === "ASK")
                .map((o) => ({
                  price: o.price,
                  size: o.size,
                  clientOrderId: o.clientOrderId,
                })),
            ].sort((a, b) => (a.price < b.price ? -1 : 1)),
          },
        };
      },
      refresh: () => source.refresh(),
      start: (listener) => {
        this.listener = listener;
        source.start((event) => {
          if (event.type === "market") this.tradeThrough(event.market);
          listener(event);
        });
        this.replayFills();
      },
      stop: () => {
        source.stop();
        this.listener = undefined;
      },
    };
  }
  private funding(venue: "af" | "lighter"): FundingPayment[] {
    if (!this.simulateFunding) return [];
    const hour = Math.floor(this.clock.now() / 3600000);
    const payments: FundingPayment[] = [];
    for (const market of this.markets) {
      const symbol = market.config.symbol;
      const key = `paper:funding_hour:${venue}:${symbol}`;
      const previous = this.store.get<number>(key);
      if (previous === hour) continue;
      const view = this.source.view(symbol);
      if (previous != null && hour > previous) {
        const base = this.base(venue, symbol);
        const rate =
          venue === "af"
            ? view.af.estimatedFundingRate
            : view.lighterHourlyFunding;
        // Positive hourly rates charge longs and credit shorts.
        const price =
          venue === "lighter" && validBook(view.lighterBook)
            ? mid(view.lighterBook)
            : view.index;
        const amount = hourlyPayment(base, price, rate);
        for (let h = previous + 1; h <= hour; h++) {
          const payment: FundingPayment = {
            venue,
            market: symbol,
            ts: h * 3600000,
            amount,
            source: "paper",
            key: `${symbol}:${h}`,
          };
          this.store.funding(payment);
          payments.push(payment);
        }
      }
      this.store.set(key, hour);
    }
    return payments;
  }
  private market(symbol: string): ResolvedMarket {
    const market = this.markets.find((m) => m.config.symbol === symbol);
    if (!market) throw new Error("Unknown paper market");
    return market;
  }
  private base(venue: string, symbol: string): bigint {
    return this.store.get<bigint>(`paper:${venue}:base:${symbol}`) ?? 0n;
  }
  private orders(symbol: string): OwnOrder[] {
    return (
      this.store.get<(OwnOrder & { expiryTimestamp: number })[]>(
        `paper:orders:${symbol}`,
      ) ?? []
    ).filter((o) => o.expiryTimestamp > this.clock.now());
  }
  private position(venue: string, symbol: string): AccountPosition {
    const value = this.base(venue, symbol);
    return {
      base: value,
      exists:
        venue === "af"
          ? (this.store.get<boolean>(`paper:exists:${symbol}`) ?? false)
          : true,
      fresh: true,
      ts: this.clock.now(),
      marginHeadroomPct: 100,
      availableUsd: 100000n * AF_SCALE,
      equityUsd: 100000n * AF_SCALE,
      orders: venue === "af" ? this.orders(symbol) : [],
    };
  }
  private receipt(context: SendContext): AfReceipt {
    const result = {
      status: "success" as const,
      digest: `paper-af-${context.intent.id}`,
      updatedPremiumTwap: null,
      gasUsd: 0n,
    };
    context.beforeSend(result.digest);
    this.store.set(`paper:result:${context.intent.id}`, result);
    return result;
  }
  private quote(request: QuoteRequest, context: SendContext): AfReceipt {
    return this.store.transaction(() => {
      const receipt = this.receipt(context);
      const orders = this.orders(request.market).filter(
        (o) => !request.cancel.includes(o.clientOrderId),
      );
      const fresh = this.source.view(request.market).afBook;
      for (const order of request.orders)
        if (
          order.side === "BID"
            ? order.price >= (fresh.asks[0]?.price ?? 0n)
            : order.price <= (fresh.bids[0]?.price ?? 0n)
        )
          throw new Error("Paper post-only crossed");
      this.store.set(`paper:orders:${request.market}`, [
        ...orders,
        ...request.orders.map((o) => ({
          ...o,
          expiryTimestamp: request.expiryTimestamp,
        })),
      ]);
      this.store.set(`paper:exists:${request.market}`, true);
      return receipt;
    });
  }
  private cancel(symbol: string, context: SendContext): AfReceipt {
    return this.store.transaction(() => {
      const receipt = this.receipt(context);
      this.store.set(`paper:orders:${symbol}`, []);
      return receipt;
    });
  }
  private flatten(
    symbol: string,
    side: Side,
    size: bigint,
    context: SendContext,
  ): AfReceipt {
    this.funding("af");
    return this.store.transaction(() => {
      const receipt = this.receipt(context);
      const position = this.base("af", symbol);
      if (
        size > abs(position) ||
        (position > 0n ? side !== "ASK" : side !== "BID")
      )
        throw new Error("Invalid paper reduce-only flatten");
      this.store.set(
        `paper:af:base:${symbol}`,
        position + (side === "BID" ? size : -size),
      );
      return receipt;
    });
  }
  private hedge(request: HedgeSubmission, context: SendContext): HedgeResult {
    this.funding("lighter");
    const m = this.market(request.intent.marketId);
    const priceBound =
      (request.refPrice *
        BigInt(
          10000 +
            (request.intent.side === "BID" ? 1 : -1) *
              request.intent.slippageBps,
        )) /
      10000n;
    const position = this.base("lighter", request.intent.marketId);
    let size = m.toAf(request.baseAmount);
    if (request.reduceOnly) {
      if (
        position === 0n ||
        (position > 0n
          ? request.intent.side !== "ASK"
          : request.intent.side !== "BID")
      )
        size = 0n;
      else if (size > abs(position)) size = abs(position);
    }
    const execution =
      size > 0n
        ? walk(
            this.source.view(request.intent.marketId).lighterBook,
            request.intent.side,
            size,
            priceBound,
          )
        : { filled: 0n, average: 0n, quote: 0n };
    const filled = (execution.filled / m.jointStep) * m.jointStep;
    const fee =
      (((filled * execution.average) / AF_SCALE) *
        BigInt(Math.round(Number(m.lighter.takerFee) * 1000000))) /
      100000000n;
    const result: HedgeResult = {
      status:
        filled === request.intent.size
          ? "filled"
          : filled > 0n
            ? "partial"
            : "canceled",
      filledBase: lighterFromInt(m.toLighter(filled), m.lighter.sizeDecimals),
      avgPrice: filled > 0n ? lighterFromInt(execution.average, 9) : null,
      fee: lighterFromInt(fee, 9),
      txHash: `paper-lighter-${context.intent.id}`,
      clientOrderIndex: request.intent.clientOrderIndex,
    };
    this.store.transaction(() => {
      context.beforeSend(result.txHash);
      this.store.set(
        `paper:lighter:base:${request.intent.marketId}`,
        position + (request.intent.side === "BID" ? filled : -filled),
      );
      this.store.set(`paper:result:${context.intent.id}`, result);
    });
    return result;
  }
  private resolve(intent: Intent): Resolution {
    const result = this.store.get<AfReceipt | HedgeResult>(
      `paper:result:${intent.id}`,
    );
    return result
      ? { status: "confirmed", result }
      : intent.status === "prepared"
        ? { status: "abandoned" }
        : { status: "unknown" };
  }
  tradeThrough(symbol: string): Fill[] {
    // Settle the preceding hour before changing the simulated position.
    this.funding("af");
    this.funding("lighter");
    const book = this.source.view(symbol).afBook;
    const market = this.market(symbol);
    const fills: Fill[] = [];
    this.store.transaction(() => {
      const remaining: OwnOrder[] = [];
      const consumed = new Map<string, bigint>();
      for (const order of this.orders(symbol)) {
        const levels = order.side === "ASK" ? book.bids : book.asks;
        let liquidity = 0n;
        for (const level of levels) {
          if (
            order.side === "ASK"
              ? level.price < order.price
              : level.price > order.price
          )
            break;
          const key = `${order.side}:${level.price}`;
          const available = level.size - (consumed.get(key) ?? 0n);
          const take =
            available < order.size - liquidity
              ? available
              : order.size - liquidity;
          if (take > 0n) {
            liquidity += take;
            consumed.set(key, (consumed.get(key) ?? 0n) + take);
          }
          if (liquidity >= order.size) break;
        }
        let size = (liquidity / market.af.lotInt) * market.af.lotInt;
        const position = this.base("af", symbol);
        if (order.reduceOnly)
          size =
            position === 0n ||
            (position > 0n ? order.side !== "ASK" : order.side !== "BID")
              ? 0n
              : size > abs(position)
                ? abs(position)
                : size;
        if (size > 0n) {
          const seq =
            (this.store.get<bigint>("paper:fill_sequence") ?? 0n) + 1n;
          this.store.set("paper:fill_sequence", seq);
          const fill: Fill = {
            marketId: symbol,
            txDigest: `paper-fill-${seq}`,
            orderId: order.clientOrderId,
            side: order.side,
            price: order.price,
            size,
            ts: this.clock.now(),
          };
          fills.push(fill);
          this.store.set(
            `paper:af:base:${symbol}`,
            position + (order.side === "BID" ? size : -size),
          );
        }
        if (order.size > size)
          remaining.push({ ...order, size: order.size - size });
      }
      this.store.set(`paper:orders:${symbol}`, remaining);
      this.store.set("paper:fill_outbox", [
        ...(this.store.get<Fill[]>("paper:fill_outbox") ?? []),
        ...fills,
      ]);
    });
    for (const fill of fills)
      this.listener?.({
        type: "fill",
        fill,
        fee: BigInt(
          Math.round(
            Number((fill.size * fill.price) / AF_SCALE) * market.af.makerFee,
          ),
        ),
      });
    return fills;
  }
  private replayFills(): void {
    const known = new Set(this.store.fills().map((f) => f.txDigest));
    const pending = (this.store.get<Fill[]>("paper:fill_outbox") ?? []).filter(
      (f) => !known.has(f.txDigest),
    );
    this.store.set("paper:fill_outbox", pending);
    for (const fill of pending) this.listener?.({ type: "fill", fill });
  }
}
