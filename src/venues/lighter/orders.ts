import { ConfigError, VenueError } from "../../core/errors";
import { lighterFromInt, lighterToInt, parseIdString } from "../../core/units";
import type { NonceManager } from "./nonce";
import type { LighterSigner, SignedTransaction } from "./signer";
import { MAX_CLIENT_ORDER_INDEX } from "./signer";
import type {
  Clock,
  Market,
  Order,
  Page,
  SendTxResult,
  Transaction,
} from "./types";
import {
  decimal,
  object,
  orderStatuses,
  parseOrder,
  systemClock,
} from "./types";
import type { LighterWs } from "./ws";

export interface HedgeRequest {
  marketId: number;
  side: "buy" | "sell";
  baseAmount: string;
  refPrice: string;
  maxSlippageBps: number;
  reduceOnly: boolean;
  clientOrderIndex: bigint;
}
function ratio(v: string): [bigint, bigint] {
  if (!/^\d+(?:\.\d+)?$/.test(v))
    throw new ConfigError("Expected unsigned decimal");
  const [w, f = ""] = v.split(".");
  return [BigInt(`${w}${f}`), 10n ** BigInt(f.length)];
}
function compare(a: string, b: string): number {
  const [an, ad] = ratio(a);
  const [bn, bd] = ratio(b);
  return an * bd < bn * ad ? -1 : an * bd > bn * ad ? 1 : 0;
}
function quotient(a: string, b: string): string {
  const [an, ad] = ratio(a);
  const [bn, bd] = ratio(b);
  if (bn === 0n) throw new ConfigError("Cannot divide by zero");
  return lighterFromInt((an * bd * 10n ** 18n) / (ad * bn), 18);
}
export function validateClientIndex(index: bigint): void {
  if (typeof index !== "bigint" || index < 1n || index > MAX_CLIENT_ORDER_INDEX)
    throw new ConfigError("clientOrderIndex must be from 1 to 2^48-1");
}
export function prepareHedge(
  request: HedgeRequest,
  market: Market,
): { baseAmount: bigint; worstPrice: bigint } {
  validateClientIndex(request.clientOrderIndex);
  if (
    market.marketId !== request.marketId ||
    market.status !== "active" ||
    market.marketType !== "perp"
  )
    throw new ConfigError("Hedge requires an active perpetual market");
  if (request.side !== "buy" && request.side !== "sell")
    throw new ConfigError("Invalid hedge side");
  if (
    !Number.isSafeInteger(request.maxSlippageBps) ||
    request.maxSlippageBps < 0 ||
    request.maxSlippageBps >= 500
  )
    throw new ConfigError("Slippage must be integer bps below 5%");
  const baseAmount = lighterToInt(
    request.baseAmount,
    market.sizeDecimals,
    "down",
  );
  const [n, d] = ratio(request.refPrice);
  if (n === 0n || baseAmount === 0n)
    throw new ConfigError("Hedge price and size must be positive");
  const bound =
    n *
    BigInt(10000 + (request.side === "buy" ? 1 : -1) * request.maxSlippageBps) *
    10n ** BigInt(market.priceDecimals);
  const denominator = d * 10000n;
  // Away from a fill: buys round the maximum down, sells round the minimum up.
  const worstPrice =
    bound / denominator +
    (request.side === "sell" && bound % denominator !== 0n ? 1n : 0n);
  if (
    worstPrice <= 0n ||
    worstPrice > 0xffff_ffffn ||
    baseAmount > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new ConfigError("Hedge exceeds signer numeric range");
  const roundedBase = lighterFromInt(baseAmount, market.sizeDecimals);
  const [bn, bd] = ratio(roundedBase);
  const [qn, qd] = ratio(market.minQuoteAmount);
  if (
    compare(roundedBase, market.minBaseAmount) < 0 ||
    bn * worstPrice * qd < qn * bd * 10n ** BigInt(market.priceDecimals)
  )
    throw new ConfigError("Hedge is below market minimum size or quote amount");
  // Even a configured <5% bound can cross the band because of coarse ticks.
  if (
    request.side === "buy"
      ? worstPrice * d * 100n >= n * 105n * 10n ** BigInt(market.priceDecimals)
      : worstPrice * d * 100n <= n * 95n * 10n ** BigInt(market.priceDecimals)
  )
    throw new ConfigError("Rounded price exceeds fat-finger band");
  return { baseAmount, worstPrice };
}
export interface HedgeResult {
  status: "filled" | "partial" | "canceled" | "failed";
  filledBase: string;
  avgPrice: string | null;
  fee: string | null;
  reason?: string;
  txHash: string;
  clientOrderIndex: bigint;
}
export class HedgeUnconfirmed extends VenueError {
  constructor(
    readonly txHash: string,
    readonly clientOrderIndex: bigint,
  ) {
    super(
      "Lighter hedge outcome is unconfirmed; reconcile before retry",
      "lighter",
      "UNCONFIRMED",
      true,
    );
  }
}
export class CancellationUnconfirmed extends VenueError {
  constructor(readonly txHash: string) {
    super(
      "Lighter cancellation is unconfirmed; reconcile before retry",
      "lighter",
      "UNCONFIRMED",
      true,
    );
  }
}
export interface OrderRest {
  orderBookDetails(marketId?: number): Promise<Market[]>;
  sendTx(tx: SignedTransaction): Promise<SendTxResult>;
  tx(hash: string): Promise<Transaction | undefined>;
  accountOrders(
    accountIndex: bigint,
    clientIndexes: bigint[],
  ): Promise<Page<Order>>;
}
export interface OrderOptions {
  rest: OrderRest;
  signer: Pick<
    LighterSigner,
    "SignCreateOrder" | "SignCancelOrder" | "SignCancelAllOrders"
  >;
  nonce: NonceManager;
  ws?: Pick<
    LighterWs,
    "on" | "off" | "subscribeAccountTx" | "subscribeAccountOrders"
  >;
  clock?: Clock;
  confirmationMs?: number;
  restPollMs?: number;
  restAttempts?: number;
}
export function resultFromOrder(
  order: Order,
  txHash: string,
  expectedBase?: string,
): HedgeResult | undefined {
  const filled = compare(decimal(order.filledBase), "0") > 0;
  if (expectedBase && compare(order.filledBase, expectedBase) > 0)
    return undefined;
  if (filled && compare(decimal(order.filledQuote), "0") <= 0) return undefined;
  const terminal =
    order.status === "filled" || order.status.startsWith("canceled");
  if (!terminal) return undefined;
  if (order.status === "filled" && !filled) return undefined;
  return {
    status:
      order.status === "filled" &&
      (!expectedBase || compare(order.filledBase, expectedBase) === 0)
        ? "filled"
        : filled
          ? "partial"
          : "canceled",
    filledBase: order.filledBase,
    avgPrice: filled ? quotient(order.filledQuote, order.filledBase) : null,
    fee: order.fee ?? null,
    reason: order.status.startsWith("canceled") ? order.status : undefined,
    txHash,
    clientOrderIndex: order.clientOrderIndex,
  };
}
// Compact execution events may include several fills. Require their aggregate
// size to agree with the final taker order; incomplete evidence falls back to REST.
function orderFromTransaction(
  tx: Transaction,
  client: bigint,
  market: Market,
): Order | undefined {
  let full: Order | undefined;
  const executions: {
    order: Record<string, unknown>;
    trade?: Record<string, unknown>;
  }[] = [];
  function visit(v: unknown): void {
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (!v || typeof v !== "object") return;
    const r = object(v);
    if (
      (r.client_order_index !== undefined || r.client_order_id !== undefined) &&
      (r.market_index ?? r.market_id) === market.marketId
    ) {
      const parsed = parseOrder(r);
      if (parsed.clientOrderIndex === client) full = parsed;
    }
    if (r.to && r.m === market.marketId) {
      const o = object(r.to);
      if (o.u !== undefined && parseIdString(o.u) === client)
        executions.push({ order: o, trade: r.t ? object(r.t) : undefined });
    }
    for (const value of Object.values(r)) visit(value);
  }
  visit(tx.eventInfo);
  if (full) return full;
  const final = executions.at(-1)?.order;
  if (!final || typeof final.st !== "number") return;
  const status = orderStatuses[final.st];
  if (!status || (status !== "filled" && !status.startsWith("canceled")))
    return;
  const initial = parseIdString(final.is);
  const remaining = parseIdString(final.rs);
  if (remaining > initial) return;
  let base = 0n;
  let quote = 0n;
  for (const e of executions)
    if (e.trade) {
      const size = parseIdString(e.trade.s);
      const price = parseIdString(e.trade.p);
      base += size;
      quote += size * price;
    }
  if (base !== initial - remaining || (status === "filled" && remaining !== 0n))
    return;
  return {
    clientOrderIndex: client,
    marketId: market.marketId,
    status,
    filledBase: lighterFromInt(base, market.sizeDecimals),
    filledQuote: lighterFromInt(
      quote,
      market.sizeDecimals + market.priceDecimals,
    ),
  };
}
function hasTrade(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some(hasTrade);
  const r = object(v);
  return !!r.t || Object.values(r).some(hasTrade);
}
function applicationError(v: unknown): string | undefined {
  if (!v || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const item of v) {
      const err = applicationError(item);
      if (err) return err;
    }
    return;
  }
  const r = object(v);
  if (typeof r.ae === "string" && r.ae) return "application-rejection";
  for (const value of Object.values(r)) {
    const err = applicationError(value);
    if (err) return err;
  }
  return;
}
export class HedgeOrders {
  private clock: Clock;
  private usedClients = new Set<bigint>();
  constructor(private options: OrderOptions) {
    this.clock = options.clock ?? systemClock;
  }
  async hedge(request: HedgeRequest): Promise<HedgeResult> {
    const market = (
      await this.options.rest.orderBookDetails(request.marketId)
    ).find((m) => m.marketId === request.marketId);
    if (!market) throw new ConfigError("Market metadata unavailable");
    const prepared = prepareHedge(request, market);
    if (this.usedClients.has(request.clientOrderIndex))
      throw new ConfigError(
        "clientOrderIndex already submitted; reconcile the original order",
      );
    const ws = this.options.ws;
    const account = this.options.nonce.accountIndex;
    const key = this.options.nonce.apiKeyIndex;
    ws?.subscribeAccountTx(account);
    ws?.subscribeAccountOrders(account, request.marketId);
    let hash = "";
    let eventResult: HedgeResult | undefined;
    let notify: (() => void) | undefined;
    const txEvents: Transaction[] = [];
    const matchOrder = (orders: Order[]) => {
      for (const order of orders)
        if (
          order.clientOrderIndex === request.clientOrderIndex &&
          order.marketId === request.marketId
        ) {
          let result: HedgeResult | undefined;
          try {
            result = resultFromOrder(
              order,
              hash,
              lighterFromInt(prepared.baseAmount, market.sizeDecimals),
            );
          } catch {
            continue;
          }
          if (result) {
            eventResult = result;
            notify?.();
          }
        }
    };
    const matchTx = (tx: Transaction) => {
      if (tx.hash !== hash) return;
      if (tx.state === "executed") {
        try {
          const order = orderFromTransaction(
            tx,
            request.clientOrderIndex,
            market,
          );
          if (order) {
            matchOrder([order]);
            if (eventResult) return;
          }
        } catch {
          return;
        }
      }
      if (
        tx.state === "failed" ||
        (tx.state === "executed" &&
          applicationError(tx.eventInfo) &&
          !hasTrade(tx.eventInfo))
      ) {
        eventResult = {
          status: "failed",
          filledBase: "0",
          avgPrice: null,
          fee: null,
          reason:
            tx.state === "failed"
              ? "transaction-failed"
              : "application-rejection",
          txHash: hash,
          clientOrderIndex: request.clientOrderIndex,
        };
        notify?.();
        return;
      }
    };
    const onOrders = (e: { channel: string; orders: Order[] }) => {
      if (
        e.channel === `account_orders/${request.marketId}/${account}` ||
        e.channel === `account_all_orders/${account}`
      )
        matchOrder(e.orders);
    };
    const onTx = (e: { channel: string; transaction: Transaction }) => {
      if (e.channel === `account_tx/${account}`) {
        if (hash) matchTx(e.transaction);
        else if (txEvents.length < 100) txEvents.push(e.transaction);
      }
    };
    ws?.on("orders", onOrders);
    ws?.on("transaction", onTx);
    try {
      this.usedClients.add(request.clientOrderIndex);
      let apiFailure: number | undefined;
      try {
        const sent = await this.options.nonce.submit(
          (nonce) => {
            const tx = this.options.signer.SignCreateOrder(
              request.marketId,
              request.clientOrderIndex,
              prepared.baseAmount,
              prepared.worstPrice,
              request.side === "sell" ? 1 : 0,
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
              key,
              account,
            );
            hash = tx.txHash;
            return tx;
          },
          (tx) => this.options.rest.sendTx(tx),
        );
        if (sent.response.code !== 200) apiFailure = sent.response.code;
        if (sent.response.txHash && sent.response.txHash !== hash)
          throw new HedgeUnconfirmed(hash, request.clientOrderIndex);
      } catch (e) {
        if (!hash) {
          this.usedClients.delete(request.clientOrderIndex);
          throw e;
        }
      }
      if (apiFailure !== undefined)
        return {
          status: "failed",
          filledBase: "0",
          avgPrice: null,
          fee: null,
          reason: `api-${apiFailure}`,
          txHash: hash,
          clientOrderIndex: request.clientOrderIndex,
        };
      for (const tx of txEvents) matchTx(tx);
      if (!eventResult && ws)
        await new Promise<void>((resolve) => {
          const timer = this.clock.setTimeout(() => {
            notify = undefined;
            resolve();
          }, this.options.confirmationMs ?? 5000);
          notify = () => {
            this.clock.clearTimeout(timer);
            notify = undefined;
            resolve();
          };
          if (eventResult) notify();
        });
      if (eventResult) {
        eventResult.txHash = hash;
        return eventResult;
      }
      for (
        let attempt = 0;
        attempt < (this.options.restAttempts ?? 3);
        attempt++
      ) {
        const results = await Promise.allSettled([
          this.options.nonce.resolveUnknown(hash),
          this.options.rest.accountOrders(account, [request.clientOrderIndex]),
        ]);
        const orders = results[1];
        if (orders.status === "fulfilled") matchOrder(orders.value.items);
        if (eventResult) return eventResult;
        const resolution = results[0];
        if (resolution.status === "fulfilled" && resolution.value.transaction)
          matchTx(resolution.value.transaction);
        if (eventResult) return eventResult;
        if (
          resolution.status === "fulfilled" &&
          resolution.value.status === "failed"
        )
          return {
            status: "failed",
            filledBase: "0",
            avgPrice: null,
            fee: null,
            reason: "transaction-failed",
            txHash: hash,
            clientOrderIndex: request.clientOrderIndex,
          };
        // Successful placement alone says nothing about the order's fill.
        if (attempt + 1 < (this.options.restAttempts ?? 3))
          await new Promise<void>((r) =>
            this.clock.setTimeout(r, this.options.restPollMs ?? 500),
          );
      }
      throw new HedgeUnconfirmed(hash, request.clientOrderIndex);
    } finally {
      ws?.off("orders", onOrders);
      ws?.off("transaction", onTx);
    }
  }
  cancelByClientIndex(
    marketId: number,
    clientOrderIndex: bigint,
  ): Promise<Transaction> {
    validateClientIndex(clientOrderIndex);
    return this.cancel((nonce) =>
      this.options.signer.SignCancelOrder(
        marketId,
        clientOrderIndex,
        0,
        nonce,
        this.options.nonce.apiKeyIndex,
        this.options.nonce.accountIndex,
      ),
    );
  }
  cancelAll(): Promise<Transaction> {
    return this.cancel((nonce) =>
      this.options.signer.SignCancelAllOrders(
        0,
        0,
        255,
        0,
        nonce,
        this.options.nonce.apiKeyIndex,
        this.options.nonce.accountIndex,
      ),
    );
  }
  private async cancel(
    sign: (nonce: bigint) => SignedTransaction,
  ): Promise<Transaction> {
    let hash = "";
    try {
      const sent = await this.options.nonce.submit(
        (nonce) => {
          const tx = sign(nonce);
          hash = tx.txHash;
          return tx;
        },
        (tx) => this.options.rest.sendTx(tx),
      );
      if (sent.response.code !== 200) return { hash, state: "failed" };
    } catch (e) {
      if (!hash) throw e;
    }
    for (
      let attempt = 0;
      attempt < (this.options.restAttempts ?? 3);
      attempt++
    ) {
      try {
        const result = await this.options.nonce.resolveUnknown(hash);
        if (result.status === "executed" || result.status === "failed")
          return { hash, state: result.status };
      } catch {
        /* Keep the original transaction blocked and try a fresh read. */
      }
      if (attempt + 1 < (this.options.restAttempts ?? 3))
        await new Promise<void>((r) =>
          this.clock.setTimeout(r, this.options.restPollMs ?? 500),
        );
    }
    throw new CancellationUnconfirmed(hash);
  }
}
