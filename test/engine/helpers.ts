import { DEFAULT_CONFIG, DEFAULT_MARKETS } from "../../src/config/defaults";
import { AF_SCALE } from "../../src/core/units";
import type { Book, Fill, OwnOrder, Side } from "../../src/domain/types";
import { Engine } from "../../src/engine/engine";
import { resolveMarkets } from "../../src/engine/markets";
import type {
  AccountPosition,
  AfReceipt,
  AfVenue,
  FeedEvent,
  Feeds,
  HedgeSubmission,
  LighterVenue,
  MarketView,
  QuoteRequest,
  Resolution,
  SendContext,
} from "../../src/engine/types";
import type { Alert } from "../../src/ops/alerts";
import { type Intent, StateStore } from "../../src/state/store";
import type { AfMarket } from "../../src/venues/aftermath";
import type { Clock, HedgeResult, Market } from "../../src/venues/lighter";
import { configuredStrategy } from "../fixtures/config";

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture");
  return value;
}

export class FakeClock implements Clock {
  time = 100000;
  timers = new Map<number, { at: number; fn: () => void }>();
  next = 1;
  now() {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number) {
    const key = this.next++;
    this.timers.set(key, { at: this.time + ms, fn });
    return key;
  }
  clearTimeout(timer: unknown) {
    this.timers.delete(Number(timer));
  }
  advance(ms: number) {
    this.time += ms;
    for (const [key, timer] of this.timers)
      if (timer.at <= this.time) {
        this.timers.delete(key);
        timer.fn();
      }
  }
}
export function afMarket(symbol = "SOL"): AfMarket {
  return {
    id: `0x${({ BTC: "1", ETH: "2", SOL: "3", SUI: "4" } as Record<string, string>)[symbol] ?? "5"}`,
    packageId: "0xa",
    symbol: `${symbol}/USD:USDC`,
    baseSymbol: symbol,
    category: "crypto",
    tickInt: 1000000n,
    lotInt: 1000000n,
    minOrderUsd: 1,
    makerFee: -0.00005,
    takerFee: 0.00045,
    priorityTakerFee: null,
    imr: 0.1,
    mmr: 0.05,
    maxLeverage: 10,
    maxOpenInterestBase: 10000,
    maxOpenInterestThresholdBase: 1000,
    maxOpenInterestPositionPercent: 0.5,
    maxPendingOrders: 80,
    fundingFrequencyMs: 3600000,
    fundingPeriodMs: 28800000,
    premiumTwap: 1,
    indexPrice: 100,
    markPrice: 100,
    estimatedFundingRate: 0.00125,
    nextFundingTimestampMs: 3600000,
    session: { isOpen: true, nextTransitionAt: null },
  };
}
export function lighterMarket(symbol = "SOL"): Market {
  return {
    marketId:
      ({ BTC: 0, ETH: 1, SOL: 2, SUI: 3 } as Record<string, number>)[symbol] ??
      4,
    symbol,
    marketType: "perp",
    status: "active",
    sizeDecimals:
      ({ BTC: 5, ETH: 4, SOL: 3, SUI: 1 } as Record<string, number>)[symbol] ??
      3,
    priceDecimals: 3,
    minBaseAmount: "0.001",
    minQuoteAmount: "10",
    makerFee: "0",
    takerFee: "0",
  };
}
export function book(ts: number, bid = 99, ask = 103): Book {
  return {
    priceScale: AF_SCALE,
    sizeScale: AF_SCALE,
    ts,
    bids: [{ price: BigInt(bid) * AF_SCALE, size: 10n * AF_SCALE }],
    asks: [{ price: BigInt(ask) * AF_SCALE, size: 10n * AF_SCALE }],
  };
}
export class FakeFeeds implements Feeds {
  views = new Map<string, MarketView>();
  listener?: (event: FeedEvent) => void;
  refreshes = 0;
  constructor(
    readonly clock: FakeClock,
    symbols = ["SOL"],
  ) {
    for (const symbol of symbols)
      this.views.set(symbol, {
        afBook: book(clock.now()),
        lighterBook: book(clock.now(), 99, 101),
        index: 100n * AF_SCALE,
        oracleTs: clock.now(),
        marketTs: clock.now(),
        statsTs: clock.now(),
        afConnected: true,
        lighterConnected: true,
        af: afMarket(symbol),
        openInterest: 2000n * AF_SCALE,
        lighterHourlyFunding: 0.00001,
        fundingObserved: true,
      });
  }
  view(symbol: string) {
    const view = this.views.get(symbol);
    if (!view) throw new Error("No view");
    return view;
  }
  async refresh() {
    this.refreshes++;
  }
  start(listener: (event: FeedEvent) => void) {
    this.listener = listener;
  }
  stop() {
    this.listener = undefined;
  }
  fresh() {
    for (const view of this.views.values()) {
      view.afBook = { ...view.afBook, ts: this.clock.now() };
      view.lighterBook = { ...view.lighterBook, ts: this.clock.now() };
      view.oracleTs = this.clock.now();
      view.marketTs = this.clock.now();
      view.statsTs = this.clock.now();
    }
  }
  emit(event: FeedEvent) {
    this.listener?.(event);
  }
}
function position(
  base: bigint,
  orders: OwnOrder[],
  clock: Clock,
  fresh = true,
): AccountPosition {
  return {
    base,
    orders,
    exists: true,
    fresh,
    ts: clock.now(),
    marginHeadroomPct: 90,
    availableUsd: 10000n * AF_SCALE,
    equityUsd: 10000n * AF_SCALE,
  };
}
export class FakeAf implements AfVenue {
  base = 0n;
  orders: OwnOrder[] = [];
  quotes: QuoteRequest[] = [];
  cancels = 0;
  checks = 0;
  fresh = true;
  results = new Map<string, AfReceipt>();
  onQuote?: () => void;
  constructor(
    readonly clock: Clock,
    readonly store: StateStore,
  ) {}
  async position(_market: string) {
    this.checks++;
    return position(this.base, [...this.orders], this.clock, this.fresh);
  }
  async quote(request: QuoteRequest, context: SendContext) {
    expectPrepared(this.store, context.intent);
    this.onQuote?.();
    context.beforeSend(`af-${context.intent.id}`);
    this.quotes.push(request);
    this.orders = [
      ...this.orders.filter((o) => !request.cancel.includes(o.clientOrderId)),
      ...request.orders,
    ];
    const result: AfReceipt = {
      status: "success",
      digest: `af-${context.intent.id}`,
      updatedPremiumTwap: null,
      gasUsd: 1n,
    };
    this.results.set(context.intent.id, result);
    return result;
  }
  async cancel(
    _symbol: string,
    _orders: readonly OwnOrder[],
    context: SendContext,
  ) {
    expectPrepared(this.store, context.intent);
    context.beforeSend(`af-${context.intent.id}`);
    this.cancels++;
    this.orders = [];
    return {
      status: "success" as const,
      digest: `af-${context.intent.id}`,
      updatedPremiumTwap: null,
      gasUsd: 0n,
    };
  }
  async flatten(
    _symbol: string,
    _side: Side,
    _size: bigint,
    _slippage: number,
    context: SendContext,
  ) {
    context.beforeSend(`af-${context.intent.id}`);
    this.base = 0n;
    return {
      status: "success" as const,
      digest: `af-${context.intent.id}`,
      updatedPremiumTwap: null,
      gasUsd: 0n,
    };
  }
  async resolve(intent: Intent): Promise<Resolution> {
    const result = this.results.get(intent.id);
    return result ? { status: "confirmed", result } : { status: "unknown" };
  }
  fill(requested?: bigint): Fill {
    const order = this.orders[0];
    if (!order) throw new Error("No quote");
    const size = requested ?? order.size;
    this.base += order.side === "ASK" ? -size : size;
    this.orders = this.orders.flatMap((o) =>
      o === order
        ? o.size > size
          ? [{ ...o, size: o.size - size }]
          : []
        : [o],
    );
    return {
      marketId: order.marketId,
      side: order.side,
      price: order.price,
      size,
      txDigest: `fill-${this.base}`,
      orderId: order.clientOrderId,
      ts: this.clock.now(),
    };
  }
}
export class FakeLighter implements LighterVenue {
  base = 0n;
  requests: HedgeSubmission[] = [];
  fresh = true;
  partial: bigint | null = null;
  timeout = false;
  resolvable = false;
  resolutions = 0;
  fail = false;
  results = new Map<string, HedgeResult>();
  constructor(
    readonly clock: Clock,
    readonly store: StateStore,
  ) {}
  async position(_market: string) {
    return position(this.base, [], this.clock, this.fresh);
  }
  async hedge(request: HedgeSubmission, context: SendContext) {
    expectPrepared(this.store, context.intent);
    if (this.store.cursor("lighter") <= request.intent.clientOrderIndex)
      throw new Error("Cursor not durable");
    context.beforeSend(`lighter-${context.intent.id}`);
    this.requests.push(request);
    const filled = this.fail ? 0n : (this.partial ?? request.intent.size);
    this.partial = null;
    this.base += request.intent.side === "BID" ? filled : -filled;
    const result: HedgeResult = {
      status: this.fail
        ? "failed"
        : filled === request.intent.size
          ? "filled"
          : "partial",
      filledBase: String(Number(filled) / 1e9),
      avgPrice: "100",
      fee: "0",
      clientOrderIndex: request.intent.clientOrderIndex,
      txHash: `lighter-${context.intent.id}`,
    };
    this.results.set(context.intent.id, result);
    if (this.timeout) throw new Error("lost response");
    return result;
  }
  async resolve(intent: Intent): Promise<Resolution> {
    this.resolutions++;
    const result = this.results.get(intent.id);
    return this.resolvable && result
      ? { status: "confirmed", result }
      : { status: "unknown" };
  }
}
function expectPrepared(store: StateStore, intent: Intent) {
  if (store.intent(intent.id)?.status !== "prepared")
    throw new Error("Intent must precede send");
}
export function fixture(path = ":memory:") {
  const clock = new FakeClock();
  const store = new StateStore(path, "paper:testnet:af1:l1", () => clock.now());
  const feeds = new FakeFeeds(clock);
  const af = new FakeAf(clock, store);
  const lighter = new FakeLighter(clock, store);
  const alerts: Alert[] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  config.strategy = structuredClone(configuredStrategy);
  config.mode = "paper";
  config.lighter.maxSlippageBps = 200;
  config.lighter.emergencySlippageBps = 300;
  const marketConfig = {
    ...required(DEFAULT_MARKETS[2]),
    clipUsd: 50,
    maxPositionUsd: 500,
  };
  const markets = resolveMarkets(
    [marketConfig],
    [afMarket()],
    [lighterMarket()],
  );
  const options = {
    mode: "paper" as const,
    config,
    markets,
    store,
    af,
    lighter,
    feeds,
    clock,
    alerts: {
      send: async (alert: Alert) => {
        alerts.push(alert);
      },
    },
  };
  const engine = new Engine(options);
  return {
    clock,
    store,
    feeds,
    af,
    lighter,
    alerts,
    config,
    markets,
    options,
    engine,
  };
}
