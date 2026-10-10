import type { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  AF_SCALE,
  afIntToDecimal,
  lighterFromInt,
  lighterToInt,
} from "../core/units";
import type { OwnOrder, Side } from "../domain/types";
import type { FundingPayment, Intent, StateStore } from "../state/store";
import { outsideBook } from "../strategy/quoter";
import {
  type AccountRequest,
  type AccountState,
  type AfAccount,
  type AfBuilders,
  type AfExecutor,
  type BuiltTransaction,
  type ExecutionReceipt,
  OrderType,
  parseExecution,
  type SponsorConfig,
} from "../venues/aftermath";
import {
  type Clock,
  HedgeOrders,
  type HedgeResult,
  LighterAccount,
  type LighterRest,
  type LighterSigner,
  type LighterWs,
  type NonceManager,
  type OrderOptions,
  prepareHedge,
  resultFromOrder,
  type SignedTransaction,
} from "../venues/lighter";
import { clampPostOnly } from "./book";
import { afNumber } from "./feeds";
import { recordAfFunding } from "./funding";
import type { ResolvedMarket } from "./markets";
import type {
  AccountPosition,
  AfReceipt,
  AfVenue,
  Feeds,
  HedgeSubmission,
  LighterVenue,
  QuoteRequest,
  Resolution,
  SendContext,
} from "./types";

