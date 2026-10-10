import type { Logger } from "../core/logger";
import { AF_SCALE, lighterToInt } from "../core/units";
import { abs, type Fill, type OwnOrder } from "../domain/types";
import { relaxedTwa } from "../funding/model";
import { errorFields, modeLogger } from "../ops/logging";
import { Breaker } from "../risk/breaker";
import { evaluateGates } from "../risk/gates";
import { evaluateLimits } from "../risk/limits";
import type { ControlRequest } from "../state/control";
import { type Intent, type PnlRow, terminal } from "../state/store";
import {
  type HedgeCommand,
  type HedgeEvent,
  type HedgerState,
  initialHedgerState,
  reduceHedge,
  splitUnhedged,
} from "../strategy/hedger";
import {
  computeQuotes,
  outsideBook,
  type QuoteInput,
} from "../strategy/quoter";
import { reconcile } from "../strategy/reconciler";
import type { HedgeResult } from "../venues/lighter";
import { clampPostOnly, mid, validBook, walk } from "./book";
import { staleReason } from "./freshness";
import { quoteImpact } from "./impact";
import type { ResolvedMarket } from "./markets";
import type {
  AccountPosition,
  EngineOptions,
  FeedEvent,
  HedgeSubmission,
  SendContext,
} from "./types";

export class SafetyRefusal extends Error {}
const usd = (value: number) => BigInt(Math.floor(value * Number(AF_SCALE)));
const notional = (base: bigint, price: bigint) =>
  (abs(base) * price) / AF_SCALE;

