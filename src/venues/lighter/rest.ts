import { ConfigError, VenueError } from "../../core/errors";
import { parseBigIntN, parseIdString } from "../../core/units";
import type { SignedTransaction } from "./signer";
import type {
  Account,
  AccountLimits,
  BookOrder,
  FundingRateRow,
  FundingRow,
  JsonObject,
  Market,
  Order,
  Page,
  PositionFunding,
  SendTxResult,
  Transaction,
} from "./types";
import {
  array,
  decimal,
  integer,
  object,
  parseAccount,
  parseBookOrder,
  parseJsonLossless,
  parseMarket,
  parseOrder,
  parseTransaction,
  text,
} from "./types";

export const profiles = {
  mainnet: {
    baseUrl: "https://mainnet.zklighter.elliot.ai",
    chainId: 304,
    wsUrl: "wss://mainnet.zklighter.elliot.ai/stream",
  },
  testnet: {
    baseUrl: "https://testnet.zklighter.elliot.ai",
    chainId: 300,
    wsUrl: "wss://testnet.zklighter.elliot.ai/stream",
  },
} as const;
export type AccountTier = "standard" | "plus" | "premium";
export const tierLimits = {
  standard: { read: 60, send: 60 },
  plus: { read: 24000, send: 4000 },
  premium: { read: 24000, send: 4000 },
} as const;
const weights: Record<string, number> = {
  nextNonce: 6,
  accountActiveOrders: 100,
  accountInactiveOrders: 100,
  accountOrders: 100,
};
export class TokenBucket {
  private tokens: number;
  private last: number;
  private tail = Promise.resolve();
  constructor(
    readonly capacity: number,
    readonly perMinute: number,
    private now = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!(capacity > 0 && perMinute > 0))
      throw new ConfigError("Invalid rate limit");
    this.tokens = capacity;
    this.last = now();
  }
  take(cost = 1): Promise<void> {
    if (!(cost > 0 && cost <= this.capacity))
      return Promise.reject(new ConfigError("Invalid rate limit cost"));
    const task = this.tail.then(async () => {
      for (;;) {
        const now = this.now();
        this.tokens = Math.min(
          this.capacity,
          this.tokens + (Math.max(0, now - this.last) * this.perMinute) / 60000,
        );
        this.last = now;
        if (this.tokens >= cost) {
          this.tokens -= cost;
          return;
        }
        await this.sleep(
          Math.ceil(((cost - this.tokens) * 60000) / this.perMinute),
        );
      }
    });
    this.tail = task.catch(() => {});
    return task;
  }
}
export interface RestOptions {
  network?: keyof typeof profiles;
  baseUrl?: string;
  tier?: AccountTier;
  stakedLit?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  auth?: () => string | Promise<string>;
  retries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}
