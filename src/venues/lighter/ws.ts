import { EventEmitter } from "node:events";
import { ConfigError } from "../../core/errors";
import { parseIdString } from "../../core/units";
import { profiles } from "./rest";
import type { LighterSigner } from "./signer";
import type { Account, Clock, JsonObject, Order, Transaction } from "./types";
import {
  array,
  decimal,
  integer,
  object,
  parseAccount,
  parseJsonLossless,
  parseOrder,
  parseTransaction,
  systemClock,
  text,
} from "./types";

export interface AuthToken {
  token: string;
  expiresAt: number;
}
export interface AuthTokenProvider {
  get(): AuthToken;
}
export class AuthTokens implements AuthTokenProvider {
  private current?: AuthToken;
  constructor(
    private signer: Pick<LighterSigner, "CreateAuthToken">,
    private accountIndex: bigint,
    private apiKeyIndex: number,
    private clock: Clock = systemClock,
    private lifetimeMs = 3600000,
    private refreshBeforeMs = 300000,
  ) {
    if (
      lifetimeMs > 8 * 3600000 ||
      lifetimeMs <= refreshBeforeMs ||
      refreshBeforeMs < 60000
    )
      throw new ConfigError("Invalid auth refresh timing");
  }
  get(): AuthToken {
    if (
      !this.current ||
      this.clock.now() >= this.current.expiresAt - this.refreshBeforeMs
    ) {
      const deadline = Math.floor((this.clock.now() + this.lifetimeMs) / 1000);
      this.current = {
        token: this.signer.CreateAuthToken(
          deadline,
          this.apiKeyIndex,
          this.accountIndex,
        ).authToken,
        expiresAt: deadline * 1000,
      };
      if (!this.current.token)
        throw new ConfigError("Empty Lighter auth token");
    }
    return this.current;
  }
}
export interface MarketStats {
  marketId: number;
  symbol: string;
  currentFundingRate?: string;
  fundingRate?: string;
  baseInterestRate?: string;
  markPrice?: string;
  fundingTimestamp?: number;
}
export function parseMarketStats(v: unknown): MarketStats {
  const r = object(v);
  return {
    marketId: integer(r.market_id),
    symbol: text(r.symbol),
    currentFundingRate:
      r.current_funding_rate === undefined
        ? undefined
        : decimal(r.current_funding_rate),
    fundingRate:
      r.funding_rate === undefined ? undefined : decimal(r.funding_rate),
    baseInterestRate:
      r.base_interest_rate === undefined
        ? undefined
        : decimal(r.base_interest_rate),
    markPrice: r.mark_price === undefined ? undefined : decimal(r.mark_price),
    fundingTimestamp:
      r.funding_timestamp === undefined
        ? undefined
        : integer(r.funding_timestamp),
  };
}
export interface Book {
  marketId: number;
  nonce: bigint;
  asks: ReadonlyMap<string, string>;
  bids: ReadonlyMap<string, string>;
  receivedAt: number;
}
interface MutableBook {
  marketId: number;
  nonce: bigint;
  asks: Map<string, string>;
  bids: Map<string, string>;
  receivedAt: number;
}
export interface Socket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}
export interface WsEvents {
  book: [Book];
  marketStats: [MarketStats];
  account: [{ channel: string; snapshot: boolean; account: Account }];
  transaction: [{ channel: string; transaction: Transaction }];
  orders: [{ channel: string; orders: Order[] }];
  stale: [
    { channel: string; reason: "timeout" | "gap" | "disconnect" | "auth" },
  ];
  connected: [];
  disconnected: [];
  pong: [];
  fault: [Error];
  raw: [JsonObject];
}
export interface WsOptions {
  network?: keyof typeof profiles;
  url?: string;
  socket?: (url: string) => Socket;
  clock?: Clock;
  auth?: AuthTokenProvider;
  staleMs?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  pingMs?: number;
  random?: () => number;
}
interface Subscription {
  private: boolean;
  lastSeen: number;
  stale: boolean;
}
export class LighterWs extends EventEmitter<WsEvents> {
  private socket?: Socket;
  private running = false;
  private generation = 0;
  private reconnectAttempt = 0;
  private timer?: unknown;
  private lastPing = 0;
  private lastFrame = 0;
  private authToken?: string;
  private subscriptions = new Map<string, Subscription>();
  private books = new Map<number, MutableBook>();
  private clock: Clock;
  constructor(private options: WsOptions = {}) {
    super();
    this.clock = options.clock ?? systemClock;
    if (
      (options.pingMs ?? 50000) > 60000 ||
      (options.pingMs ?? 50000) <= 0 ||
      (options.staleMs ?? 15000) <= 0
    )
      throw new ConfigError("Invalid WebSocket timing");
  }
  subscribe(channel: string): void {
    if (
      !/^(order_book\/\d+|market_stats\/(\d+|all)|account_(all|tx|all_orders)\/\d+|account_orders\/\d+\/\d+)$/.test(
        channel,
      )
    )
      throw new ConfigError("Unsupported Lighter channel");
    const isPrivate = channel.startsWith("account_");
    if (isPrivate && !this.options.auth)
      throw new ConfigError("Private channels require authentication");
    if (this.subscriptions.has(channel)) return;
    this.subscriptions.set(channel, {
      private: isPrivate,
      lastSeen: this.clock.now(),
      stale: false,
    });
    if (this.socket?.readyState === 1) this.sendSubscription(channel);
  }
  unsubscribe(channel: string): void {
    this.subscriptions.delete(channel);
    if (this.socket?.readyState === 1)
      this.send({ type: "unsubscribe", channel });
    if (channel.startsWith("order_book/"))
      this.books.delete(Number(channel.split("/")[1]));
  }
  subscribeBook(marketId: number): void {
    this.subscribe(`order_book/${marketId}`);
  }
  subscribeMarketStats(marketId: number | "all"): void {
    this.subscribe(`market_stats/${marketId}`);
  }
  subscribeAccount(accountIndex: bigint): void {
    this.subscribe(`account_all/${accountIndex}`);
  }
  subscribeAccountTx(accountIndex: bigint): void {
    this.subscribe(`account_tx/${accountIndex}`);
  }
  subscribeAccountOrders(accountIndex: bigint, marketId?: number): void {
    this.subscribe(
      marketId === undefined
        ? `account_all_orders/${accountIndex}`
        : `account_orders/${marketId}/${accountIndex}`,
    );
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }
  stop(): void {
    this.running = false;
    this.generation++;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.invalidate("disconnect");
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }
  private send(value: JsonObject): void {
    this.socket?.send(JSON.stringify(value));
  }
  private sendSubscription(channel: string): void {
    const sub = this.subscriptions.get(channel);
    if (!sub) return;
    const token = sub.private ? this.options.auth?.get().token : undefined;
    if (token) this.authToken = token;
    this.send({
      type: "subscribe",
      channel,
      ...(token ? { auth: token } : {}),
    });
  }
  private invalidate(reason: "disconnect" | "auth"): void {
    this.books.clear();
    for (const [channel, sub] of this.subscriptions) {
      sub.stale = true;
      this.emit("stale", { channel, reason });
    }
  }
  private connect(): void {
    if (!this.running) return;
    const gen = ++this.generation;
    let socket: Socket;
    try {
      socket = (
        this.options.socket ??
        ((url) => new WebSocket(url) as unknown as Socket)
      )(this.options.url ?? profiles[this.options.network ?? "testnet"].wsUrl);
    } catch {
      this.emit("fault", new Error("Lighter WebSocket connection unavailable"));
      this.reconnect();
      return;
    }
    this.socket = socket;
    this.timer = this.clock.setTimeout(() => {
      if (gen === this.generation && socket === this.socket) socket.close();
    }, this.options.connectTimeoutMs ?? 10000);
    socket.onopen = () => {
      if (gen !== this.generation || socket !== this.socket) return;
      if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
      this.lastFrame = this.clock.now();
      this.lastPing = this.clock.now();
      try {
        for (const [channel, sub] of this.subscriptions) {
          sub.lastSeen = this.clock.now();
          this.sendSubscription(channel);
        }
      } catch {
        this.emit(
          "fault",
          new Error("Lighter WebSocket authentication unavailable"),
        );
        this.invalidate("auth");
        socket.close();
        return;
      }
      this.emit("connected");
      this.tick();
    };
    socket.onmessage = (event) => {
      if (gen !== this.generation || socket !== this.socket) return;
      try {
        this.lastFrame = this.clock.now();
        this.receive(object(parseJsonLossless(String(event.data))));
      } catch {
        this.emit("fault", new Error("Invalid Lighter WebSocket frame"));
        // The malformed frame may have contained a missed state transition.
        // Replace all state via a reconnect rather than expose an old book.
        socket.close();
      }
    };
    socket.onerror = () => {
      if (gen === this.generation && socket === this.socket) socket.close();
    };
    socket.onclose = () => {
      if (gen !== this.generation || socket !== this.socket) return;
      this.socket = undefined;
      this.invalidate("disconnect");
      this.emit("disconnected");
      this.reconnect();
    };
  }
  private reconnect(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    if (!this.running) return;
    const delay =
      Math.min(30000, 500 * 2 ** Math.min(this.reconnectAttempt++, 8)) *
      (0.5 + (this.options.random ?? Math.random)());
    this.timer = this.clock.setTimeout(() => this.connect(), delay);
  }
  private tick(): void {
    if (!this.running || this.socket?.readyState !== 1) return;
    try {
      if (
        this.clock.now() - this.lastFrame >=
        (this.options.idleTimeoutMs ?? 120000)
      ) {
        this.socket.close();
        return;
      }
      if (this.clock.now() - this.lastPing >= (this.options.pingMs ?? 50000)) {
        this.send({ type: "ping" });
        this.lastPing = this.clock.now();
      }
      if ([...this.subscriptions.values()].some((s) => s.private)) {
        const token = this.options.auth?.get().token;
        if (token !== this.authToken) {
          this.authToken = token;
          for (const [channel, sub] of this.subscriptions)
            if (sub.private) {
              sub.stale = true;
              this.emit("stale", { channel, reason: "auth" });
              this.send({ type: "unsubscribe", channel });
              this.sendSubscription(channel);
            }
        }
      }
      for (const [channel, sub] of this.subscriptions)
        if (
          !sub.stale &&
          this.clock.now() - sub.lastSeen >= (this.options.staleMs ?? 15000)
        ) {
          sub.stale = true;
          if (channel.startsWith("order_book/"))
            this.books.delete(Number(channel.split("/")[1]));
          this.emit("stale", { channel, reason: "timeout" });
          this.send({ type: "unsubscribe", channel });
          this.sendSubscription(channel);
        }
    } catch {
      this.emit("fault", new Error("Lighter WebSocket keepalive unavailable"));
      this.invalidate("auth");
      this.socket?.close();
      return;
    }
    this.timer = this.clock.setTimeout(
      () => this.tick(),
      Math.min(1000, this.options.staleMs ?? 15000),
    );
  }
  private receive(r: JsonObject): void {
    const type = text(r.type);
    this.emit("raw", r);
    if (type === "ping") {
      this.send({ type: "pong" });
      return;
    }
    if (type === "pong") {
      this.emit("pong");
      return;
    }
    if (r.error) {
      this.emit("fault", new Error("Lighter WebSocket request rejected"));
      return;
    }
    if (!type.startsWith("update/") && !type.startsWith("subscribed/")) return;
    const kind = type.split("/")[1];
    const channel = text(r.channel).replaceAll(":", "/");
    // account_orders response names only the market; the account is in payload.
    const key =
      kind === "account_orders" &&
      channel.split("/").length === 2 &&
      r.account !== undefined
        ? `${channel}/${parseIdString(r.account)}`
        : channel;
    const sub = this.subscriptions.get(key);
    if (!sub) return;
    this.reconnectAttempt = 0;
    if (kind === "order_book")
      this.receiveBook(r, key, type.startsWith("subscribed/"));
    else if (kind === "market_stats") {
      const stats = object(r.market_stats);
      const rows =
        stats.market_id === undefined ? Object.values(stats) : [stats];
      for (const row of rows) this.emit("marketStats", parseMarketStats(row));
    } else if (kind === "account_all")
      this.emit("account", {
        channel: key,
        snapshot: type.startsWith("subscribed/"),
        account: parseAccount(r),
      });
    else if (kind === "account_tx")
      for (const tx of array(r.txs))
        this.emit("transaction", {
          channel: key,
          transaction: parseTransaction(tx),
        });
    else if (kind === "account_orders" || kind === "account_all_orders") {
      const rows = Array.isArray(r.orders)
        ? r.orders
        : Object.values(object(r.orders)).flatMap(array);
      this.emit("orders", { channel: key, orders: rows.map(parseOrder) });
    }
    // A gapped book remains stale until a fresh snapshot is installed.
    if (kind !== "order_book" || this.books.has(Number(key.split("/")[1]))) {
      sub.lastSeen = this.clock.now();
      sub.stale = false;
    }
  }
  private receiveBook(r: JsonObject, channel: string, snapshot: boolean): void {
    const data = object(r.order_book);
    const id = Number(channel.split("/")[1]);
    const nonce = parseIdString(data.nonce);
    let book = this.books.get(id);
    if (!snapshot && !book && this.subscriptions.get(channel)?.stale) return;
    if (
      !snapshot &&
      (!book ||
        parseIdString(data.begin_nonce) !== book.nonce ||
        nonce < book.nonce)
    ) {
      this.books.delete(id);
      const sub = this.subscriptions.get(channel);
      if (sub) sub.stale = true;
      this.emit("stale", { channel, reason: "gap" });
      this.send({ type: "unsubscribe", channel });
      this.sendSubscription(channel);
      return;
    }
    if (snapshot)
      book = {
        marketId: id,
        nonce,
        asks: new Map(),
        bids: new Map(),
        receivedAt: this.clock.now(),
      };
    if (!book) return;
    const changes = (["asks", "bids"] as const).map((side) => ({
      side,
      levels: array(data[side]).map((row) => {
        const level = object(row);
        const price = decimal(level.price);
        const size = decimal(level.size);
        if (
          price.startsWith("-") ||
          !/[1-9]/.test(price) ||
          size.startsWith("-")
        )
          throw new ConfigError("Invalid book level");
        return { price, size };
      }),
    }));
    for (const { side, levels } of changes)
      for (const { price, size } of levels) {
        if (!/[1-9]/.test(size)) book[side].delete(price);
        else book[side].set(price, size);
      }
    book.nonce = nonce;
    book.receivedAt = this.clock.now();
    this.books.set(id, book);
    this.emit("book", {
      ...book,
      asks: new Map(book.asks),
      bids: new Map(book.bids),
    });
  }
}