export class Engine {
  readonly breaker: Breaker;
  private logger: Logger;
  private planKeys = new Map<string, string>();
  private pauseReasons = new Map<string, string>();
  private statusAt = -Infinity;
  private event(type: string, fields: Record<string, unknown> = {}) {
    this.logger.info(type, { type, ...fields, mode: this.options.mode });
  }
  private logFailure(error: unknown) {
    const fields = errorFields(error, false);
    this.logger.error(`${fields.name}: ${fields.message}`, {
      type: "error",
      ...fields,
    });
    this.logger.debug("error_detail", {
      type: "error_detail",
      ...errorFields(error, true),
    });
  }
  private afTx(
    market: string,
    kind: string,
    receipt: import("./types").AfReceipt,
  ) {
    this.event("af_tx", {
      market,
      kind,
      digest: receipt.digest,
      execution:
        this.options.mode === "paper"
          ? "paper"
          : receipt.simulated
            ? "simulated"
            : "live",
      gasUsed: receipt.gasUsedMist ?? 0n,
      gasUnit: "MIST",
      gasUsd: receipt.gasUsd,
      updatedPremiumTwap: receipt.updatedPremiumTwap,
      status: receipt.status,
    });
  }
  private states = new Map<string, HedgerState>();
  private accounts = new Map<
    string,
    { af: AccountPosition; lighter: AccountPosition }
  >();
  private tail = Promise.resolve();
  private running = false;
  private stopping = false;
  private recovering = true;
  private paused = new Set<string>();
  private timers = new Set<unknown>();
  private quoteAt = new Map<string, number>();
  private hedgeAt = new Map<string, number>();
  private afActivityAt = new Map<string, number>();
  private afPositions = new Map<
    string,
    Pick<AccountPosition, "base" | "exists">
  >();
  private pendingPositionReads = new Map<string, number>();
  private reconcileDeferredAt = new Map<string, number>();
  private reconcileStarved = new Set<string>();
  private requotes = new Map<string, number[]>();
  private startedAt: number;
  private heartbeatAt: number;
  private lastFunding = -Infinity;
  private watchdogBusy = false;
  constructor(readonly options: EngineOptions) {
    this.logger =
      options.logger ??
      modeLogger(options.mode, { now: () => new Date(this.now()) });
    this.startedAt = this.now();
    this.heartbeatAt = this.now();
    this.breaker = new Breaker(options.store, () => this.now());
    if (options.mode !== options.config.mode)
      throw new Error("Engine mode/config mismatch");
    for (const m of options.markets) {
      // Allow queued/replayed fills to arrive before correcting a startup snapshot.
      this.noteAfActivity(m.config.symbol);
      this.states.set(m.config.symbol, {
        ...initialHedgerState(m.config.symbol),
        ...options.store.get<HedgerState>(`hedger:${m.config.symbol}`),
      });
    }
  }
  get isRunning(): boolean {
    return this.running && !this.stopping;
  }
  private now() {
    return this.options.clock.now();
  }
  private market(symbol: string): ResolvedMarket {
    const market = this.options.markets.find((m) => m.config.symbol === symbol);
    if (!market) throw new Error(`Unknown configured market: ${symbol}`);
    return market;
  }
  state(symbol: string): HedgerState {
    return this.states.get(symbol) ?? initialHedgerState(symbol);
  }
  private saveState(state: HedgerState): void {
    const exposure = splitUnhedged(
      state.unhedgedBase,
      this.hedgePolicy(this.market(state.marketId)),
    );
    state = {
      ...state,
      ...exposure,
      unhedgedSince: exposure.hedgeableBase === 0n ? null : state.unhedgedSince,
    };
    this.options.store.set(`hedger:${state.marketId}`, state);
    this.states.set(state.marketId, state);
  }
  private queue<T>(job: () => Promise<T>): Promise<T> {
    const task = this.tail.then(job);
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  async idle(): Promise<void> {
    await this.tail;
  }
  async start(timers = true): Promise<void> {
    if (this.running) throw new Error("Engine already running");
    this.running = true;
    try {
      await this.queue(() => this.startupRecovery());
      this.options.feeds.start((event) => {
        void this.handle(event)
          .catch((error) => {
            this.logFailure(error);
            return this.failClosed("feed_handler_failed");
          })
          .catch(() => {});
      });
      if (timers) {
        this.schedule(250, () => this.tick());
        this.schedule(5000, () => this.reconcileAll());
        this.schedule(
          Math.min(1000, this.options.config.aftermath.heartbeatMs / 2),
          () => this.watchdog(),
        );
      }
    } catch (error) {
      this.running = false;
      this.options.feeds.stop();
      throw error;
    }
  }
  private schedule(ms: number, callback: () => Promise<void>): void {
    const next = () => {
      if (!this.running || this.stopping) return;
      const timer = this.options.clock.setTimeout(() => {
        this.timers.delete(timer);
        void callback()
          .catch((error) => {
            this.logFailure(error);
            return this.failClosed("loop_failed");
          })
          .catch(() => {})
          .finally(next);
      }, ms);
      this.timers.add(timer);
    };
    next();
  }
  async startupRecovery(): Promise<void> {
    this.recovering = true;
    await this.options.feeds.refresh();
    // Populate derived exposure fields for older persisted states after prices
    // are available. Dust must not retain its legacy unhedged age.
    for (const m of this.options.markets)
      this.saveState(this.state(m.config.symbol));
    // All pending account orders in configured markets are canceled, including
    // orders not represented in the local ledger after a previous lost response.
    await this.cancelAllInternal();
    await this.resolveIntents();
    const interrupted = this.options.store.get<ControlRequest>("control");
    if (interrupted?.status === "running")
      this.options.store.set("control", {
        ...interrupted,
        status: "error",
        message:
          "Operator command interrupted; inspect positions and intents before retrying",
      });
    for (const m of this.options.markets) this.noteAfActivity(m.config.symbol);
    await this.reconcileInternal();
    if (this.options.store.intents(true).length)
      throw new SafetyRefusal("Unresolved startup intents; quoting refused");
    this.recovering = false;
    this.heartbeatAt = this.now();
  }
  private context(intent: Intent): SendContext {
    return {
      intent,
      beforeSend: (hash) => {
        if (!hash) throw new Error("Transaction hash required before send");
        this.options.store.transaction(() => {
          this.options.store.updateIntent(intent.id, "sending", hash);
          if (intent.venue === "lighter")
            this.options.store.saveHedge(
              BigInt(intent.clientId),
              this.state(intent.market).seenFills,
              intent.payload,
              "sending",
              null,
              hash,
            );
        });
      },
    };
  }
  private async resolveIntents(): Promise<void> {
    for (const intent of this.options.store.intents(true)) {
      const resolution =
        intent.status === "prepared" && !intent.txHash
          ? { status: "abandoned" as const }
          : await (intent.venue === "af"
              ? this.options.af
              : this.options.lighter
            ).resolve(intent);
      if (resolution.status === "unknown") {
        this.paused.add(intent.market);
        continue;
      }
      this.options.store.transaction(() => {
        this.options.store.updateIntent(
          intent.id,
          resolution.status,
          intent.txHash ?? undefined,
          resolution.result,
        );
        if (intent.venue === "lighter")
          this.options.store.saveHedge(
            BigInt(intent.clientId),
            this.state(intent.market).seenFills,
            intent.payload,
            resolution.status,
            resolution.result,
            intent.txHash,
          );
      });
      const result = resolution.result;
      if (intent.venue === "lighter" && result && "filledBase" in result) {
        this.recordHedgePnl(intent, result);
        const m = this.market(intent.market);
        await this.hedgeEvent(m, {
          type: "hedge_confirmed",
          result: {
            clientOrderIndex: BigInt(intent.clientId),
            status: result.status,
            filledSize: m.toAf(
              lighterToInt(result.filledBase, m.lighter.sizeDecimals, "down"),
            ),
          },
          terminal: true,
          now: this.now(),
        });
      }
    }
    for (const m of this.options.markets) {
      const symbol = m.config.symbol;
      const pending = this.options.store
        .intents(true)
        .filter((i) => i.market === symbol);
      if (!pending.length) {
        this.paused.delete(symbol);
        this.pauseReasons.delete(symbol);
        const state = this.state(symbol);
        this.saveState({ ...state, active: null });
      }
    }
  }
  handle(event: FeedEvent): Promise<void> {
    // Observe arrival outside the queue: an event received during a position
    // read must invalidate that reconciliation before it can reserve a hedge.
    if (event.type === "position") {
      if (event.afPosition)
        this.observeAfPosition(event.market, event.afPosition);
      else
        this.pendingPositionReads.set(
          event.market,
          (this.pendingPositionReads.get(event.market) ?? 0) + 1,
        );
    } else if (event.type === "fill") this.noteAfActivity(event.fill.marketId);
    else if (event.type === "reconnect")
      for (const m of this.options.markets)
        this.noteAfActivity(m.config.symbol);
    return this.queue(async () => {
      if (this.stopping) return;
      if (event.type === "fill")
        await this.onFillInternal(event.fill, event.fee ?? 0n);
      else if (event.type === "position") {
        if (!event.afPosition)
          this.pendingPositionReads.set(
            event.market,
            (this.pendingPositionReads.get(event.market) ?? 1) - 1,
          );
        await this.reconcileMarket(event.market);
      } else if (event.type === "disconnect") {
        for (const m of this.options.markets) this.paused.add(m.config.symbol);
        await this.cancelAllInternal();
        await this.alert("warning", `${event.venue}_disconnected`);
      } else if (event.type === "reconnect") {
        this.recovering = true;
        await this.options.feeds.refresh();
        await this.cancelAllInternal();
        await this.resolveIntents();
        for (const m of this.options.markets)
          this.noteAfActivity(m.config.symbol);
        await this.reconcileInternal();
        this.recovering = false;
      } else await this.quoteMarket(event.market);
      this.heartbeatAt = this.now();
    });
  }
  onFill(fill: Fill, fee = 0n): Promise<void> {
    this.noteAfActivity(fill.marketId);
    return this.queue(() => this.onFillInternal(fill, fee));
  }
  private async onFillInternal(fill: Fill, fee: bigint): Promise<void> {
    const m = this.market(fill.marketId);
    const key = JSON.stringify([fill.txDigest, fill.orderId]);
    if (this.options.store.hasFill(fill.txDigest, fill.orderId)) return;
    this.event("fill", {
      market: fill.marketId,
      ...fill,
      fee,
      execution: this.options.mode,
    });
    const middle = this.referencePrice(m);
    const before = this.state(fill.marketId);

    // The ledger, reducer state and outgoing intent share one commit.
    let commands: HedgeCommand[] = [];
    try {
      this.options.store.transaction(() => {
        if (!this.options.store.recordFill(fill, fee)) return;
        const order = this.options.store
          .orders(fill.marketId)
          .find((o) => o.clientOrderId === fill.orderId);
        if (order)
          this.options.store.saveOrder(
            {
              ...order,
              size: order.size > fill.size ? order.size - fill.size : 0n,
            },
            order.size > fill.size ? "open" : "filled",
          );
        this.options.store.pnl({
          key: `fill:${key}`,
          market: fill.marketId,
          ts: fill.ts,
          spread:
            ((fill.side === "ASK" ? fill.price - middle : middle - fill.price) *
              fill.size) /
            AF_SCALE,
          rebates: -fee,
          hedgeCosts: 0n,
          gas: 0n,
        });
        const result = reduceHedge(
          {
            ...before,
            nextClientOrderIndex: this.options.store.cursor("lighter"),
          },
          { type: "af_fill", fill, now: this.now() },
          this.hedgePolicy(m),
        );
        this.persistReduction(result.state, result.commands);
        commands = result.commands;
      });
    } catch {
      // A rolled-back transaction must not leave an in-memory reservation.
      this.states.set(fill.marketId, before);
      await this.failClosed("fill_account_unknown", fill.marketId);
      return;
    }
    this.noteAfActivity(fill.marketId);
    await this.executeCommands(m, commands);
  }
  private noteAfActivity(symbol: string): void {
    this.afActivityAt.set(symbol, this.now());
  }
  private observeAfPosition(
    symbol: string,
    position: Pick<AccountPosition, "base" | "exists">,
  ): void {
    const previous = this.afPositions.get(symbol);
    if (previous?.base === position.base && previous.exists === position.exists)
      return;
    this.afPositions.set(symbol, {
      base: position.base,
      exists: position.exists,
    });
    if (previous) this.noteAfActivity(symbol);
  }
  private intentBlocksReconcile(intent: Intent): boolean {
    if (intent.venue === "lighter") return true;
    if (intent.kind === "cancel") return false;
    if (intent.kind === "quote") {
      const payload = intent.payload as { postOnly?: boolean } | null;
      return payload?.postOnly !== true;
    }
    return true;
  }
  private reconcileDeferredReason(symbol: string): string | null {
    if (this.state(symbol).active) return "active_hedge";
    if (
      this.options.store
        .intents(true)
        .some((i) => i.market === symbol && this.intentBlocksReconcile(i))
    )
      return "pending_intent";
    if ((this.pendingPositionReads.get(symbol) ?? 0) > 0)
      return "position_update_pending";
    if (
      this.now() - (this.afActivityAt.get(symbol) ?? this.now()) <
      this.options.config.risk.reconcileQuiescenceMs
    )
      return "af_activity";
    return null;
  }
  private async deferReconcile(
    symbol: string,
    reason: string,
    positions: { af: AccountPosition; lighter: AccountPosition },
  ): Promise<void> {
    if (
      !positions.af.fresh ||
      !positions.lighter.fresh ||
      positions.af.base + positions.lighter.base === 0n
    ) {
      this.reconcileDeferredAt.delete(symbol);
      this.event("reconcile", { market: symbol, action: "deferred", reason });
      return;
    }
    const since = this.reconcileDeferredAt.get(symbol) ?? this.now();
    this.reconcileDeferredAt.set(symbol, since);
    this.event("reconcile", { market: symbol, action: "deferred", reason });
    if (
      !this.reconcileStarved.has(symbol) &&
      this.now() - since > this.options.config.risk.maxReconcileDeferralMs
    ) {
      this.reconcileStarved.add(symbol);
      try {
        await this.cancelMarket(symbol);
      } finally {
        await this.alert("error", "reconcile_starved", symbol);
      }
    }
  }
  private referencePrice(m: ResolvedMarket): bigint {
    const view = this.options.feeds.view(m.config.symbol);
    return validBook(view.lighterBook)
      ? mid(view.lighterBook)
      : view.index > 0n
        ? view.index
        : 1n;
  }
  private hedgePolicy(m: ResolvedMarket) {
    const price = this.referencePrice(m);
    const c = this.options.config;
    return {
      lot: m.jointStep,
      minSize: m.minBase,
      minNotional: m.minNotional,
      price,
      priceScale: AF_SCALE,
      sizeScale: AF_SCALE,
      usdScale: AF_SCALE,
      maxUnhedgedUsd: usd(c.risk.maxUnhedgedUsd),
      maxUnhedgedAgeMs: c.risk.maxUnhedgedAgeMs,
      outcomeTimeoutMs: 5000,
      slippageBps: Math.floor(c.lighter.maxSlippageBps),
      emergencySlippageBps: Math.floor(c.lighter.emergencySlippageBps),
      allocate: (next: bigint) => {
        if (next < 1n || next >= 1n << 48n)
          throw new Error("Lighter cursor exhausted");
        return { clientOrderIndex: next, next: next + 1n };
      },
    };
  }
  private persistReduction(
    state: HedgerState,
    commands: readonly HedgeCommand[],
  ): void {
    for (const command of commands)
      if (command.type === "persist_intent") {
        this.options.store.advanceCursor(
          "lighter",
          command.nextClientOrderIndex,
        );
        const payload: HedgeSubmission = {
          intent: command.intent,
          baseAmount: this.market(state.marketId).toLighter(
            command.intent.size,
          ),
          refPrice: this.referencePrice(this.market(state.marketId)),
          reduceOnly: false,
        };
        this.options.store.createIntent({
          venue: "lighter",
          kind: "hedge",
          clientId: String(command.intent.clientOrderIndex),
          market: state.marketId,
          payload,
        });
        this.options.store.saveHedge(
          command.intent.clientOrderIndex,
          state.seenFills,
          payload,
          "prepared",
        );
      }
    this.saveState(
      state.unhedgedBase === 0n && !state.active
        ? { ...state, seenFills: [] }
        : state,
    );
  }
  private async hedgeEvent(
    m: ResolvedMarket,
    event: HedgeEvent,
  ): Promise<void> {
    let commands: HedgeCommand[] = [];
    this.options.store.transaction(() => {
      const reduction = reduceHedge(
        {
          ...this.state(m.config.symbol),
          nextClientOrderIndex: this.options.store.cursor("lighter"),
        },
        event,
        this.hedgePolicy(m),
      );
      this.persistReduction(reduction.state, reduction.commands);
      commands = reduction.commands;
    });
    await this.executeCommands(m, commands);
  }
  private async executeCommands(
    m: ResolvedMarket,
    commands: readonly HedgeCommand[],
  ): Promise<void> {
    for (const command of commands) {
      if (command.type === "place_hedge") {
        const intent = this.options.store
          .intents(true)
          .find(
            (i) =>
              i.venue === "lighter" &&
              i.clientId === String(command.intent.clientOrderIndex),
          );
        if (!intent) throw new Error("Missing durable hedge intent");
        await this.sendHedge(m, intent);
      } else if (command.type === "resolve_unknown")
        await this.resolveHedge(m, command.clientOrderIndex);
      else if (command.type === "pull_quotes")
        await this.cancelMarket(m.config.symbol);
      else if (command.type === "trip_breaker") {
        this.breaker.trip(command.reason);
        this.event("fail_closed", {
          reason: command.reason,
          market: m.config.symbol,
        });
        await this.cancelAllInternal();
        await this.alert("critical", command.reason, m.config.symbol);
      } else if (command.type === "alert")
        await this.alert(command.severity, command.reason, m.config.symbol);
    }
  }
  private async sendHedge(m: ResolvedMarket, intent: Intent): Promise<void> {
    const payload = intent.payload as HedgeSubmission;
    const view = this.options.feeds.view(m.config.symbol);
    if (!this.freshHedgeBook(view)) {
      this.paused.add(m.config.symbol);
      await this.cancelMarket(m.config.symbol);
      await this.alert("error", "hedge_book_stale", m.config.symbol);
      // No send occurred. Clear the reserved order so reconciliation can retry
      // with a new durable id after the book becomes trustworthy.
      this.options.store.updateIntent(intent.id, "abandoned");
      this.saveState({ ...this.state(m.config.symbol), active: null });
      return;
    }
    payload.benchmarkPrice ??= payload.refPrice;
    payload.refPrice =
      payload.intent.side === "BID"
        ? (view.lighterBook.asks[0]?.price ?? 0n)
        : (view.lighterBook.bids[0]?.price ?? 0n);
    this.options.store.updateIntentPayload(intent.id, payload);
    this.event("hedge_sent", {
      market: m.config.symbol,
      side: payload.intent.side,
      size: payload.intent.size,
      refPrice: payload.refPrice,
      reduceOnly: payload.reduceOnly,
    });
    try {
      const result = await this.options.lighter.hedge(
        payload,
        this.context(intent),
      );
      this.event("hedge_result", {
        market: m.config.symbol,
        status: result.status,
        filledBase: result.filledBase,
        avgPrice: result.avgPrice,
        txHash: result.txHash,
      });
      if (result.clientOrderIndex !== BigInt(intent.clientId))
        throw new Error("Mismatched hedge confirmation");
      this.options.store.transaction(() => {
        this.options.store.updateIntent(
          intent.id,
          "confirmed",
          result.txHash,
          result,
        );
        this.options.store.saveHedge(
          result.clientOrderIndex,
          this.state(m.config.symbol).seenFills,
          payload,
          "confirmed",
          result,
          result.txHash,
        );
      });
      this.recordHedgePnl(intent, result);
      this.hedgeAt.set(m.config.symbol, this.now());
      await this.hedgeEvent(m, {
        type: "hedge_confirmed",
        result: {
          clientOrderIndex: result.clientOrderIndex,
          status: result.status,
          filledSize: m.toAf(
            lighterToInt(result.filledBase, m.lighter.sizeDecimals, "down"),
          ),
        },
        terminal: true,
        now: this.now(),
      });
    } catch (error) {
      this.logFailure(error);
      const current = this.options.store.intent(intent.id);
      if (current && terminal(current.status))
        throw new Error("Hedge confirmation processing failed");
      if (current?.status === "prepared" && !current.txHash) {
        this.options.store.updateIntent(intent.id, "abandoned");
        await this.hedgeEvent(m, {
          type: "hedge_confirmed",
          result: {
            clientOrderIndex: BigInt(intent.clientId),
            status: "failed",
            filledSize: 0n,
          },
          terminal: true,
          now: this.now(),
        });
        return;
      }
      this.event("hedge_result", {
        market: m.config.symbol,
        status: "unknown",
      });
      this.options.store.updateIntent(intent.id, "unknown");
      await this.hedgeEvent(m, {
        type: "unknown_outcome",
        clientOrderIndex: BigInt(intent.clientId),
        now: this.now(),
      });
    }
  }
  private recordHedgePnl(intent: Intent, result: HedgeResult): void {
    const m = this.market(intent.market);
    const payload = intent.payload as HedgeSubmission;
    const base = m.toAf(
      lighterToInt(result.filledBase, m.lighter.sizeDecimals, "down"),
    );
    const price = result.avgPrice
      ? lighterToInt(result.avgPrice, 9, "down")
      : payload.refPrice;
    const reference = payload.benchmarkPrice ?? payload.refPrice;
    const fee = result.fee ? signedDecimal(result.fee) : 0n;
    this.options.store.pnl({
      key: `hedge:${intent.clientId}`,
      market: intent.market,
      ts: this.now(),
      spread: 0n,
      rebates: 0n,
      hedgeCosts:
        ((payload.intent.side === "BID"
          ? price - reference
          : reference - price) *
          base) /
          AF_SCALE +
        fee,
      gas: 0n,
    });
  }
  private async resolveHedge(m: ResolvedMarket, client: bigint): Promise<void> {
    const intent = this.options.store
      .intents(true)
      .find((i) => i.venue === "lighter" && i.clientId === String(client));
    if (!intent) return;
    const resolution = await this.options.lighter.resolve(intent);
    if (
      resolution.status === "unknown" ||
      !resolution.result ||
      !("filledBase" in resolution.result)
    ) {
      this.paused.add(m.config.symbol);
      await this.cancelMarket(m.config.symbol);
      await this.alert("error", "unknown_hedge", m.config.symbol);
      return;
    }
    const result = resolution.result;
    this.event("hedge_result", {
      market: m.config.symbol,
      status: result.status,
      filledBase: result.filledBase,
      avgPrice: result.avgPrice,
      txHash: result.txHash,
      resolved: true,
    });
    this.options.store.updateIntent(
      intent.id,
      resolution.status,
      intent.txHash ?? undefined,
      result,
    );
    this.options.store.saveHedge(
      client,
      this.state(m.config.symbol).seenFills,
      intent.payload,
      resolution.status,
      result,
      intent.txHash,
    );
    this.recordHedgePnl(intent, result);
    await this.hedgeEvent(m, {
      type: "hedge_confirmed",
      result: {
        clientOrderIndex: client,
        status: result.status,
        filledSize: m.toAf(
          lighterToInt(result.filledBase, m.lighter.sizeDecimals, "down"),
        ),
      },
      terminal: true,
      now: this.now(),
    });
    this.hedgeAt.set(m.config.symbol, this.now());
    if (
      !this.options.store
        .intents(true)
        .some((i) => i.market === m.config.symbol)
    )
      this.paused.delete(m.config.symbol);
  }
  private freshHedgeBook(
    view: ReturnType<EngineOptions["feeds"]["view"]>,
  ): boolean {
    return (
      view.lighterConnected &&
      validBook(view.lighterBook) &&
      this.now() >= view.lighterBook.ts &&
      this.now() - view.lighterBook.ts <=
        this.options.config.risk.stalenessMs.lighterBook
    );
  }
  private async readAfPosition(symbol: string): Promise<AccountPosition> {
    const before = this.afPositions.get(symbol);
    const af = await this.options.af.position(symbol);
    // Do not overwrite a newer account event that arrived during this read.
    if (af.fresh && this.afPositions.get(symbol) === before)
      this.observeAfPosition(symbol, af);
    return af;
  }
  private async positions(symbol: string) {
    const [af, lighter] = await Promise.all([
      this.readAfPosition(symbol),
      this.options.lighter.position(symbol),
    ]);
    this.accounts.set(symbol, { af, lighter });
    if (af.fresh)
      this.options.store.transaction(() => {
        for (const order of this.options.store.orders(symbol)) {
          const pending = af.orders.find(
            (o) => o.clientOrderId === order.clientOrderId,
          );
          this.options.store.saveOrder(
            pending ? { ...order, size: pending.size } : order,
            pending ? "open" : "closed",
          );
        }
      });
    return { af, lighter };
  }
  reconcileAll(): Promise<void> {
    return this.queue(() => this.reconcileInternal());
  }
  private async reconcileInternal(): Promise<void> {
    for (const m of this.options.markets)
      await this.reconcileMarket(m.config.symbol);
    const newHour =
      Math.floor(this.now() / 3600000) !==
      Math.floor(this.lastFunding / 3600000);
    if (newHour || this.options.mode !== "paper") {
      for (const [name, venue] of [
        ["af", this.options.af],
        ["lighter", this.options.lighter],
      ] as const)
        if (
          venue.funding &&
          (newHour || (name === "af" && this.options.mode !== "paper"))
        ) {
          try {
            for (const payment of await venue.funding())
              this.options.store.funding(payment);
          } catch (error) {
            this.logFailure(error);
            await this.alert("warning", "funding_read_failed");
          }
        }
      this.lastFunding = this.now();
    }
  }
  private async reconcileMarket(symbol: string): Promise<void> {
    const m = this.market(symbol);
    const state = this.state(symbol);
    if (state.active?.status === "unknown")
      await this.resolveHedge(m, state.active.intent.clientOrderIndex);
    let positions: Awaited<ReturnType<Engine["positions"]>>;
    try {
      positions = await this.positions(symbol);
    } catch {
      await this.failClosed("position_read_failed", symbol);
      return;
    }
    const reason = this.reconcileDeferredReason(symbol);
    if (reason) {
      await this.deferReconcile(symbol, reason, positions);
      return;
    }
    const current = this.state(symbol);
    const result = reconcile({
      af: {
        marketId: symbol,
        base: { value: positions.af.base, scale: AF_SCALE },
      },
      lighter: {
        marketId: symbol,
        base: { value: positions.lighter.base, scale: AF_SCALE },
      },
      inFlight: [],
      fresh: {
        af: positions.af.fresh,
        lighter: positions.lighter.fresh,
        hedges: true,
      },
      // Reconciliation tolerance remains one joint step, including dust.
      afLot: { value: m.jointStep, scale: AF_SCALE },
      lighterLot: {
        value: m.jointStep,
        scale: AF_SCALE,
      },
    });
    this.event("reconcile", {
      market: symbol,
      action: result.type,
      reason: "reason" in result ? result.reason : undefined,
    });
    if (result.type === "failClosed") {
      await this.failClosed(result.reason, symbol);
      return;
    }
    if (!this.options.store.intents(true).some((i) => i.market === symbol))
      this.paused.delete(symbol);
    const net = positions.af.base + positions.lighter.base;
    this.saveState({
      ...current,
      unhedgedBase: net,
      unhedgedSince: net === 0n ? null : (current.unhedgedSince ?? this.now()),
    });
    // The reducer rounds -net to the joint hedge step, retains dust, and
    // persists/sends the correction through the same path as AF fills.
    if (result.type === "hedge" || net !== 0n)
      await this.hedgeEvent(m, { type: "timeout_tick", now: this.now() });
    this.reconcileDeferredAt.delete(symbol);
    this.reconcileStarved.delete(symbol);
  }
  async tick(): Promise<void> {
    await this.processControl();
    return this.queue(async () => {
      if (!this.running || this.stopping) return;
      if (this.now() - this.statusAt >= 30000) {
        for (const m of this.options.markets) {
          const symbol = m.config.symbol,
            v = this.options.feeds.view(symbol);
          const reason = this.breaker.state.latched
            ? "breaker"
            : this.reconcileStarved.has(symbol)
              ? "reconcile_starved"
              : this.pauseReasons.get(symbol);
          this.event("market_status", {
            market: symbol,
            status:
              reason || this.paused.has(symbol)
                ? `paused(${reason ?? "recovering"})`
                : "quoting",
            inventory: this.accounts.get(symbol)?.af.base ?? 0n,
            unhedged: this.state(symbol).unhedgedBase,
            hedgeable: this.state(symbol).hedgeableBase,
            dust: this.state(symbol).dustBase,
            afHourly: v.af.estimatedFundingRate,
            lighterHourly: v.lighterHourlyFunding,
            spread: validBook(v.afBook)
              ? Number(
                  (v.afBook.asks[0]?.price ?? 0n) -
                    (v.afBook.bids[0]?.price ?? 0n),
                ) / 1e9
              : null,
          });
        }
        this.statusAt = this.now();
      }
      for (const m of this.options.markets) {
        await this.hedgeEvent(m, { type: "timeout_tick", now: this.now() });
        await this.quoteMarket(m.config.symbol);
      }
      this.heartbeatAt = this.now();
      this.options.store.set("status_snapshot", {
        ts: this.now(),
        mode: this.options.mode,
        breaker: this.breaker.state,
        intents: this.options.store.intents(true),
        positions: [...this.accounts].map(([symbol, p]) => ({
          symbol,
          af: p.af.base,
          lighter: p.lighter.base,
          netDelta: p.af.base + p.lighter.base,
          unhedged: this.state(symbol).unhedgedBase,
          hedgeable: this.state(symbol).hedgeableBase,
          dust: this.state(symbol).dustBase,
          fresh: p.af.fresh && p.lighter.fresh,
          marginHeadroomPct: {
            af: p.af.marginHeadroomPct,
            lighter: p.lighter.marginHeadroomPct,
          },
        })),
      });
    });
  }
  private async processControl(): Promise<void> {
    const request = this.options.store.transaction(() => {
      const pending = this.options.store.get<ControlRequest>("control");
      if (!pending || pending.status !== "pending") return null;
      this.options.store.set("control", { ...pending, status: "running" });
      return pending;
    });
    if (!request) return;
    try {
      if (request.command === "cancel-all")
        await this.tripBreaker("operator_cancel_all");
      else if (request.command === "flatten") {
        await this.tripBreaker("operator_flatten");
        await this.flatten(request.argument ?? "all", true);
      } else {
        this.breaker.reset({
          acknowledged: true,
          note: request.argument ?? "",
        });
        this.options.store.set("breaker_reset_note", {
          note: request.argument,
          ts: this.now(),
        });
        for (const m of this.options.markets)
          this.saveState({ ...this.state(m.config.symbol), latched: false });
      }
      this.options.store.set("control", { ...request, status: "ok" });
    } catch {
      this.options.store.set("control", {
        ...request,
        status: "error",
        message: "Operator command failed; inspect positions and intents",
      });
    }
  }
  private async quoteMarket(symbol: string): Promise<void> {
    if (this.stopping || this.recovering || !this.running) return;
    if (
      this.breaker.state.latched ||
      this.reconcileStarved.has(symbol) ||
      this.paused.has(symbol) ||
      this.options.store.intents(true).some((i) => i.market === symbol)
    ) {
      await this.cancelMarket(symbol);
      return;
    }
    if (
      this.now() - (this.quoteAt.get(symbol) ?? -Infinity) <
      (this.options.minQuoteIntervalMs ??
        this.options.config.aftermath.minQuoteIntervalMs)
    )
      return;
    const m = this.market(symbol);
    const view = this.options.feeds.view(symbol);
    let account: Awaited<ReturnType<Engine["positions"]>>;
    try {
      account = await this.positions(symbol);
    } catch {
      await this.failClosed("quote_account_unknown", symbol);
      return;
    }
    if (
      !account.af.fresh ||
      !account.lighter.fresh ||
      staleReason(view, this.now(), this.options.config) !== null
    ) {
      await this.failClosed(
        staleReason(view, this.now(), this.options.config) ??
          "quote_account_stale",
        symbol,
      );
      return;
    }
    if (
      !validBook(view.afBook) ||
      !validBook(view.lighterBook) ||
      view.index <= 0n
    ) {
      await this.failClosed("invalid_quote_book", symbol);
      return;
    }
    if (view.af.tickInt !== m.af.tickInt || view.af.lotInt !== m.af.lotInt) {
      await this.failClosed("market_increments_changed", symbol);
      return;
    }
    this.quoteAt.set(symbol, this.now());
    const input = this.quoteInput(m, view, account);
    const plan = computeQuotes(input);
    const d = plan.diagnostics;
    const outside = outsideBook(input.book, input.ownOrders);
    const resting = plan.batches.flatMap((batch) => [
      ...batch.keep,
      ...batch.place.map((order) => ({
        ...order,
        price: validBook(outside)
          ? clampPostOnly(order.price, order.side, m.af.tickInt, outside)
          : order.price,
      })),
    ]);
    const impact = quoteImpact(
      outside,
      view.index,
      resting,
      view.af.fundingFrequencyMs,
      view.af.fundingPeriodMs,
    );
    const allowance =
      d === undefined
        ? 0n
        : (input.lighterMid *
            BigInt(
              Math.floor(
                (input.compressionBudgetBp ??
                  input.strategy.compressionBudgetBp) * 1e6,
              ),
            )) /
          10000000000n;
    const profitFloorLimited =
      impact.restingOrders > 0 &&
      d !== undefined &&
      (d.side === "ASK"
        ? d.floor - allowance > d.neutral
        : d.floor + allowance < d.neutral);
    const decimal = (value: bigint | undefined) =>
      value === undefined ? null : Number(value) / 1e9;
    const report = {
      market: symbol,
      ...impact,
      profitFloorLimited,
      side: d?.side ?? null,
      outsidePremiumBp: d?.outsidePremiumBp ?? null,
      predictedAfHourly: d?.predictedAfHourly ?? view.af.estimatedFundingRate,
      carryBp: d?.carryBp ?? null,
      effectiveCarryBp: d?.effectiveCarryBp ?? null,
      deltaBp: d?.deltaBp ?? null,
      lighterHourly: view.lighterHourlyFunding,
      floor: decimal(d?.floor),
      neutral: decimal(d?.neutral),
      target: decimal(d?.target),
      ordersToPlace: plan.batches.reduce((s, b) => s + b.place.length, 0),
      ordersToKeep: plan.batches.reduce((s, b) => s + b.keep.length, 0),
      ordersToCancel: plan.batches.reduce((s, b) => s + b.cancel.length, 0),
      reasons: plan.reasons,
    };
    const key = JSON.stringify(report, (_, v) =>
      typeof v === "bigint" ? String(v) : v,
    );
    if (this.planKeys.get(symbol) !== key) {
      this.event("quote_plan", report);
      this.planKeys.set(symbol, key);
    }
    this.pauseReasons.set(symbol, plan.reasons.join(","));
    if (plan.reasons.includes("daily_loss")) {
      this.breaker.trip("daily_loss");
      this.event("fail_closed", { reason: "daily_loss", market: symbol });
      await this.cancelAllInternal();
      return;
    }
    for (const batch of plan.batches) {
      if (!batch.cancel.length && !batch.place.length) continue;
      const fresh = this.options.feeds.view(symbol);
      const outside = outsideBook(
        fresh.afBook,
        this.options.store.orders(symbol),
      );
      if (
        !validBook(outside) ||
        this.now() - outside.ts > this.options.config.risk.stalenessMs.afBook
      ) {
        await this.failClosed("prebuild_book_stale", symbol);
        return;
      }
      const places = batch.place.map((o) => ({
        ...o,
        price: clampPostOnly(o.price, o.side, m.af.tickInt, outside),
      }));
      let orders: OwnOrder[] = [];
      const intent = this.options.store.transaction(() => {
        const ids = places.length
          ? this.options.store.allocate("af", places.length)
          : [];
        orders = places.map((o, i) => ({
          ...o,
          marketId: symbol,
          clientOrderId: String(ids[i]),
          createdAt: this.now(),
        }));
        const payload = {
          market: symbol,
          orders,
          cancel: batch.cancel,
          reduceOnly: batch.reduceOnly,
          hasPosition: account.af.exists,
          expiryTimestamp:
            this.now() + this.options.config.aftermath.quoteTtlMs,
          postOnly: true,
          maxOrderNotional: input.clipNotional ?? usd(m.config.clipUsd),
          shouldAbortOnMissingId: false,
        } as const;
        return this.options.store.createIntent({
          venue: "af",
          kind: "quote",
          clientId: orders.map((o) => o.clientOrderId).join(","),
          market: symbol,
          payload,
        });
      });
      const durable = intent;
      try {
        const receipt = await this.options.af.quote(
          durable.payload as Parameters<EngineOptions["af"]["quote"]>[0],
          this.context(durable),
        );
        this.afTx(symbol, "quote", receipt);
        this.options.store.transaction(() => {
          this.options.store.updateIntent(
            durable.id,
            receipt.simulated
              ? "simulated"
              : receipt.status === "success"
                ? "confirmed"
                : "failed",
            receipt.digest,
            receipt,
          );
          if (receipt.status === "success") {
            this.options.store.closeOrders(symbol, batch.cancel);
            for (const order of receipt.placedOrders ?? orders)
              this.options.store.saveOrder(order, "open");
          }
          this.options.store.pnl({
            key: `gas:${durable.id}`,
            market: symbol,
            ts: this.now(),
            spread: 0n,
            rebates: 0n,
            hedgeCosts: 0n,
            gas: receipt.gasUsd,
          });
        });
      } catch (error) {
        this.logFailure(error);
        const current = this.options.store.intent(durable.id);
        this.options.store.updateIntent(
          durable.id,
          current?.status === "prepared" && !current.txHash
            ? "abandoned"
            : "unknown",
        );
        await this.failClosed("quote_outcome_unknown", symbol);
        return;
      }
      if (
        this.paused.has(symbol) ||
        this.breaker.state.latched ||
        this.stopping
      )
        await this.cancelMarket(symbol);
      this.quoteAt.set(symbol, this.now());
      this.requotes.set(symbol, [
        ...(this.requotes.get(symbol) ?? []).filter(
          (t) => this.now() - t < 60000,
        ),
        this.now(),
      ]);
    }
  }
  private quoteInput(
    m: ResolvedMarket,
    view: ReturnType<EngineOptions["feeds"]["view"]>,
    account: { af: AccountPosition; lighter: AccountPosition },
  ): QuoteInput {
    const c = this.options.config;
    const symbol = m.config.symbol;
    const state = this.state(symbol);
    const exposure = splitUnhedged(state.unhedgedBase, this.hedgePolicy(m));
    const middle = mid(view.lighterBook);
    const clipBase = (usd(m.config.clipUsd) * AF_SCALE) / middle;
    const outside = outsideBook(view.afBook, this.options.store.orders(symbol));
    const bid = outside.bids[0]?.price ?? view.index;
    const ask = outside.asks[0]?.price ?? view.index;
    const outsidePremium =
      Number(((bid + ask - 2n * view.index) * 100000000n) / (2n * view.index)) /
      10000;
    const predicted = relaxedTwa(
      (view.af.premiumTwap / view.af.indexPrice) * 10000,
      outsidePremium,
      c.aftermath.quoteTtlMs / 3600000,
      view.af.fundingFrequencyMs / 3600000,
    );
    const atCap =
      abs(account.af.base) >=
      (usd(m.config.maxPositionUsd) * AF_SCALE) / middle;
    const side = atCap
      ? account.af.base > 0n
        ? "BID"
        : "ASK"
      : predicted > 0
        ? "BID"
        : "ASK";
    const hedge = walk(view.lighterBook, side, clipBase);
    const margin =
      account.af.marginHeadroomPct < account.lighter.marginHeadroomPct
        ? account.af.marginHeadroomPct
        : account.lighter.marginHeadroomPct;
    const own = this.options.store.orders(symbol);
    const premiumBp = (view.af.premiumTwap / view.af.indexPrice) * 10000;
    const basis =
      Number(((middle - view.index) * 100000000n) / view.index) / 10000;
    const oldBasis = this.options.store.get<number>(`basis:${symbol}`) ?? basis;
    this.options.store.set(`basis:${symbol}`, 0.05 * basis + 0.95 * oldBasis);
    const pendingUsd = own
      .filter((o) => !o.reduceOnly)
      .reduce((s, o) => s + notional(o.size, o.price), 0n);
    const totalUsd = this.options.markets.reduce((sum, market) => {
      const position = this.accounts.get(market.config.symbol)?.af.base ?? 0n;
      return (
        sum +
        notional(position, this.options.feeds.view(market.config.symbol).index)
      );
    }, 0n);
    const pendingTotal = this.options.store
      .orders()
      .filter((o) => !o.reduceOnly)
      .reduce((s, o) => s + notional(o.size, o.price), 0n);
    const daily =
      this.options.store
        .pnlRows()
        .filter((p) => p.ts >= Math.floor(this.now() / 86400000) * 86400000)
        .reduce(
          (sum, p) => sum + p.spread + p.rebates - p.hedgeCosts - p.gas,
          0n,
        ) +
      this.options.store
        .fundingPayments()
        .filter((p) => p.ts >= Math.floor(this.now() / 86400000) * 86400000)
        .reduce((s, p) => s + p.amount, 0n);
    const gates = [
      ...evaluateGates({
        now: this.now(),
        afBookTs: view.afBook.ts,
        afOracleTs: view.oracleTs,
        lighterBookTs: view.lighterBook.ts,
        stalenessMs: c.risk.stalenessMs,
        basisBp: basis,
        basisEmaBp: oldBasis,
        basisBandBp: c.risk.basisBandBp,
        predictedAfHourly: view.af.estimatedFundingRate,
        inventory: account.af.base,
        sessionOpen: view.af.session.isOpen,
        pauseWhenSessionClosed: c.risk.pauseWhenSessionClosed,
        marginHeadroomPct: margin,
        minMarginHeadroomPct: c.risk.minMarginHeadroomPct,
        unhedgedUsd: notional(exposure.hedgeableBase, middle),
        maxUnhedgedUsd: usd(c.risk.maxUnhedgedUsd),
        unhedgedSince:
          exposure.hedgeableBase === 0n ? null : state.unhedgedSince,
        maxUnhedgedAgeMs: c.risk.maxUnhedgedAgeMs,
        oiHeadroom: usd(view.af.maxOpenInterestBase) - view.openInterest,
        breakerLatched: this.breaker.state.latched,
      }),
      ...evaluateLimits({
        marketNotional: notional(account.af.base, middle),
        pendingMarketNotional: pendingUsd,
        maxMarketNotional: usd(m.config.maxPositionUsd),
        totalNotional: totalUsd,
        pendingTotalNotional: pendingTotal,
        maxTotalNotional: usd(c.risk.maxTotalNotionalUsd),
        dailyPnl: daily,
        dailyLossLimit: usd(c.risk.dailyLossLimitUsd),
      }),
    ];
    const globalFreeUsd =
      usd(c.risk.maxTotalNotionalUsd) - totalUsd - (pendingTotal - pendingUsd);
    if (globalFreeUsd <= 0n && account.af.base === 0n)
      gates.push({ ok: false, reason: "global_notional" });
    const maxBaseFromGlobal =
      abs(account.af.base) +
      (globalFreeUsd > 0n ? (globalFreeUsd * AF_SCALE) / middle : 0n);
    const marketMaxBase = (usd(m.config.maxPositionUsd) * AF_SCALE) / middle;
    const quoteMaxBase =
      marketMaxBase < maxBaseFromGlobal ? marketMaxBase : maxBaseFromGlobal;
    const openingBudget = globalFreeUsd / BigInt(m.config.levels);
    const clipBudget =
      abs(account.af.base) >= quoteMaxBase && account.af.base !== 0n
        ? usd(m.config.clipUsd)
        : openingBudget < usd(m.config.clipUsd)
          ? openingBudget
          : usd(m.config.clipUsd);
    const capacity =
      ((account.af.availableUsd * AF_SCALE) /
        middle /
        BigInt(Math.max(1, Math.ceil(view.af.imr * 10000)))) *
      10000n;
    const lighterCapacity = (account.lighter.availableUsd * AF_SCALE) / middle;
    return {
      marketId: symbol,
      book: view.afBook,
      ownOrders: own,
      index: view.index,
      lighterMid: middle,
      tick: view.af.tickInt,
      lot: m.jointStep,
      inventory: account.af.base,
      clipBase,
      clipNotional: clipBudget > 0n ? clipBudget : 1n,
      maxPositionBase:
        marketMaxBase < maxBaseFromGlobal
          ? marketMaxBase
          : maxBaseFromGlobal > 0n
            ? maxBaseFromGlobal
            : m.jointStep,
      levels: m.config.levels as 1 | 2 | 3,
      minNotional: m.minNotional,
      usdScale: AF_SCALE,
      hedgeDepthBase: hedge.depth,
      marginAvailableBase:
        capacity < lighterCapacity ? capacity : lighterCapacity,
      pendingOpeningBase: 0n,
      oi: {
        openInterest: view.openInterest,
        maxOpenInterest: usd(view.af.maxOpenInterestBase),
        halfOiThreshold: usd(view.af.maxOpenInterestThresholdBase),
      },
      gates,
      funding: {
        twaPremiumBp: premiumBp,
        deltaHours: c.aftermath.quoteTtlMs / 3600000,
        omegaHours: view.af.fundingFrequencyMs / 3600000,
        f: view.af.fundingFrequencyMs / 3600000,
        rhoHours: view.af.fundingPeriodMs / 3600000,
        nearZeroHourly: 1e-8,
        mean: 0,
        kappa: 0,
      },
      lighterFunding: {
        hourlyFraction: view.lighterHourlyFunding,
        mean: 0,
        kappa: 0,
      },
      costs: {
        hedgeBp: hedge.costBp + Number(m.lighter.takerFee) * 100,
        exitBp: hedge.costBp + Number(m.lighter.takerFee) * 100,
        marginBp: 0,
        makerFeeBp: view.af.makerFee * 10000,
      },
      strategy: { ...c.strategy, sigmaPhi: 0 },
      compressionBudgetBp: m.config.compressionBudgetBp,
      minRequoteTicks: c.aftermath.minRequoteTicks,
      edgeBandBp: 1,
      now: this.now(),
      quoteTtlMs: c.aftermath.quoteTtlMs,
      requotesInLastMinute: (this.requotes.get(symbol) ?? []).filter(
        (t) => this.now() - t < 60000,
      ).length,
      maxRequotesPerMinute: c.aftermath.maxRequotesPerMinute,
    };
  }
  cancelAll(): Promise<void> {
    return this.queue(() => this.cancelAllInternal());
  }
  private async cancelAllInternal(): Promise<void> {
    for (const m of this.options.markets)
      await this.cancelMarket(m.config.symbol);
  }
  private async cancelMarket(symbol: string): Promise<void> {
    this.planKeys.delete(symbol);
    const position = await this.readAfPosition(symbol);
    if (!position.fresh)
      throw new SafetyRefusal("Cannot verify AF orders from a stale account");
    const orders = position.orders;
    if (!orders.length) {
      this.options.store.closeOrders(symbol);
      return;
    }
    const intent = this.options.store.createIntent({
      venue: "af",
      kind: "cancel",
      clientId: orders.map((o) => o.clientOrderId).join(","),
      market: symbol,
      payload: { orders },
    });
    try {
      const result = await this.options.af.cancel(
        symbol,
        orders,
        this.context(intent),
      );
      this.options.store.updateIntent(
        intent.id,
        result.simulated
          ? "simulated"
          : result.status === "success"
            ? "confirmed"
            : "failed",
        result.digest,
        result,
      );
      this.afTx(symbol, "cancel", result);
      if (result.status !== "success")
        throw new SafetyRefusal("AF cancellation failed");
      this.options.store.closeOrders(symbol);
    } catch (error) {
      if (!terminal(this.options.store.intent(intent.id)?.status ?? "unknown"))
        this.options.store.updateIntent(intent.id, "unknown");
      throw error;
    }
  }
  async watchdog(): Promise<void> {
    if (this.watchdogBusy || this.stopping || !this.running) return;
    const stalled =
      this.now() - this.heartbeatAt > this.options.config.aftermath.heartbeatMs;
    const stale = this.options.markets.some((m) => {
      const v = this.options.feeds.view(m.config.symbol);
      return staleReason(v, this.now(), this.options.config) !== null;
    });
    if (!stalled && !stale) return;
    this.watchdogBusy = true;
    try {
      for (const m of this.options.markets) this.paused.add(m.config.symbol);
      await this.cancelAllInternal();
      this.event("fail_closed", {
        reason: stalled ? "heartbeat_stalled" : "required_feed_stale",
        market: "all",
      });
      await this.alert(
        "critical",
        stalled ? "heartbeat_stalled" : "required_feed_stale",
      );
    } finally {
      this.watchdogBusy = false;
    }
  }
  tripBreaker(reason: string): Promise<void> {
    return this.queue(async () => {
      this.breaker.trip(reason);
      this.event("fail_closed", { reason, market: "all" });
      await this.cancelAllInternal();
      await this.alert("critical", reason);
    });
  }
  private async failClosed(reason: string, market?: string): Promise<void> {
    this.event("fail_closed", { reason, market: market ?? "all" });
    for (const m of this.options.markets)
      if (!market || m.config.symbol === market)
        this.pauseReasons.set(m.config.symbol, reason);
    for (const m of this.options.markets)
      if (!market || market === m.config.symbol)
        this.paused.add(m.config.symbol);
    try {
      if (market) await this.cancelMarket(market);
      else await this.cancelAllInternal();
    } finally {
      await this.alert("error", reason, market);
    }
  }
  private alert(
    severity: "warning" | "error" | "critical",
    reason: string,
    market?: string,
  ): Promise<void> {
    return this.options.alerts.send({
      severity,
      reason,
      market,
      mode: this.options.mode,
      ts: this.now(),
    });
  }
  shutdown(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) this.options.clock.clearTimeout(timer);
    this.timers.clear();
    return this.queue(async () => {
      await this.cancelAllInternal();
      for (const m of this.options.markets) {
        const p = await this.options.af.position(m.config.symbol);
        if (!p.fresh || p.orders.length)
          throw new SafetyRefusal(
            "Shutdown cancellation could not be verified",
          );
      }
      this.options.feeds.stop();
      this.running = false;
      this.options.store.flush();
    });
  }
  async flatten(symbol: string, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new SafetyRefusal("flatten requires --confirm");
    const markets =
      symbol === "all" ? this.options.markets : [this.market(symbol)];
    const wasRecovering = this.recovering;
    try {
      await this.queue(async () => {
        this.recovering = true;
        await this.options.feeds.refresh();
        await this.cancelAllInternal();
        await this.resolveIntents();
        if (this.options.store.intents(true).length)
          throw new SafetyRefusal("Cannot flatten with unresolved intents");
        for (const m of markets) {
          const account = await this.positions(m.config.symbol);
          if (!account.af.fresh || !account.lighter.fresh)
            throw new SafetyRefusal("Cannot flatten unknown positions");
          if (account.af.base !== 0n) {
            const intent = this.options.store.createIntent({
              venue: "af",
              kind: "flatten",
              clientId: "",
              market: m.config.symbol,
              payload: {
                side: account.af.base > 0n ? "ASK" : "BID",
                size: abs(account.af.base),
              },
            });
            try {
              const receipt = await this.options.af.flatten(
                m.config.symbol,
                account.af.base > 0n ? "ASK" : "BID",
                abs(account.af.base),
                this.options.config.lighter.emergencySlippageBps,
                this.context(intent),
              );
              this.afTx(m.config.symbol, "unwind", receipt);
              this.options.store.updateIntent(
                intent.id,
                receipt.simulated
                  ? "simulated"
                  : receipt.status === "success"
                    ? "confirmed"
                    : "failed",
                receipt.digest,
                receipt,
              );
              if (receipt.status !== "success")
                throw new SafetyRefusal("AF flatten failed");
            } catch (error) {
              if (
                !terminal(
                  this.options.store.intent(intent.id)?.status ?? "unknown",
                )
              )
                this.options.store.updateIntent(intent.id, "unknown");
              throw error;
            }
          }
          const latest = await this.positions(m.config.symbol);
          if (latest.af.base !== 0n)
            throw new SafetyRefusal("AF flatten remains incomplete");
          if (latest.lighter.base !== 0n) {
            const client = this.options.store.allocate("lighter")[0] as bigint;
            const payload: HedgeSubmission = {
              intent: {
                marketId: m.config.symbol,
                clientOrderIndex: client,
                side: latest.lighter.base > 0n ? "ASK" : "BID",
                size: abs(latest.lighter.base),
                slippageBps: Math.floor(
                  this.options.config.lighter.emergencySlippageBps,
                ),
              },
              baseAmount: m.toLighter(abs(latest.lighter.base)),
              refPrice: mid(
                this.options.feeds.view(m.config.symbol).lighterBook,
              ),
              reduceOnly: true,
            };
            const intent = this.options.store.createIntent({
              venue: "lighter",
              kind: "flatten",
              clientId: String(client),
              market: m.config.symbol,
              payload,
            });
            this.options.store.saveHedge(client, [], payload, "prepared");
            try {
              const result = await this.options.lighter.hedge(
                payload,
                this.context(intent),
              );
              this.options.store.updateIntent(
                intent.id,
                "confirmed",
                result.txHash,
                result,
              );
              this.options.store.saveHedge(
                client,
                [],
                payload,
                "confirmed",
                result,
                result.txHash,
              );
              this.recordHedgePnl(intent, result);
            } catch (error) {
              this.options.store.updateIntent(intent.id, "unknown");
              throw error;
            }
          }
          const final = await this.positions(m.config.symbol);
          if (
            !final.af.fresh ||
            !final.lighter.fresh ||
            final.af.base !== 0n ||
            final.lighter.base !== 0n
          )
            throw new SafetyRefusal(
              "Flatten incomplete; inspect status before retrying",
            );
          this.saveState({
            ...this.state(m.config.symbol),
            active: null,
            unhedgedBase: 0n,
            unhedgedSince: null,
          });
        }
      });
    } finally {
      this.recovering = wasRecovering;
    }
  }
  health() {
    return {
      mode: this.options.mode,
      uptimeMs: this.now() - this.startedAt,
      breaker: this.breaker.state,
      accounting: this.options.store.get("accounting_capabilities"),
      recovering: this.recovering,
      markets: this.options.markets.map((m) => {
        const symbol = m.config.symbol;
        const view = this.options.feeds.view(symbol);
        return {
          symbol,
          paused: this.paused.has(symbol),
          feeds: {
            afBookAgeMs: this.now() - view.afBook.ts,
            oracleAgeMs: this.now() - view.oracleTs,
            afMarketAgeMs: this.now() - view.marketTs,
            lighterStatsAgeMs: this.now() - view.statsTs,
            afSocketAgeMs: this.now() - (view.afFrameTs ?? this.now()),
            lighterSocketAgeMs:
              this.now() - (view.lighterFrameTs ?? this.now()),
            staleReason: staleReason(view, this.now(), this.options.config),
            lighterBookAgeMs: this.now() - view.lighterBook.ts,
            afConnected: view.afConnected,
            lighterConnected: view.lighterConnected,
            afBookStale:
              this.now() - view.afBook.ts >
              this.options.config.risk.stalenessMs.afBook,
            oracleStale:
              this.now() - view.oracleTs >
              this.options.config.risk.stalenessMs.afOracle,
            lighterBookStale:
              this.now() - view.lighterBook.ts >
              this.options.config.risk.stalenessMs.lighterBook,
          },
          unhedged: String(this.state(symbol).unhedgedBase),
          hedgeable: String(this.state(symbol).hedgeableBase),
          dust: String(this.state(symbol).dustBase),
          lastQuote: this.quoteAt.get(symbol) ?? null,
          lastHedge: this.hedgeAt.get(symbol) ?? null,
        };
      }),
    };
  }
  async status() {
    const positions = [];
    for (const m of this.options.markets) {
      const p = await this.positions(m.config.symbol);
      positions.push({
        symbol: m.config.symbol,
        af: String(p.af.base),
        lighter: String(p.lighter.base),
        netDelta: String(p.af.base + p.lighter.base),
        unhedged: String(this.state(m.config.symbol).unhedgedBase),
        hedgeable: String(this.state(m.config.symbol).hedgeableBase),
        dust: String(this.state(m.config.symbol).dustBase),
        fresh: p.af.fresh && p.lighter.fresh,
        marginHeadroomPct: {
          af: p.af.marginHeadroomPct,
          lighter: p.lighter.marginHeadroomPct,
        },
      });
    }
    return {
      mode: this.options.mode,
      positions,
      accounting: this.options.store.get("accounting_capabilities"),
      intents: this.options.store.intents(true),
      breaker: this.breaker.state,
    };
  }
  pnl(byMarket = false) {
    const markets = byMarket
      ? this.options.markets.map((m) => m.config.symbol)
      : ["all"];
    return markets.map((m) => {
      const rows = this.options.store
        .pnlRows()
        .filter((r) => m === "all" || r.market === m);
      const sum = (
        key: keyof Pick<PnlRow, "spread" | "rebates" | "hedgeCosts" | "gas">,
      ) => rows.reduce((s, r) => s + r[key], 0n);
      const payments = this.options.store
        .fundingPayments()
        .filter((r) => m === "all" || r.market === m);
      const received = payments
        .filter((p) => p.amount > 0n)
        .reduce((s, p) => s + p.amount, 0n);
      const paid = payments
        .filter((p) => p.amount < 0n)
        .reduce((s, p) => s - p.amount, 0n);
      return {
        market: m,
        usdScale: String(AF_SCALE),
        spread: String(sum("spread")),
        makerRebates: String(sum("rebates")),
        hedgeCosts: String(sum("hedgeCosts")),
        fundingReceived: String(received),
        fundingPaid: String(paid),
        fundingByVenue: ["af", "lighter"].flatMap((venue) =>
          ["derived", "venue", "paper"].map((source) => ({
            venue,
            source,
            amount: String(
              payments
                .filter((p) => p.venue === venue && p.source === source)
                .reduce((sum, p) => sum + p.amount, 0n),
            ),
          })),
        ),
        gas: String(sum("gas")),
        total: String(
          sum("spread") +
            sum("rebates") -
            sum("hedgeCosts") +
            received -
            paid -
            sum("gas"),
        ),
      };
    });
  }
}
export function signedDecimal(value: string): bigint {
  return value.startsWith("-")
    ? -lighterToInt(value.slice(1), 9, "down")
    : lighterToInt(value, 9, "down");
}
