import { EventEmitter } from "node:events";
import { ConfigError } from "../../core/errors";
import { lighterFromInt, lighterToInt } from "../../core/units";
import type { Account, Clock, Market, Position } from "./types";
import { systemClock } from "./types";
import type { LighterWs } from "./ws";

export interface PositionSnapshot {
  marketId: number;
  signedBase: string;
  signedBaseInt: bigint;
  avgEntryPrice: string;
  liquidationPrice?: string;
  totalFundingPaidOut?: string;
}
export type AccountSnapshot =
  | { status: "unknown" | "stale"; availableCollateral: null; positions: null }
  | {
      status: "fresh";
      availableCollateral: string;
      collateral: string;
      positions: ReadonlyMap<number, PositionSnapshot>;
      receivedAt: number;
    };
export class LighterAccount extends EventEmitter<{
  change: [AccountSnapshot];
}> {
  private positions?: Map<number, Position>;
  private collateral?: string;
  private available?: string;
  private receivedAt?: number;
  private invalid = false;
  private revision = 0;
  private detach?: () => void;
  private timer?: unknown;
  constructor(
    readonly accountIndex: bigint,
    private markets: ReadonlyMap<number, Market>,
    private clock: Clock = systemClock,
    private staleMs = 15000,
  ) {
    super();
  }
  async refresh(rest: {
    account(index: bigint): Promise<Account>;
  }): Promise<AccountSnapshot> {
    const revision = this.revision;
    try {
      const account = await rest.account(this.accountIndex);
      if (revision === this.revision) this.apply(account, true);
      return this.snapshot();
    } catch (e) {
      this.invalid = true;
      this.emit("change", this.snapshot());
      throw e;
    }
  }
  attach(ws: Pick<LighterWs, "on" | "off" | "subscribeAccount">): void {
    this.detach?.();
    ws.subscribeAccount(this.accountIndex);
    const onAccount = (event: {
      channel: string;
      snapshot: boolean;
      account: Account;
    }) => {
      if (event.channel !== `account_all/${this.accountIndex}`) return;
      // account_all publishes position changes, but no available collateral in
      // its documented payload. Never carry old REST collateral forward as fresh.
      this.apply(event.account, event.snapshot);
    };
    const onStale = (event: { channel: string }) => {
      if (event.channel === `account_all/${this.accountIndex}`) {
        this.invalid = true;
        this.emit("change", this.snapshot());
      }
    };
    ws.on("account", onAccount);
    ws.on("stale", onStale);
    this.detach = () => {
      ws.off("account", onAccount);
      ws.off("stale", onStale);
    };
  }
  stop(): void {
    this.detach?.();
    this.detach = undefined;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
  }
  apply(account: Account, snapshot: boolean): void {
    if (account.accountIndex !== this.accountIndex)
      throw new ConfigError("Account snapshot identity mismatch");
    this.revision++;
    if (snapshot)
      this.positions =
        account.positions === undefined
          ? undefined
          : new Map(account.positions.map((p) => [p.marketId, p]));
    else if (account.positions && this.positions)
      for (const position of account.positions)
        this.positions.set(position.marketId, position);
    this.collateral = account.collateral;
    this.available = account.availableBalance;
    this.receivedAt = this.clock.now();
    this.invalid = false;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.invalid = true;
      this.emit("change", this.snapshot());
    }, this.staleMs);
    this.emit("change", this.snapshot());
  }
  snapshot(): AccountSnapshot {
    if (
      this.invalid ||
      (this.receivedAt !== undefined &&
        this.clock.now() - this.receivedAt >= this.staleMs)
    )
      return { status: "stale", availableCollateral: null, positions: null };
    if (
      !this.positions ||
      this.available === undefined ||
      this.collateral === undefined ||
      this.receivedAt === undefined
    )
      return { status: "unknown", availableCollateral: null, positions: null };
    const positions = new Map<number, PositionSnapshot>();
    for (const p of this.positions.values()) {
      const market = this.markets.get(p.marketId);
      if (!market)
        return {
          status: "unknown",
          availableCollateral: null,
          positions: null,
        };
      const magnitude = lighterToInt(p.position, market.sizeDecimals, "down");
      if (
        lighterFromInt(magnitude, market.sizeDecimals) !==
        lighterFromInt(
          lighterToInt(p.position, market.sizeDecimals, "up"),
          market.sizeDecimals,
        )
      )
        return {
          status: "unknown",
          availableCollateral: null,
          positions: null,
        };
      const signedBaseInt = magnitude * BigInt(p.sign);
      positions.set(p.marketId, {
        marketId: p.marketId,
        signedBase: lighterFromInt(signedBaseInt, market.sizeDecimals),
        signedBaseInt,
        avgEntryPrice: p.avgEntryPrice,
        liquidationPrice: p.liquidationPrice,
        totalFundingPaidOut: p.totalFundingPaidOut,
      });
    }
    return {
      status: "fresh",
      availableCollateral: this.available,
      collateral: this.collateral,
      positions,
      receivedAt: this.receivedAt,
    };
  }
  position(marketId: number): PositionSnapshot | undefined {
    const snapshot = this.snapshot();
    return snapshot.status === "fresh"
      ? snapshot.positions.get(marketId)
      : undefined;
  }
}
