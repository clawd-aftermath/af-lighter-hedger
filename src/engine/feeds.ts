import type { RuntimeConfig } from "../config/schema";
import { AF_SCALE, lighterToInt } from "../core/units";
import type { Book, BookLevel } from "../domain/types";
import {
  type AfAccount,
  type AfMarkets,
  AfUpdates,
  normalizeMarket,
  type Orderbook,
  type RawMarket,
  restSnapshot,
} from "../venues/aftermath";
import {
  type Clock,
  historyHourly,
  type LighterRest,
  type LighterWs,
  type MarketStats,
  normalizeFunding,
} from "../venues/lighter";
import type { ResolvedMarket } from "./markets";
import type { OracleReader } from "./oracle";
import type { FeedEvent, Feeds, MarketView } from "./types";

export function afNumber(value: number): bigint {
  if (
    !Number.isFinite(value) ||
    Math.abs(value) * 1e9 > Number.MAX_SAFE_INTEGER
  )
    throw new Error("AF number exceeds exact supported range");
  return BigInt(Math.round(value * 1e9));
}
function levels(
  values: readonly { price: number; size: number }[],
): BookLevel[] {
  return values
    .filter((l) => l.size > 0)
    .map((l) => ({ price: afNumber(l.price), size: afNumber(l.size) }));
}
export function afBook(
  raw: Pick<Orderbook, "bids" | "asks">,
  ts: number,
): Book {
  return {
    bids: levels(raw.bids).sort((a, b) => (a.price > b.price ? -1 : 1)),
    asks: levels(raw.asks).sort((a, b) => (a.price < b.price ? -1 : 1)),
    priceScale: AF_SCALE,
    sizeScale: AF_SCALE,
    ts,
  };
}
export interface PublicFeedOptions {
  markets: readonly ResolvedMarket[];
  config: RuntimeConfig;
  oracle: Pick<OracleReader, "read">;
  afMarkets: AfMarkets;
  afAccount: AfAccount;
  lighterRest: LighterRest;
  lighterWs: LighterWs;
  clock: Clock;
  accountId?: bigint;
  onAfAccount?: (state: import("../venues/aftermath").AccountState) => void;
  onLighterAccount?: (
    state: import("../venues/lighter").Account,
    snapshot: boolean,
  ) => void;
}
export class PublicFeeds implements Feeds {
  private views = new Map<string, MarketView>();
  readonly afWs: AfUpdates;
  private listener?: (event: FeedEvent) => void;
  private detach: (() => void)[] = [];
  private started = false;
  private lighterOpened = false;
  private refreshTimer?: unknown;
  private oracleTimer?: unknown;
  private refreshing = false;
  private readingOracle = false;
  constructor(private options: PublicFeedOptions) {
    this.afWs = new AfUpdates({
      baseUrl: options.afMarkets.http.baseUrl,
      now: () => options.clock.now(),
      staleMs: options.config.risk.stalenessMs.liveness,
      snapshot: restSnapshot(options.afMarkets, options.afAccount),
    });
  }
  view(symbol: string): MarketView {
    const view = this.views.get(symbol);
    if (!view) throw new Error(`Missing feed snapshot ${symbol}`);
    return view;
  }
  private afMarket(id: string) {
    return this.options.markets.find((m) => m.af.id === id);
  }
  private lighterMarket(id: number) {
    return this.options.markets.find((m) => m.lighter.marketId === id);
  }
  private emit(symbol: string) {
    this.listener?.({
      type: "market",
      market: symbol,
      view: this.view(symbol),
    });
  }
  private emitAfPositions(account: import("../venues/aftermath").AccountState) {
    for (const m of this.options.markets) {
      const position = account.positions.find((p) => p.marketId === m.af.id);
      this.listener?.({
        type: "position",
        market: m.config.symbol,
        afPosition: {
          base: afNumber(position?.baseAssetAmount ?? 0),
          exists: position !== undefined,
        },
      });
    }
  }
  async refresh(): Promise<void> {
    const { markets, afMarkets, lighterRest, clock } = this.options;
    const [datas, books, lighterBooks, fundings, oracles] = await Promise.all([
      afMarkets.markets(markets.map((m) => m.af.id)),
      afMarkets.orderbooks(markets.map((m) => m.af.id)),
      Promise.all(
        markets.map((m) =>
          lighterRest.orderBookOrders(m.lighter.marketId, 100),
        ),
      ),
      Promise.all(
        markets.map((m) =>
          lighterRest.fundings(
            m.lighter.marketId,
            Math.floor(clock.now() / 1000) - 7200,
            Math.floor(clock.now() / 1000),
            2,
          ),
        ),
      ),
      this.options.oracle.read(),
    ]);
    for (const [index, m] of markets.entries()) {
      const data = datas.find((d) => d.market.objectId === m.af.id);
      const book = books.find((b) => b.marketId === m.af.id);
      const lb = lighterBooks[index];
      if (!data || !book || !lb)
        throw new Error("REST market snapshot incomplete");
      const latest = fundings[index]?.reduce<
        import("../venues/lighter").FundingRow | undefined
      >(
        (last, row) => (!last || row.timestamp > last.timestamp ? row : last),
        undefined,
      );
      const previous = this.views.get(m.config.symbol);
      const convert = (rows: typeof lb.asks) =>
        rows
          .map((l) => ({
            price: lighterToInt(l.price, 9, "down"),
            size: lighterToInt(l.remainingBaseAmount, 9, "down"),
          }))
          .filter((l) => l.size > 0n);
      this.views.set(m.config.symbol, {
        afBook: afBook(book.orderbook, clock.now()),
        lighterBook: {
          asks: convert(lb.asks).sort((a, b) => (a.price < b.price ? -1 : 1)),
          bids: convert(lb.bids).sort((a, b) => (a.price > b.price ? -1 : 1)),
          ts: clock.now(),
          priceScale: AF_SCALE,
          sizeScale: AF_SCALE,
        },
        index: oracles.get(m.config.symbol)?.price ?? 0n,
        oracleTs: oracles.get(m.config.symbol)?.timestamp ?? 0,
        marketTs: clock.now(),
        statsTs: previous?.statsTs ?? 0,
        afConnected: previous?.afConnected ?? true,
        afFrameTs: previous?.afFrameTs ?? clock.now(),
        lighterFrameTs: previous?.lighterFrameTs ?? clock.now(),
        lighterConnected: previous?.lighterConnected ?? true,
        af: normalizeMarket(data.market, data.metadata),
        openInterest: afNumber(Number(data.market.marketState.openInterest)),
        lighterHourlyFunding:
          previous?.lighterHourlyFunding ??
          (latest ? historyHourly(latest) : 0),
        fundingObserved: previous?.fundingObserved ?? false,
        cumulativeFunding: cumulativeFunding(data.market),
      });
    }
  }
  start(listener: (event: FeedEvent) => void): void {
    if (this.started) return;
    this.started = true;
    this.listener = listener;
    const { markets, lighterWs, clock, accountId } = this.options;
    for (const m of markets) {
      this.afWs.subscribe({
        topOfOrderbook: {
          marketId: m.af.id,
          priceBucketSize: Number(m.af.tickInt) / 1e9,
          bucketsNumber: 20,
        },
      });
      this.afWs.subscribe({ market: { marketId: m.af.id } });
      this.afWs.subscribe({ oracle: { marketId: m.af.id } });
      lighterWs.subscribeBook(m.lighter.marketId);
      lighterWs.subscribeMarketStats(m.lighter.marketId);
    }
    if (accountId !== undefined) {
      this.afWs.subscribe({ user: { accountId } });
      this.afWs.subscribe({ userOrders: { accountId } });
    }
    this.detach.push(
      this.afWs.on("snapshot", (snapshot) => {
        if ("topOfOrderbook" in snapshot.subscription) {
          const m = this.afMarket(
            snapshot.subscription.topOfOrderbook.marketId,
          );
          const raw = snapshot.value as { orderbook: Orderbook };
          if (m)
            this.view(m.config.symbol).afBook = afBook(
              raw.orderbook,
              clock.now(),
            );
        } else if ("market" in snapshot.subscription) {
          const data = snapshot.value as { market: RawMarket };
          this.updateMarket(data.market);
        } else if ("oracle" in snapshot.subscription) {
          const raw = snapshot.value as { marketId: string; basePrice: number };
          const m = this.afMarket(raw.marketId);
          if (m) {
            // REST prices lack source timestamps; the gRPC oracle poll owns them.
          }
        } else if ("user" in snapshot.subscription) {
          const account =
            snapshot.value as import("../venues/aftermath").AccountState;
          this.options.onAfAccount?.(account);
          this.emitAfPositions(account);
        }
      }),
      this.afWs.on("topOfOrderbook", (update) => {
        const m = this.afMarket(update.marketId);
        if (!m) return;
        this.view(m.config.symbol).afBook = afBook(update, clock.now());
        this.emit(m.config.symbol);
      }),
      this.afWs.on("market", (raw) => this.updateMarket(raw)),
      this.afWs.on("oracle", (update) => {
        const m = this.afMarket(update.marketId);
        if (!m) return;
        const v = this.view(m.config.symbol);
        // Price frames trigger planning; price/timestamp remain an atomic
        // pair from the authoritative on-chain storage read.
        void v;
        this.emit(m.config.symbol);
      }),
      this.afWs.on("user", (event) => {
        this.options.onAfAccount?.(event.account);
        this.emitAfPositions(event.account);
      }),
      this.afWs.on("userOrders", (event) => {
        for (const order of event.orders) {
          const m = this.afMarket(order.marketId);
          if (!m) continue;
          if (!/Filled/.test(order.eventType)) continue;
          if (!order.orderId) {
            this.listener?.({ type: "position", market: m.config.symbol });
            continue;
          }
          this.listener?.({
            type: "fill",
            fill: {
              marketId: m.config.symbol,
              txDigest: order.txDigest,
              orderId: order.orderId,
              side: order.side === 0 ? "BID" : "ASK",
              price: afNumber(order.price),
              size: afNumber(order.size),
              ts: order.timestamp,
            },
            fee: afNumber(order.fees ?? 0),
          });
        }
      }),
      this.afWs.on("activity", ({ ts }) => {
        for (const v of this.views.values()) v.afFrameTs = ts;
      }),
      this.afWs.on("connected", (event) => {
        for (const v of this.views.values()) v.afConnected = true;
        if (event.reconnected)
          this.listener?.({ type: "reconnect", venue: "af" });
      }),
      this.afWs.on("disconnected", () => this.disconnect("af")),
      this.afWs.on("stale", () => {
        this.disconnect("af");
        this.afWs.stop();
        if (this.started) this.afWs.start();
      }),
      this.afWs.on("resync", () => this.disconnect("af")),
      this.afWs.on("error", () => this.disconnect("af")),
    );
    const onBook = (book: import("../venues/lighter").Book) => {
      const m = this.lighterMarket(book.marketId);
      if (!m) return;
      const convert = (rows: ReadonlyMap<string, string>) =>
        [...rows]
          .map(([price, size]) => ({
            price: lighterToInt(price, 9, "down"),
            size: lighterToInt(size, 9, "down"),
          }))
          .filter((l) => l.size > 0n);
      this.view(m.config.symbol).lighterBook = {
        bids: convert(book.bids).sort((a, b) => (a.price > b.price ? -1 : 1)),
        asks: convert(book.asks).sort((a, b) => (a.price < b.price ? -1 : 1)),
        ts: book.receivedAt,
        priceScale: AF_SCALE,
        sizeScale: AF_SCALE,
      };
      this.emit(m.config.symbol);
    };
    const onStats = (stats: MarketStats) => {
      const m = this.lighterMarket(stats.marketId);
      if (!m) return;
      const funding = normalizeFunding(stats, m.lighter);
      const v = this.view(m.config.symbol);
      v.fundingObserved = funding.predictedHourly !== null;
      v.lighterHourlyFunding = funding.predictedHourly ?? 0;
      v.statsTs = clock.now();
      this.emit(m.config.symbol);
    };
    const onAccount = (event: {
      account: import("../venues/lighter").Account;
      snapshot: boolean;
    }) => {
      this.options.onLighterAccount?.(event.account, event.snapshot);
    };
    const onConnected = () => {
      for (const v of this.views.values()) v.lighterConnected = true;
      if (this.lighterOpened)
        this.listener?.({ type: "reconnect", venue: "lighter" });
      this.lighterOpened = true;
    };
    const onDisconnected = () => this.disconnect("lighter");
    const onActivity = () => {
      for (const v of this.views.values()) v.lighterFrameTs = clock.now();
    };
    const onStale = (event: { reason: string }) => {
      if (event.reason !== "timeout") onDisconnected();
    };
    lighterWs.on("book", onBook);
    lighterWs.on("marketStats", onStats);
    lighterWs.on("account", onAccount);
    lighterWs.on("connected", onConnected);
    lighterWs.on("disconnected", onDisconnected);
    lighterWs.on("raw", onActivity);
    lighterWs.on("stale", onStale);
    lighterWs.on("fault", onDisconnected);
    this.detach.push(() => {
      lighterWs.off("book", onBook);
      lighterWs.off("marketStats", onStats);
      lighterWs.off("account", onAccount);
      lighterWs.off("connected", onConnected);
      lighterWs.off("disconnected", onDisconnected);
      lighterWs.off("raw", onActivity);
      lighterWs.off("stale", onStale);
      lighterWs.off("fault", onDisconnected);
    });
    this.afWs.start();
    lighterWs.start();
    this.scheduleRefresh();
    this.scheduleOracle();
  }
  private updateMarket(raw: RawMarket): void {
    const m = this.afMarket(raw.objectId);
    if (!m) return;
    const v = this.view(m.config.symbol);
    v.af = normalizeMarket(raw, {
      symbol: v.af.symbol,
      category: v.af.category ?? "",
      collateralSymbol: "",
      session: v.af.session,
    });
    v.openInterest = afNumber(Number(raw.marketState.openInterest));
    v.marketTs = this.options.clock.now();
    v.cumulativeFunding = cumulativeFunding(raw);
    this.emit(m.config.symbol);
  }
  private disconnect(venue: "af" | "lighter"): void {
    for (const v of this.views.values())
      if (venue === "af") v.afConnected = false;
      else v.lighterConnected = false;
    this.listener?.({ type: "disconnect", venue });
  }
  private scheduleRefresh(): void {
    this.refreshTimer = this.options.clock.setTimeout(() => {
      void this.resnapshotAf()
        .catch(() => {
          /* Existing timestamps expire on failure. */
        })
        .finally(() => {
          if (this.started) this.scheduleRefresh();
        });
    }, this.options.config.aftermath.afResnapshotMs);
  }
  async resnapshotAf(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { afMarkets, markets, clock } = this.options;
      const ids = markets.map((m) => m.af.id);
      const [books, datas] = await Promise.all([
        afMarkets.orderbooks(ids),
        afMarkets.markets(ids),
      ]);
      for (const market of markets) {
        const book = books.find((b) => b.marketId === market.af.id),
          data = datas.find((d) => d.market.objectId === market.af.id);
        if (!book || !data) throw new Error("Incomplete AF resnapshot");
        this.view(market.config.symbol).afBook = afBook(
          book.orderbook,
          clock.now(),
        );
        this.updateMarket(data.market);
      }
    } finally {
      this.refreshing = false;
    }
  }
  private scheduleOracle(): void {
    this.oracleTimer = this.options.clock.setTimeout(() => {
      void this.refreshOracle()
        .catch(() => {
          /* Never freshen an unverified oracle. */
        })
        .finally(() => {
          if (this.started) this.scheduleOracle();
        });
    }, this.options.config.aftermath.oraclePollMs);
  }
  async refreshOracle(): Promise<void> {
    if (this.readingOracle) return;
    this.readingOracle = true;
    try {
      const prices = await this.options.oracle.read();
      for (const [symbol, price] of prices) {
        const view = this.view(symbol);
        view.index = price.price;
        view.oracleTs = price.timestamp;
        this.emit(symbol);
      }
    } finally {
      this.readingOracle = false;
    }
  }
  stop(): void {
    this.options.clock.clearTimeout(this.refreshTimer);
    this.options.clock.clearTimeout(this.oracleTimer);
    this.afWs.stop();
    this.options.lighterWs.stop();
    for (const detach of this.detach) detach();
    this.detach = [];
    this.listener = undefined;
    this.started = false;
  }
}

function cumulativeFunding(raw: RawMarket): MarketView["cumulativeFunding"] {
  const long = Number(raw.marketState.cumFundingRateLong),
    short = Number(raw.marketState.cumFundingRateShort),
    ts = Number(raw.marketState.fundingLastUpdateTimestamp);
  return Number.isFinite(long) &&
    Number.isFinite(short) &&
    Number.isSafeInteger(ts)
    ? { long, short, ts }
    : undefined;
}
