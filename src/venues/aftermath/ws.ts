import type { AfAccount } from "./account";
import { parseAf, stringifyAf } from "./http";
import type { AfMarkets } from "./markets";
import type { AccountOrderEvent, AccountState, RawMarket } from "./types";

export type Subscription =
  | { orderbook: { marketId: string } }
  | {
      topOfOrderbook: {
        marketId: string;
        priceBucketSize: number;
        bucketsNumber: number;
      };
    }
  | { market: { marketId: string } }
  | { oracle: { marketId: string } }
  | { user: { accountId: bigint } }
  | { userOrders: { accountId: bigint } };
export interface OrderbookDelta {
  marketId: string;
  orderbookDeltas: {
    asksDeltas: { size: number; price: number }[];
    bidsDeltas: { size: number; price: number }[];
    asksTotalSizeDelta: number;
    bidsTotalSizeDelta: number;
    nonce: bigint;
  };
}
export interface OracleUpdate {
  marketId: string;
  basePrice: number;
  collateralPrice: number;
  markPrice: number;
  bookPrice: number;
}
export interface UserUpdate {
  account: AccountState;
  stopOrders?: Record<string, unknown>[] | null;
  twapOrders?: Record<string, unknown>[] | null;
}
export interface UserOrderUpdate {
  accountId: bigint;
  orders: AccountOrderEvent[];
}
export interface TopOfOrderbook {
  marketId: string;
  bids: {
    price: number;
    size: number;
    totalSize: number;
    sizeUsd: number;
    totalSizeUsd: number;
  }[];
  asks: {
    price: number;
    size: number;
    totalSize: number;
    sizeUsd: number;
    totalSizeUsd: number;
  }[];
  minAskPrice?: number | null;
  maxBidPrice?: number | null;
}
export interface WsEvents {
  orderbook: OrderbookDelta;
  topOfOrderbook: TopOfOrderbook;
  market: RawMarket;
  oracle: OracleUpdate;
  user: UserUpdate;
  userOrders: UserOrderUpdate;
  snapshot: { subscription: Subscription; value: unknown };
  connected: { reconnected: boolean };
  disconnected: undefined;
  resync: { reason: string };
  stale: { lastMessageAt: number; ageMs: number };
  error: Error;
  activity: { ts: number };
}
export interface Socket {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(): void;
}
export interface WsOptions {
  baseUrl: string;
  userAgent?: string;
  socketFactory?: (url: string) => Socket;
  // Must fetch a fresh REST snapshot for the subscription. Each socket open
  // (including initial open) awaits it before delivering any buffered deltas.
  snapshot: (subscription: Subscription) => Promise<unknown>;
  staleMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxBufferedMessages?: number;
  now?: () => number;
  random?: () => number;
}
export class AfUpdates {
  private readonly listeners = new Map<
    keyof WsEvents,
    Set<(payload: never) => void>
  >();
  private readonly subscriptions = new Map<string, Subscription>();
  private socket?: Socket;
  private stopped = true;
  private ready = false;
  private generation = 0;
  private attempts = 0;
  private snapshotRecoveries = 0;
  private opened = false;
  private lastMessageAt = 0;
  private staleEmitted = false;
  private buffer: unknown[] = [];
  private readonly nonces = new Map<string, bigint>();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly staleMs: number;
  readonly url: string;
  constructor(private readonly options: WsOptions) {
    const url = new URL("/api/perpetuals/ws/updates", options.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.url = url.href;
    this.now = options.now ?? Date.now;
    this.staleMs = options.staleMs ?? 5000;
    if (!Number.isFinite(this.staleMs) || this.staleMs <= 0)
      throw new Error("Positive staleness interval required");
  }
  on<K extends keyof WsEvents>(
    event: K,
    listener: (payload: WsEvents[K]) => void,
  ): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener as (payload: never) => void);
    this.listeners.set(event, listeners);
    return () => {
      listeners.delete(listener as (payload: never) => void);
    };
  }
  private emit<K extends keyof WsEvents>(event: K, value: WsEvents[K]): void {
    for (const listener of this.listeners.get(event) ?? [])
      listener(value as never);
  }
  subscribe(subscription: Subscription): void {
    const key = stringifyAf(subscription);
    if (this.subscriptions.has(key)) return;
    this.subscriptions.set(key, subscription);
    // Restart and snapshot the whole active set rather than racing a new
    // subscription's deltas against asynchronous REST work on a ready socket.
    if (!this.stopped && this.socket) this.socket.close();
  }
  unsubscribe(subscription: Subscription): void {
    this.subscriptions.delete(stringifyAf(subscription));
    if (this.ready)
      this.socket?.send(
        stringifyAf({ action: "unsubscribe", subscriptionType: subscription }),
      );
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.lastMessageAt = this.now();
    this.watchdog = setInterval(
      () => this.checkStaleness(),
      Math.max(1, Math.min(1000, this.staleMs / 2)),
    );
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdog);
    this.socket?.close();
    this.socket = undefined;
    this.buffer = [];
    this.ready = false;
  }
  checkStaleness(): void {
    const ageMs = this.now() - this.lastMessageAt;
    if (!this.stopped && ageMs >= this.staleMs && !this.staleEmitted) {
      this.staleEmitted = true;
      this.emit("stale", { lastMessageAt: this.lastMessageAt, ageMs });
    }
  }
  private connect(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.ready = false;
    this.buffer = [];

    let socket: Socket;
    try {
      socket =
        this.options.socketFactory?.(this.url) ??
        new (
          WebSocket as unknown as new (
            url: string,
            options: Bun.WebSocketOptions,
          ) => WebSocket
        )(this.url, {
          headers: {
            "User-Agent": this.options.userAgent || "af-lighter-hedger/1.0",
          },
        });
    } catch (e) {
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
      this.reconnect();
      return;
    }
    this.socket = socket;
    const current = () => !this.stopped && generation === this.generation;
    socket.onopen = () => {
      if (current()) void this.open(socket, generation);
    };
    socket.onmessage = (event) => {
      if (!current()) return;
      this.lastMessageAt = this.now();
      this.staleEmitted = false;
      this.emit("activity", { ts: this.lastMessageAt });
      let message: unknown;
      try {
        message = parseAf(String(event.data));
      } catch {
        // Live proxy sends "Subscription ..." acknowledgments as plain text.
        if (
          !/^Subscription (?:established|removed|successful)\b/.test(
            String(event.data),
          )
        )
          this.emit("error", new Error("Invalid WS JSON"));
        return;
      }
      if (!message || typeof message !== "object") {
        this.emit("error", new Error("Invalid WS envelope"));
        return;
      }
      this.lastMessageAt = this.now();
      this.staleEmitted = false;
      if (!this.ready) {
        if (this.buffer.length >= (this.options.maxBufferedMessages ?? 1000)) {
          this.emit("error", new Error("WS snapshot buffer overflow"));
          socket.close();
          return;
        }
        this.buffer.push(message);
      } else this.dispatch(message);
    };
    socket.onclose = () => {
      if (current()) {
        this.generation++;
        this.ready = false;
        this.buffer = [];
        this.socket = undefined;
        this.emit("disconnected", undefined);
        this.reconnect();
      }
    };
    socket.onerror = () => {
      if (current()) {
        this.emit("error", new Error("WS transport error"));
        socket.close();
      }
    };
  }
  private async open(
    socket: Socket,
    generation: number,
    subscribe = true,
  ): Promise<void> {
    const subscriptions = [...this.subscriptions.values()];
    // Subscribe first and buffer, so no updates are missed during REST reads.
    try {
      if (subscribe)
        for (const subscription of subscriptions)
          socket.send(
            stringifyAf({
              action: "subscribe",
              subscriptionType: subscription,
            }),
          );
      const snapshots = await Promise.all(
        subscriptions.map(async (subscription) => ({
          subscription,
          value: await this.options.snapshot(subscription),
        })),
      );
      if (this.stopped || generation !== this.generation) return;
      for (const snapshot of snapshots) {
        if (!this.subscriptions.has(stringifyAf(snapshot.subscription)))
          continue;
        if ("orderbook" in snapshot.subscription) {
          const value = snapshot.value as
            | { orderbook?: { nonce?: bigint } }
            | undefined;
          if (typeof value?.orderbook?.nonce === "bigint") {
            const previous = this.nonces.get(
              snapshot.subscription.orderbook.marketId,
            );
            if (previous !== undefined && value.orderbook.nonce < previous)
              throw new Error("REST snapshot nonce went backwards");
            this.nonces.set(
              snapshot.subscription.orderbook.marketId,
              value.orderbook.nonce,
            );
          }
        }
        this.emit("snapshot", snapshot);
        if (this.stopped || generation !== this.generation) return;
      }
      this.ready = true;
      const reconnected = this.opened;
      this.opened = true;
      this.attempts = 0;
      if (subscribe) this.emit("connected", { reconnected });
      const buffered = this.buffer;
      this.buffer = [];
      for (let i = 0; i < buffered.length; i++) {
        if (this.stopped || generation !== this.generation) return;
        if (!this.ready) {
          const remaining = buffered.slice(i);
          if (
            this.buffer.length + remaining.length >
            (this.options.maxBufferedMessages ?? 1000)
          ) {
            this.emit("error", new Error("WS snapshot buffer overflow"));
            socket.close();
            return;
          }
          this.buffer.push(...remaining);
          return;
        }
        this.dispatch(buffered[i]);
      }
    } catch (e) {
      if (this.stopped || generation !== this.generation) return;
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
      socket.close();
    }
  }
  private dispatch(message: unknown): void {
    if (this.stopped || !this.ready || !message || typeof message !== "object")
      return;
    const envelope = message as Record<string, unknown>;
    for (const key of [
      "orderbook",
      "topOfOrderbook",
      "market",
      "oracle",
      "user",
      "userOrders",
    ] as const) {
      if (!(key in envelope)) continue;
      const payload = envelope[key] as Record<string, unknown>;
      if (!payload || typeof payload !== "object") {
        this.emit("error", new Error("Invalid WS payload"));
        continue;
      }
      // Ignore data from removed subscriptions, including late buffered frames.
      const active = [...this.subscriptions.values()].some((subscription) => {
        if (!(key in subscription)) return false;
        const args = (
          subscription as Record<
            string,
            { marketId?: string; accountId?: bigint }
          >
        )[key];
        if (!args) return false;
        if (args.marketId)
          return (
            args.marketId ===
            (key === "market" ? payload.objectId : payload.marketId)
          );
        const accountId =
          key === "user"
            ? (payload.account as AccountState | undefined)?.accountId
            : payload.accountId;
        return args.accountId === accountId;
      });
      if (!active) continue;
      if (key === "orderbook") {
        const delta = payload as unknown as OrderbookDelta;
        const nonce = delta.orderbookDeltas?.nonce;
        if (typeof nonce !== "bigint") {
          this.emit("error", new Error("Invalid orderbook nonce"));
          this.socket?.close();
          return;
        }
        const previous = this.nonces.get(delta.marketId);
        if (previous !== undefined) {
          if (nonce <= previous) continue;
          if (nonce !== previous + 1n) {
            this.ready = false;
            this.buffer.push(message);
            if (++this.snapshotRecoveries > 3) {
              this.emit(
                "error",
                new Error(
                  "Orderbook nonce gap persists after REST resnapshots",
                ),
              );
              this.socket?.close();
              return;
            }
            this.emit("resync", {
              reason: "Orderbook nonce gap; fetching a REST snapshot",
            });
            if (this.socket)
              void this.open(this.socket, this.generation, false);
            return;
          }
        }
        this.nonces.set(delta.marketId, nonce);
        this.snapshotRecoveries = 0;
      }
      this.emit(key, payload as unknown as WsEvents[typeof key]);
    }
  }
  private reconnect(): void {
    if (this.stopped) return;
    const delay =
      Math.min(
        this.options.reconnectMaxMs ?? 10_000,
        (this.options.reconnectBaseMs ?? 250) *
          2 ** Math.min(this.attempts++, 10),
      ) *
      (0.5 + (this.options.random ?? Math.random)());
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

// REST recovery for each supported stream. Bucketed top-of-book consumers get
// the raw REST book as a baseline, then replace it with WS bucket snapshots.
export function restSnapshot(
  markets: AfMarkets,
  account: AfAccount,
): (subscription: Subscription) => Promise<unknown> {
  return async (subscription) => {
    let value: unknown;
    if ("orderbook" in subscription)
      value = (await markets.orderbooks([subscription.orderbook.marketId]))[0];
    else if ("topOfOrderbook" in subscription)
      value = (
        await markets.orderbooks([subscription.topOfOrderbook.marketId])
      )[0];
    else if ("market" in subscription)
      value = (await markets.markets([subscription.market.marketId]))[0];
    else if ("oracle" in subscription)
      value = (await markets.prices([subscription.oracle.marketId]))[0];
    else if ("user" in subscription)
      value = (await account.positions([subscription.user.accountId]))[0];
    else
      value = await account.orderHistoryDetailed(
        subscription.userOrders.accountId,
      );
    if (value === undefined)
      throw new Error("REST snapshot missing subscription target");
    return value;
  };
}
