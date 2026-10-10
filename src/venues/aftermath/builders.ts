import { AF_SCALE } from "../../core/units";
import type { AfHttp } from "./http";
import type { AfMarket, BuiltTransaction, SponsorConfig } from "./types";

export enum OrderType {
  GTC = 0,
  FOK = 1,
  POST_ONLY = 2,
  IOC = 3,
}
export interface AccountRequest {
  walletAddress: string;
  accountId: bigint;
  accountCapId?: string;
  sponsor?: SponsorConfig;
}
export interface LimitOrder {
  side: 0 | 1;
  price: bigint;
  size: bigint;
  clientOrderId?: bigint;
}
export interface CancelAndPlaceRequest extends AccountRequest {
  marketId: string;
  orderType: OrderType;
  reduceOnly: boolean;
  hasPosition: boolean;
  ordersToPlace: LimitOrder[];
  orderIdsToCancel?: bigint[];
  clientOrderIdsToCancel?: bigint[];
  expiryTimestamp?: bigint;
  leverage?: number;
  shouldAbortOnMissingId?: boolean;
  shouldDeallocateFreeCollateral?: boolean;
}
export interface CancelRequest extends AccountRequest {
  marketIdsToData: Record<
    string,
    { orderIds: bigint[]; clientOrderIds?: bigint[]; collateralChange: number }
  >;
  shouldAbortOnMissingId?: boolean;
}
export interface MarketOrderRequest extends AccountRequest {
  marketId: string;
  side: 0 | 1;
  size: bigint;
  hasPosition: boolean;
  reduceOnly: true;
  slippage: number;
  collateralChange: number;
  cancelSlTp: boolean;
}
function unsigned(v: bigint, name: string): void {
  if (typeof v !== "bigint" || v < 0n)
    throw new Error(`${name} must be an unsigned bigint`);
}
function account(r: AccountRequest): void {
  unsigned(r.accountId, "accountId");
  if (!r.walletAddress) throw new Error("walletAddress required");
  if (
    r.sponsor &&
    (!r.sponsor.walletAddress || !r.sponsor.bytes || !r.sponsor.signature)
  )
    throw new Error("Complete sponsor terms auth required");
}
function ids(values: readonly bigint[] = []): void {
  for (const v of values) unsigned(v, "order ID");
}
function marketMatch(marketId: string, market: AfMarket): void {
  if (marketId !== market.id) throw new Error("Market mismatch");
}
export function validateOrder(order: LimitOrder, market: AfMarket): void {
  if (order.side !== 0 && order.side !== 1) throw new Error("Invalid side");
  if (
    order.price <= 0n ||
    market.tickInt <= 0n ||
    order.price % market.tickInt !== 0n
  )
    throw new Error("Price must be a positive tick multiple");
  if (
    order.size <= 0n ||
    market.lotInt <= 0n ||
    order.size % market.lotInt !== 0n
  )
    throw new Error("Size must be a positive lot multiple");
  // Compare fixed-point notionals without rounding a large order to a float.
  const minimum = BigInt(Math.ceil(market.minOrderUsd * Number(AF_SCALE)));
  if (order.price * order.size < minimum * AF_SCALE)
    throw new Error("Order below minimum USD notional");
  if (order.clientOrderId !== undefined)
    unsigned(order.clientOrderId, "clientOrderId");
}
export class AfBuilders {
  constructor(readonly http: AfHttp) {}
  private async build(route: string, body: unknown): Promise<BuiltTransaction> {
    const result = await this.http.post<{
      txKind: string;
      sponsorSignature?: string | null;
    }>(`/api/perpetuals/account/transactions/${route}`, body);
    if (
      typeof result.txKind !== "string" ||
      !result.txKind ||
      (result.sponsorSignature != null &&
        typeof result.sponsorSignature !== "string")
    )
      throw new Error("Invalid transaction builder response");
    return {
      txKind: result.txKind,
      sponsorSignature: result.sponsorSignature ?? null,
    };
  }
  cancelAndPlaceOrders(
    request: CancelAndPlaceRequest,
    market: AfMarket,
    pendingAfterCancel = 0,
  ): Promise<BuiltTransaction> {
    account(request);
    marketMatch(request.marketId, market);
    if (![0, 1, 2, 3].includes(request.orderType))
      throw new Error("Invalid orderType");
    if (
      !Number.isInteger(pendingAfterCancel) ||
      pendingAfterCancel < 0 ||
      request.ordersToPlace.length + pendingAfterCancel >
        market.maxPendingOrders
    )
      throw new Error("Too many pending orders");
    for (const order of request.ordersToPlace) validateOrder(order, market);
    ids(request.orderIdsToCancel);
    ids(request.clientOrderIdsToCancel);
    if (request.expiryTimestamp !== undefined)
      unsigned(request.expiryTimestamp, "expiryTimestamp");
    return this.build("cancel-and-place-orders", {
      ...request,
      shouldAbortOnMissingId: request.shouldAbortOnMissingId ?? false,
      shouldDeallocateFreeCollateral:
        request.shouldDeallocateFreeCollateral ?? false,
    });
  }
  cancelOrders(request: CancelRequest): Promise<BuiltTransaction> {
    account(request);
    for (const data of Object.values(request.marketIdsToData)) {
      ids(data.orderIds);
      ids(data.clientOrderIds);
      if (!Number.isFinite(data.collateralChange))
        throw new Error("Invalid collateralChange");
    }
    return this.build("cancel-orders", {
      ...request,
      shouldAbortOnMissingId: request.shouldAbortOnMissingId ?? false,
    });
  }
  placeMarketOrder(
    request: MarketOrderRequest,
    market: AfMarket,
  ): Promise<BuiltTransaction> {
    account(request);
    marketMatch(request.marketId, market);
    if (request.reduceOnly !== true || request.hasPosition !== true)
      throw new Error("Unwind requires a position and reduceOnly");
    if (
      !Number.isFinite(request.slippage) ||
      request.slippage < 0 ||
      request.slippage >= 1
    )
      throw new Error("Invalid slippage");
    if (!Number.isFinite(request.collateralChange))
      throw new Error("Invalid collateralChange");
    const price = BigInt(Math.floor(market.indexPrice * Number(AF_SCALE)));
    // Market orders have no tick price; validate size and minimum using index.
    validateOrder(
      {
        side: request.side,
        size: request.size,
        price: (price / market.tickInt) * market.tickInt,
      },
      market,
    );
    return this.build("place-market-order", request);
  }
  allocateCollateral(
    request: AccountRequest & { marketId: string; allocateAmount: bigint },
  ): Promise<BuiltTransaction> {
    account(request);
    unsigned(request.allocateAmount, "allocateAmount");
    if (request.allocateAmount === 0n)
      throw new Error("Positive allocation required");
    return this.build("allocate-collateral", request);
  }
  depositCollateral(
    request: AccountRequest & {
      collateralCoinType: string;
      depositAmount: bigint;
    },
  ): Promise<BuiltTransaction> {
    account(request);
    unsigned(request.depositAmount, "depositAmount");
    if (request.depositAmount === 0n)
      throw new Error("Positive deposit required");
    return this.build("deposit-collateral", request);
  }
  grantAgentWallet(request: {
    accountId: bigint;
    recipientAddress: string;
    sponsor?: SponsorConfig;
  }): Promise<BuiltTransaction> {
    unsigned(request.accountId, "accountId");
    if (!request.recipientAddress) throw new Error("recipientAddress required");
    return this.build("grant-agent-wallet", request);
  }
}