export interface RealAfOptions {
  markets: readonly ResolvedMarket[];
  account: AfAccount;
  builders: AfBuilders;
  executor: AfExecutor;
  client: SuiGrpcClient;
  identity: AccountRequest;
  feeds: Feeds;
  store: StateStore;
  clock: Clock;
  dry?: boolean;
}
export class RealAfVenue implements AfVenue {
  constructor(private options: RealAfOptions) {}
  apply(state: AccountState): void {
    if (state.accountId !== this.options.identity.accountId)
      throw new Error("AF account identity mismatch");
  }
  private market(symbol: string) {
    const m = this.options.markets.find((m) => m.config.symbol === symbol);
    if (!m) throw new Error("Unknown AF market");
    return m;
  }
  private async snapshot() {
    // Operational checks always use a fresh REST positions response, which also
    // provides every pending exchange order id for complete cancellation.
    const value = (
      await this.options.account.snapshot(this.options.identity.accountId)
    ).state;
    this.apply(value);
    return value;
  }
  async position(symbol: string): Promise<AccountPosition> {
    const m = this.market(symbol);
    const state = await this.snapshot();
    const position = state.positions.find((p) => p.marketId === m.af.id);
    const stored = this.options.store.orders(symbol);
    const orders = (position?.pendingOrders ?? []).map((p) => {
      const order = stored.find(
        (o) => o.clientOrderId === String(p.clientOrderId),
      );
      return {
        ...order,
        marketId: symbol,
        clientOrderId:
          p.clientOrderId === null
            ? `order:${p.orderId}`
            : String(p.clientOrderId),
        side: p.side === 0 ? ("BID" as const) : ("ASK" as const),
        price: order?.price ?? 0n,
        size: p.currentSize,
        reduceOnly: order?.reduceOnly ?? false,
        orderId: p.orderId,
      };
    });
    const equity = afNumber(state.totalEquityUsd);
    const available = afNumber(
      position?.freeMarginUsd ?? state.availableCollateralUsd,
    );
    return {
      base: afNumber(position?.baseAssetAmount ?? 0),
      exists: position !== undefined,
      fresh: true,
      ts: this.options.clock.now(),
      marginHeadroomPct:
        equity > 0n
          ? Math.max(
              0,
              Math.min(100, Number((available * 10000n) / equity) / 100),
            )
          : 0,
      availableUsd: available > 0n ? available : 0n,
      equityUsd: equity,
      orders,
    };
  }
  private receipt(result: ExecutionReceipt): AfReceipt {
    // Convert gas only with a measured SUI/USD price; missing conversion is
    // retained as native MIST in the intent receipt instead of inventing USD.
    const sui = this.options.markets.find((m) => m.config.symbol === "SUI");
    let suiPrice = this.options.store.get<bigint>("sui_usd_price");
    if (sui)
      try {
        suiPrice = this.options.feeds.view("SUI").index;
      } catch {
        /* Startup cancellation can precede public feed initialization. */
      }
    return {
      status: result.status,
      digest: result.digest,
      updatedPremiumTwap: result.updatedPremiumTwap,
      gasUsedMist: result.gasUsed,
      gasUsd: suiPrice ? (result.gasUsed * suiPrice) / AF_SCALE : 0n,
      simulated: result.simulated,
    };
  }
  private async execute(
    context: SendContext,
    build: (sponsor?: SponsorConfig) => Promise<BuiltTransaction>,
  ): Promise<AfReceipt> {
    const result = this.options.dry
      ? await this.options.executor.simulate(build)
      : await this.options.executor.submit(build, (digest) =>
          context.beforeSend(digest),
        );
    this.options.store.set(`af:receipt:${context.intent.id}`, result);
    return this.receipt(result);
  }
  quote(request: QuoteRequest, context: SendContext): Promise<AfReceipt> {
    const m = this.market(request.market);
    let actualOrders: OwnOrder[] = [];
    return this.execute(context, async (sponsor) => {
      const position = await this.position(request.market);
      const view = this.options.feeds.view(request.market);
      if (!view.afConnected || this.options.clock.now() - view.afBook.ts > 5000)
        throw new Error("AF prebuild book stale");
      const book = outsideBook(
        view.afBook,
        this.options.store.orders(request.market),
      );
      actualOrders = request.orders.flatMap((o) => {
        const price = clampPostOnly(o.price, o.side, m.af.tickInt, book);
        const cap = request.maxOrderNotional
          ? ((request.maxOrderNotional * AF_SCALE) / price / m.jointStep) *
            m.jointStep
          : o.size;
        const size = cap < o.size ? cap : o.size;
        return size > 0n && (size * price) / AF_SCALE >= m.minNotional
          ? [{ ...o, price, size }]
          : [];
      });
      const orders = actualOrders.map((o) => ({
        side: o.side === "BID" ? (0 as const) : (1 as const),
        price: o.price,
        size: o.size,
        clientOrderId: BigInt(o.clientOrderId),
      }));
      return this.options.builders.cancelAndPlaceOrders(
        {
          ...this.options.identity,
          sponsor,
          marketId: m.af.id,
          orderType: OrderType.POST_ONLY,
          reduceOnly: request.reduceOnly,
          hasPosition: position.exists,
          ordersToPlace: orders,
          clientOrderIdsToCancel: request.cancel.map(BigInt),
          shouldAbortOnMissingId: false,
          expiryTimestamp: BigInt(request.expiryTimestamp),
        },
        view.af,
        position.orders.filter((o) => !request.cancel.includes(o.clientOrderId))
          .length,
      );
    }).then((receipt) => ({ ...receipt, placedOrders: actualOrders }));
  }
  cancel(
    symbol: string,
    _orders: readonly OwnOrder[],
    context: SendContext,
  ): Promise<AfReceipt> {
    const m = this.market(symbol);
    return this.execute(context, async (sponsor) => {
      const state = await this.snapshot();
      const pending =
        state.positions.find((p) => p.marketId === m.af.id)?.pendingOrders ??
        [];
      return this.options.builders.cancelOrders({
        ...this.options.identity,
        sponsor,
        marketIdsToData: {
          [m.af.id]: {
            orderIds: pending
              .filter((o) => o.clientOrderId === null)
              .map((o) => o.orderId),
            clientOrderIds: pending
              .filter((o) => o.clientOrderId !== null)
              .map((o) => o.clientOrderId as bigint),
            collateralChange: 0,
          },
        },
        shouldAbortOnMissingId: false,
      });
    });
  }
  flatten(
    symbol: string,
    side: Side,
    size: bigint,
    slippageBps: number,
    context: SendContext,
  ): Promise<AfReceipt> {
    const m = this.market(symbol);
    return this.execute(context, async (sponsor) => {
      const p = await this.position(symbol);
      return this.options.builders.placeMarketOrder(
        {
          ...this.options.identity,
          sponsor,
          marketId: m.af.id,
          side: side === "BID" ? 0 : 1,
          size,
          hasPosition: p.exists,
          reduceOnly: true,
          slippage: slippageBps / 10000,
          collateralChange: 0,
          cancelSlTp: true,
        },
        this.options.feeds.view(symbol).af,
      );
    });
  }
  async resolve(intent: Intent): Promise<Resolution> {
    // History and positions are refreshed even when the digest lookup is lost.
    // An absent order is never treated as proof that an AF transaction failed.
    const results = await Promise.allSettled([
      this.snapshot(),
      this.options.account.orderHistoryDetailed(
        this.options.identity.accountId,
      ),
      intent.txHash
        ? this.options.client.getTransaction({
            digest: intent.txHash,
            include: { effects: true, events: true },
          })
        : Promise.resolve(null),
    ]);
    if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled")
      return { status: "unknown" };
    const tx = results[2];
    if (tx.status !== "fulfilled" || !tx.value) return { status: "unknown" };
    const result = parseExecution(tx.value);
    return {
      status: result.status === "success" ? "confirmed" : "failed",
      result: this.receipt(result),
    };
  }
  async funding(): Promise<FundingPayment[]> {
    const state = await this.snapshot();
    const payments: FundingPayment[] = [];
    for (const market of this.options.markets) {
      const symbol = market.config.symbol;
      const position = state.positions.find((p) => p.marketId === market.af.id);
      const view = this.options.feeds.view(symbol);
      const current = view.cumulativeFunding;
      if (!current) continue;
      payments.push(
        ...recordAfFunding(
          this.options.store,
          symbol,
          afNumber(position?.baseAssetAmount ?? 0),
          current,
        ),
      );
    }
    return payments;
  }
}
export interface RealLighterOptions {
  markets: readonly ResolvedMarket[];
  rest: LighterRest;
  signer: LighterSigner;
  nonce: NonceManager;
  ws?: LighterWs;
  store: StateStore;
  clock: Clock;
}
export class RealLighterVenue implements LighterVenue {
  readonly account: LighterAccount;
  private orders: HedgeOrders;
  private context?: SendContext;
  private tail = Promise.resolve();
  constructor(private options: RealLighterOptions) {
    this.account = new LighterAccount(
      options.nonce.accountIndex,
      new Map(options.markets.map((m) => [m.lighter.marketId, m.lighter])),
      options.clock,
    );
    const rest: OrderOptions["rest"] = {
      orderBookDetails: (id) => options.rest.orderBookDetails(id),
      tx: (hash) => options.rest.tx(hash),
      accountOrders: (account, clients) =>
        options.rest.accountOrders(account, clients),
      sendTx: async (tx) => {
        if (!this.context)
          throw new Error("Submission requires an intent context");
        this.context.beforeSend(tx.txHash);
        options.store.set(`lighter:signed:${this.context.intent.id}`, {
          txHash: tx.txHash,
        });
        return options.rest.sendTx(tx);
      },
    };
    this.orders = new HedgeOrders({
      rest,
      signer: options.signer,
      nonce: options.nonce,
      ws: options.ws,
      clock: options.clock,
    });
  }
  private market(symbol: string) {
    const market = this.options.markets.find((m) => m.config.symbol === symbol);
    if (!market) throw new Error("Unknown Lighter market");
    return market;
  }
  async position(symbol: string): Promise<AccountPosition> {
    const m = this.market(symbol);
    await this.account.refresh(this.options.rest);
    const snapshot = this.account.snapshot();
    if (snapshot.status !== "fresh")
      return {
        base: 0n,
        exists: false,
        fresh: false,
        ts: 0,
        marginHeadroomPct: 0,
        availableUsd: 0n,
        equityUsd: 0n,
        orders: [],
      };
    const available = lighterToInt(snapshot.availableCollateral, 9, "down");
    const equity = lighterToInt(snapshot.collateral, 9, "down");
    return {
      base: m.toAf(
        snapshot.positions.get(m.lighter.marketId)?.signedBaseInt ?? 0n,
      ),
      exists: true,
      fresh: true,
      ts: snapshot.receivedAt,
      marginHeadroomPct:
        equity > 0n
          ? Math.max(
              0,
              Math.min(100, Number((available * 10000n) / equity) / 100),
            )
          : 0,
      availableUsd: available,
      equityUsd: equity,
      orders: [],
    };
  }
  hedge(request: HedgeSubmission, context: SendContext): Promise<HedgeResult> {
    const job = this.tail.then(async () => {
      this.context = context;
      try {
        const m = this.market(request.intent.marketId);
        return await this.orders.hedge({
          marketId: m.lighter.marketId,
          side: request.intent.side === "BID" ? "buy" : "sell",
          baseAmount: lighterFromInt(
            request.baseAmount,
            m.lighter.sizeDecimals,
          ),
          refPrice: afIntToDecimal(request.refPrice),
          maxSlippageBps: request.intent.slippageBps,
          reduceOnly: request.reduceOnly,
          clientOrderIndex: request.intent.clientOrderIndex,
        });
      } finally {
        this.context = undefined;
      }
    });
    this.tail = job.then(
      () => {},
      () => {},
    );
    return job;
  }
  async resolve(intent: Intent): Promise<Resolution> {
    if (!intent.txHash) return { status: "unknown" };
    const [tx, orders] = await Promise.allSettled([
      this.options.nonce.resolveUnknown(intent.txHash),
      this.options.rest.accountOrders(this.options.nonce.accountIndex, [
        BigInt(intent.clientId),
      ]),
    ]);
    if (
      tx.status !== "fulfilled" ||
      tx.value.status === "unknown" ||
      tx.value.status === "pending" ||
      orders.status !== "fulfilled"
    )
      return { status: "unknown" };
    const request = intent.payload as HedgeSubmission;
    const m = this.market(intent.market);
    const order = orders.value.items.find(
      (o) =>
        o.clientOrderIndex === BigInt(intent.clientId) &&
        o.marketId === m.lighter.marketId,
    );
    if (order) {
      const result = resultFromOrder(
        order,
        intent.txHash,
        lighterFromInt(request.baseAmount, m.lighter.sizeDecimals),
      );
      if (result) return { status: "confirmed", result };
    }
    if (tx.value.status === "failed")
      return {
        status: "failed",
        result: {
          status: "failed",
          filledBase: "0",
          avgPrice: null,
          fee: null,
          txHash: intent.txHash,
          clientOrderIndex: BigInt(intent.clientId),
        },
      };
    return { status: "unknown" };
  }
  async funding(): Promise<FundingPayment[]> {
    const result: FundingPayment[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.options.rest.positionFunding(
        this.options.nonce.accountIndex,
        100,
        cursor,
        this.options.markets.map((m) => m.lighter.marketId),
      );
      for (const row of page.items) {
        const market = this.options.markets.find(
          (m) => m.lighter.marketId === row.marketId,
        );
        if (!market) continue;
        result.push({
          venue: "lighter",
          market: market.config.symbol,
          ts: row.timestamp,
          amount: row.change.startsWith("-")
            ? -lighterToInt(row.change.slice(1), 9, "down")
            : lighterToInt(row.change, 9, "down"),
          key: String(row.fundingId),
          source: "venue",
        });
      }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor))
        throw new Error("Lighter funding pagination repeated");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return result;
  }
  signOffline(request: HedgeSubmission, nonce: bigint): SignedTransaction {
    const m = this.market(request.intent.marketId);
    const prepared = prepareHedge(
      {
        marketId: m.lighter.marketId,
        side: request.intent.side === "BID" ? "buy" : "sell",
        baseAmount: lighterFromInt(request.baseAmount, m.lighter.sizeDecimals),
        refPrice: afIntToDecimal(request.refPrice),
        maxSlippageBps: request.intent.slippageBps,
        reduceOnly: request.reduceOnly,
        clientOrderIndex: request.intent.clientOrderIndex,
      },
      m.lighter,
    );
    return this.options.signer.SignCreateOrder(
      m.lighter.marketId,
      request.intent.clientOrderIndex,
      prepared.baseAmount,
      prepared.worstPrice,
      request.intent.side === "ASK" ? 1 : 0,
      1,
      0,
      request.reduceOnly ? 1 : 0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      nonce,
      this.options.nonce.apiKeyIndex,
      this.options.nonce.accountIndex,
    );
  }
  stop(): void {
    this.account.stop();
  }
}