// A known API rejection is distinct from a transport error with unknown outcome.
export class ApiRejection extends VenueError {
  constructor(readonly apiCode: number) {
    super("Lighter request rejected", "lighter", apiCode);
  }
}
export class LighterRest {
  readonly profile: { baseUrl: string; chainId: number; wsUrl: string };
  private readonly readBucket: TokenBucket;
  private readonly sendBucket: TokenBucket;
  private readonly tier: AccountTier;
  constructor(private readonly options: RestOptions = {}) {
    const profile = profiles[options.network ?? "testnet"];
    this.profile = options.baseUrl
      ? {
          ...profile,
          baseUrl: options.baseUrl.replace(/\/$/, ""),
          wsUrl: `${options.baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/stream`,
        }
      : profile;
    this.tier = options.tier ?? "standard";
    const limits = tierLimits[this.tier];
    const stakes = options.stakedLit ?? 0;
    const premiumSend =
      [
        [500000, 57600],
        [300000, 24000],
        [100000, 12000],
        [30000, 8000],
        [10000, 7000],
        [3000, 6000],
        [1000, 5000],
      ].find(([threshold]) => stakes >= (threshold ?? Infinity))?.[1] ?? 4000;
    const sendLimit = this.tier === "premium" ? premiumSend : limits.send;
    // Standard sends share the read bucket. Small bursts leave room for other
    // clients on the L1 address; the venue still enforces its rolling window.
    this.readBucket = new TokenBucket(
      this.tier === "standard" ? 1 : 300,
      limits.read,
      options.now,
      options.sleep,
    );
    this.sendBucket =
      this.tier === "standard"
        ? this.readBucket
        : new TokenBucket(1, sendLimit, options.now, options.sleep);
  }
  private async request(
    endpoint: string,
    params: Record<string, string | number | bigint | undefined> = {},
    privateRead = false,
    tx?: SignedTransaction,
  ): Promise<JsonObject> {
    if (privateRead && !this.options.auth)
      throw new ConfigError("Lighter authentication required");
    const url = new URL(`${this.profile.baseUrl}/api/v1/${endpoint}`);
    for (const [k, v] of Object.entries(params))
      if (v !== undefined) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      await (tx ? this.sendBucket : this.readBucket).take(
        tx || this.tier === "standard" ? 1 : (weights[endpoint] ?? 300),
      );
      const auth = this.options.auth ? await this.options.auth() : undefined;
      if (privateRead && !auth)
        throw new ConfigError("Lighter authentication required");
      const headers: Record<string, string> = auth
        ? { Authorization: auth }
        : {};
      if (tx) headers["Content-Type"] = "application/x-www-form-urlencoded";
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(url.toString(), {
          method: tx ? "POST" : "GET",
          headers,
          body: tx
            ? new URLSearchParams({
                tx_type: String(tx.txType),
                tx_info: tx.txInfo,
              }).toString()
            : undefined,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000),
        });
      } catch {
        throw new VenueError(
          "Lighter transport outcome unavailable",
          "lighter",
          "TRANSPORT",
          true,
        );
      }
      if (
        !tx &&
        (response.status === 429 || response.status === 405) &&
        attempt < (this.options.retries ?? 4)
      ) {
        const delay = Math.min(
          60000,
          1000 * 2 ** attempt * (0.5 + (this.options.random ?? Math.random)()),
        );
        const retryAfter = response.headers.get("Retry-After");
        const serverDelay = retryAfter
          ? /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Math.max(
                0,
                Date.parse(retryAfter) - (this.options.now ?? Date.now)(),
              )
          : 0;
        await (
          this.options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
        )(Math.max(delay, Number.isFinite(serverDelay) ? serverDelay : 0));
        continue;
      }
      let result: JsonObject;
      try {
        result = object(parseJsonLossless(await response.text()));
      } catch {
        throw new VenueError(
          "Invalid Lighter response",
          "lighter",
          "RESPONSE",
          true,
        );
      }
      const code = integer(result.code);
      if (code !== 200 && !tx) throw new ApiRejection(code);
      if (!response.ok && code === 200)
        throw new VenueError(
          "Lighter HTTP outcome unavailable",
          "lighter",
          response.status,
          true,
        );
      return result;
    }
  }
  async orderBookDetails(marketId?: number): Promise<Market[]> {
    return array(
      (await this.request("orderBookDetails", { market_id: marketId }))
        .order_book_details,
    ).map(parseMarket);
  }
  async orderBookOrders(
    marketId: number,
    limit = 50,
  ): Promise<{ asks: BookOrder[]; bids: BookOrder[] }> {
    const r = await this.request("orderBookOrders", {
      market_id: marketId,
      limit,
    });
    return {
      asks: array(r.asks).map(parseBookOrder),
      bids: array(r.bids).map(parseBookOrder),
    };
  }
  async account(accountIndex: bigint): Promise<Account> {
    const r = await this.request("account", {
      by: "index",
      value: accountIndex,
    });
    const accounts = array(r.accounts).map(parseAccount);
    const account = accounts.find((a) => a.accountIndex === accountIndex);
    if (!account)
      throw new VenueError(
        "Lighter account snapshot unavailable",
        "lighter",
        "MISSING_ACCOUNT",
      );
    return account;
  }
  async accountLimits(accountIndex: bigint): Promise<AccountLimits> {
    const r = await this.request(
      "accountLimits",
      { account_index: accountIndex },
      true,
    );
    return {
      userTier: text(r.user_tier),
      userTierName: text(r.user_tier_name),
      effectiveLitStakes: decimal(r.effective_lit_stakes),
      makerFeeTick: integer(r.current_maker_fee_tick),
      takerFeeTick: integer(r.current_taker_fee_tick),
    };
  }
  async nextNonce(accountIndex: bigint, apiKeyIndex: number): Promise<bigint> {
    return parseIdString(
      (
        await this.request("nextNonce", {
          account_index: accountIndex,
          api_key_index: apiKeyIndex,
        })
      ).nonce,
    );
  }
  async tx(hash: string): Promise<Transaction | undefined> {
    try {
      return parseTransaction(
        await this.request("tx", { by: "hash", value: hash }),
      );
    } catch (e) {
      if (e instanceof ApiRejection && e.apiCode === 29404) return undefined;
      throw e;
    }
  }
  private async orders(
    endpoint: string,
    params: Record<string, string | number | bigint | undefined>,
  ): Promise<Page<Order>> {
    const r = await this.request(endpoint, params, true);
    return {
      items: array(r.orders).map(parseOrder),
      nextCursor: r.next_cursor === undefined ? undefined : text(r.next_cursor),
    };
  }
  accountActiveOrders(
    accountIndex: bigint,
    marketId?: number,
  ): Promise<Page<Order>> {
    return this.orders("accountActiveOrders", {
      account_index: accountIndex,
      market_id: marketId,
    });
  }
  accountInactiveOrders(
    accountIndex: bigint,
    marketId?: number,
    limit = 100,
    cursor?: string,
  ): Promise<Page<Order>> {
    return this.orders("accountInactiveOrders", {
      account_index: accountIndex,
      market_id: marketId,
      limit,
      cursor,
    });
  }
  accountOrders(
    accountIndex: bigint,
    clientIndexes: bigint[],
  ): Promise<Page<Order>> {
    if (!clientIndexes.length || clientIndexes.length > 20)
      throw new ConfigError("Expected 1 to 20 client order indexes");
    return this.orders("accountOrders", {
      account_index: accountIndex,
      client_order_indexes: clientIndexes.map(String).join(","),
    });
  }
  async fundings(
    marketId: number,
    start: number,
    end: number,
    countBack = 24,
  ): Promise<FundingRow[]> {
    return array(
      (
        await this.request("fundings", {
          market_id: marketId,
          resolution: "1h",
          start_timestamp: start,
          end_timestamp: end,
          count_back: countBack,
        })
      ).fundings,
    ).map((v) => {
      const r = object(v);
      const direction = text(r.direction);
      if (direction !== "long" && direction !== "short")
        throw new ConfigError("Invalid funding direction");
      return {
        timestamp: integer(r.timestamp),
        rate: decimal(r.rate),
        value: decimal(r.value),
        direction,
      };
    });
  }
  async fundingRates(): Promise<FundingRateRow[]> {
    return array((await this.request("funding-rates")).funding_rates).map(
      (v) => {
        const r = object(v);
        const rate = Number(r.rate);
        if (!Number.isFinite(rate))
          throw new ConfigError("Invalid funding rate");
        return {
          marketId: integer(r.market_id),
          symbol: text(r.symbol),
          exchange: text(r.exchange),
          rate,
        };
      },
    );
  }
  async positionFunding(
    accountIndex: bigint,
    limit = 100,
    cursor?: string,
    marketIds?: number[],
  ): Promise<Page<PositionFunding>> {
    const r = await this.request(
      "positionFunding",
      {
        account_index: accountIndex,
        limit,
        cursor,
        market_ids: marketIds?.join(","),
      },
      true,
    );
    return {
      nextCursor: r.next_cursor === undefined ? undefined : text(r.next_cursor),
      items: array(r.position_fundings).map((v) => {
        const p = object(v);
        const positionSide = text(p.position_side);
        if (positionSide !== "long" && positionSide !== "short")
          throw new ConfigError("Invalid funding side");
        return {
          fundingId: parseIdString(p.funding_id),
          marketId: integer(p.market_id),
          timestamp: integer(p.timestamp),
          change: decimal(p.change),
          rate: decimal(p.rate),
          discount: decimal(p.discount),
          positionSize: decimal(p.position_size),
          positionSide,
        };
      }),
    };
  }
  async sendTx(tx: SignedTransaction): Promise<SendTxResult> {
    try {
      const r = await this.request("sendTx", {}, false, tx);
      return {
        code: integer(r.code),
        message: r.message === undefined ? undefined : text(r.message),
        txHash: r.tx_hash === undefined ? undefined : text(r.tx_hash),
        predictedExecutionTimeMs:
          r.predicted_execution_time_ms === undefined
            ? undefined
            : integer(r.predicted_execution_time_ms),
        volumeQuotaRemaining:
          r.volume_quota_remaining === undefined
            ? undefined
            : parseBigIntN(r.volume_quota_remaining),
      };
    } catch (e) {
      if (e instanceof ApiRejection) return { code: e.apiCode };
      throw e;
    }
  }
}
