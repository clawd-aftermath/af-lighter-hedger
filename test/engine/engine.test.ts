import { expect, test } from "bun:test";
import { Logger } from "../../src/core/logger";
import { AF_SCALE } from "../../src/core/units";
import { Engine, SafetyRefusal } from "../../src/engine/engine";
import { resolveMarkets } from "../../src/engine/markets";
import { afMarket, fixture, lighterMarket, required } from "./helpers";

test("quote -> AF fill -> durable hedge -> confirmed -> zero net", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  expect(f.af.orders).toHaveLength(1);
  await f.engine.onFill(f.af.fill());
  expect(f.lighter.requests).toHaveLength(1);
  expect(f.af.base + f.lighter.base).toBe(0n);
  expect(f.engine.state("SOL").unhedgedBase).toBe(0n);
  expect(f.store.intents(true)).toHaveLength(0);
  f.store.close();
});
test("terminal partial is followed by remainder through the same path", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  f.lighter.partial = 200000000n;
  const fill = f.af.fill();
  await f.engine.onFill(fill);
  expect(f.lighter.requests.map((r) => r.intent.size)).toEqual([
    fill.size,
    fill.size - 200000000n,
  ]);
  expect(f.af.base + f.lighter.base).toBe(0n);
  f.store.close();
});
test("timeout stays unknown and REST resolution does not resend", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  f.lighter.timeout = true;
  await f.engine.onFill(f.af.fill());
  expect(f.engine.state("SOL").active?.status).toBe("unknown");
  expect(f.store.intents(true)).toHaveLength(1);
  f.lighter.resolvable = true;
  await f.engine.reconcileAll();
  expect(f.lighter.requests).toHaveLength(1);
  expect(f.engine.state("SOL").unhedgedBase).toBe(0n);
  expect(f.lighter.resolutions).toBeGreaterThan(0);
  f.store.close();
});
test("reconnect replay does not double hedge", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  const fill = f.af.fill();
  await f.engine.onFill(fill);
  await f.engine.handle({ type: "reconnect", venue: "af" });
  await f.engine.onFill(fill);
  expect(f.lighter.requests).toHaveLength(1);
  expect(f.store.fills()).toHaveLength(1);
  f.store.close();
});
test("stale Lighter account fails closed and pulls quotes", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  f.lighter.fresh = false;
  f.clock.advance(f.config.risk.reconcileQuiescenceMs);
  await f.engine.reconcileAll();
  expect(f.af.orders).toHaveLength(0);
  expect(f.alerts.some((a) => a.reason === "stale_lighter")).toBe(true);
  f.store.close();
});
test("breaker pulls quotes while new fills still hedge", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  const fill = f.af.fill(200000000n);
  await f.engine.tripBreaker("manual");
  expect(f.af.orders).toHaveLength(0);
  await f.engine.onFill(fill);
  expect(f.lighter.requests).toHaveLength(1);
  expect(f.store.load()?.latched).toBe(true);
  await f.engine.tick();
  expect(f.af.quotes).toHaveLength(1);
  f.store.close();
});
test("startup abandons provably unsent intent before quoting", async () => {
  const f = fixture();
  const intent = f.store.createIntent({
    venue: "lighter",
    kind: "hedge",
    market: "SOL",
    clientId: "1",
    payload: {},
  });
  await f.engine.start(false);
  expect(f.store.intent(intent.id)?.status).toBe("abandoned");
  await f.engine.tick();
  expect(f.af.orders).toHaveLength(1);
  f.store.close();
});
test("startup refuses a sent intent without authoritative result", async () => {
  const f = fixture();
  const intent = f.store.createIntent({
    venue: "af",
    kind: "quote",
    market: "SOL",
    clientId: "1",
    payload: {},
  });
  f.store.updateIntent(intent.id, "unknown", "digest");
  await expect(f.engine.start(false)).rejects.toBeInstanceOf(SafetyRefusal);
  expect(f.af.quotes).toHaveLength(0);
  f.store.close();
});
test("SIGTERM shutdown cancels and verifies without flattening", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  f.af.base = -AF_SCALE;
  f.lighter.base = AF_SCALE;
  const checks = f.af.checks;
  await f.engine.shutdown();
  expect(f.af.cancels).toBe(1);
  expect(f.af.checks).toBeGreaterThan(checks + 1);
  expect(f.af.base).toBe(-AF_SCALE);
  expect(f.lighter.base).toBe(AF_SCALE);
  f.store.close();
});
test("stale hedge book never submits a hedge", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  const fill = f.af.fill();
  f.feeds.view("SOL").lighterBook.ts = 0;
  await f.engine.onFill(fill);
  expect(f.lighter.requests).toHaveLength(0);
  expect(f.af.orders).toHaveLength(0);
  expect(f.engine.state("SOL").unhedgedBase).toBe(-fill.size);
  f.store.close();
});
test("reconciliation mismatch sends through reducer ledger", async () => {
  const f = fixture();
  f.af.base = -AF_SCALE;
  await f.engine.start(false);
  expect(f.lighter.requests).toHaveLength(0);
  f.clock.advance(f.config.risk.reconcileQuiescenceMs);
  await f.engine.reconcileAll();
  expect(f.lighter.requests).toHaveLength(1);
  expect(f.lighter.base).toBe(AF_SCALE);
  expect(f.store.intents().some((i) => i.kind === "hedge")).toBe(true);
  f.store.close();
});
test("persistent replay survives engine reconstruction", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  const fill = f.af.fill();
  await f.engine.onFill(fill);
  await f.engine.shutdown();
  const engine = new Engine(f.options);
  await engine.start(false);
  await engine.onFill(fill);
  expect(f.lighter.requests).toHaveLength(1);
  f.store.close();
});
test("quote throttle is per market and uses injected clock", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  await f.engine.tick();
  expect(f.af.quotes).toHaveLength(1);
  f.store.close();
});
test("disconnect cancels and reconnect snapshots before requoting", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  await f.engine.handle({ type: "disconnect", venue: "lighter" });
  expect(f.af.orders).toHaveLength(0);
  const refreshes = f.feeds.refreshes;
  await f.engine.handle({ type: "reconnect", venue: "lighter" });
  expect(f.feeds.refreshes).toBe(refreshes + 1);
  f.store.close();
});
test("watchdog cancels after loop stall", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  f.clock.advance(11000);
  await f.engine.watchdog();
  expect(f.af.orders).toHaveLength(0);
  expect(f.alerts.some((a) => a.reason === "heartbeat_stalled")).toBe(true);
  f.store.close();
});
test("repeated hedge rejection latches and backs off", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  f.lighter.fail = true;
  await f.engine.onFill(f.af.fill());
  expect(f.lighter.requests).toHaveLength(2);
  expect(f.engine.breaker.state.latched).toBe(true);
  expect(f.engine.state("SOL").retryAt).not.toBeNull();
  f.store.close();
});
test("status and pnl label paper and expose ledger", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  await f.engine.onFill(f.af.fill());
  const status = await f.engine.status();
  expect(status.mode).toBe("paper");
  expect(status.positions[0]?.netDelta).toBe("0");
  expect(f.engine.pnl(true)[0]?.market).toBe("SOL");
  f.store.close();
});
test("flatten requires explicit confirmation", async () => {
  const f = fixture();
  await expect(f.engine.flatten("SOL", false)).rejects.toBeInstanceOf(
    SafetyRefusal,
  );
  expect(f.af.cancels).toBe(0);
  f.store.close();
});
test("flatten closes both positions reduce-only", async () => {
  const f = fixture();
  f.af.base = -AF_SCALE;
  f.lighter.base = AF_SCALE;
  await f.engine.flatten("SOL", true);
  expect(f.af.base + f.lighter.base).toBe(0n);
  expect(f.lighter.requests[0]?.reduceOnly).toBe(true);
  f.store.close();
});
test("healthy endpoint data contains quote and hedge times", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  await f.engine.onFill(f.af.fill());
  const health = f.engine.health();
  expect(health.markets[0]?.lastQuote).toBe(f.clock.now());
  expect(health.markets[0]?.lastHedge).toBe(f.clock.now());
  f.store.close();
});

test("race: position correction defers until the fill replay triggers a hedge", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  const fill = f.af.fill();
  await f.engine.handle({ type: "position", market: "SOL" });
  await f.engine.reconcileAll();
  expect(f.lighter.requests).toHaveLength(0);
  await f.engine.onFill(fill);
  expect(f.lighter.requests).toHaveLength(1);
  expect(f.engine.state("SOL").unhedgedBase).toBe(0n);
  f.store.close();
});
test("invalid Lighter book still persists the AF fill", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  const fill = f.af.fill();
  f.feeds.view("SOL").lighterBook.asks = [];
  await f.engine.onFill(fill);
  expect(f.store.fills()).toHaveLength(1);
  expect(f.lighter.requests).toHaveLength(0);
  f.store.close();
});
test("cancel-all operator request is executed by the bot process", async () => {
  const f = fixture();
  await f.engine.start(false);
  await f.engine.tick();
  f.store.set("control", {
    id: "operator",
    command: "cancel-all",
    status: "pending",
  });
  await f.engine.tick();
  expect(f.af.orders).toHaveLength(0);
  expect(f.engine.breaker.state.latched).toBe(true);
  expect(f.store.get<{ status: string }>("control")?.status).toBe("ok");
  f.store.close();
});

test("global risk cap bounds a new quote before placement", async () => {
  const f = fixture();
  f.config.risk.maxTotalNotionalUsd = 20;
  await f.engine.start(false);
  await f.engine.tick();
  const quote = f.af.orders[0];
  expect(quote).toBeDefined();
  if (!quote) throw new Error("quote absent");
  expect((quote.price * quote.size) / AF_SCALE).toBeLessThanOrEqual(
    20n * AF_SCALE,
  );
  f.store.close();
});
test("changed market increments fail closed until restart", async () => {
  const f = fixture();
  await f.engine.start(false);
  f.feeds.view("SOL").af = {
    ...f.feeds.view("SOL").af,
    tickInt: 2n * AF_SCALE,
  };
  await f.engine.tick();
  expect(f.af.quotes).toHaveLength(0);
  expect(f.alerts.some((a) => a.reason === "market_increments_changed")).toBe(
    true,
  );
  f.store.close();
});

test("partial AF dust survives aging and reconciliation, then accumulates into a hedge", async () => {
  const f = fixture();
  const events: Record<string, unknown>[] = [];
  const engine = new Engine({
    ...f.options,
    logger: new Logger({ write: (line) => events.push(JSON.parse(line)) }),
  });
  // Dust exceeds this cap in USD, but cannot be hedged on its own.
  f.config.risk.maxUnhedgedUsd = 1;
  await engine.start(false);
  await engine.tick();
  const fill = f.af.fill(40000000n);
  await engine.onFill(fill);
  await engine.handle({ type: "position", market: "SOL" });
  expect(f.lighter.requests).toHaveLength(0);
  expect(engine.state("SOL").dustBase).toBe(-fill.size);
  f.clock.advance(Math.max(f.config.risk.maxUnhedgedAgeMs, 30000) + 1);
  f.feeds.fresh();
  await engine.reconcileAll();
  await engine.tick();
  expect(engine.breaker.state.latched).toBe(false);
  expect(f.af.orders.length).toBeGreaterThan(0);
  expect(f.lighter.requests).toHaveLength(0);
  expect(engine.state("SOL").unhedgedSince).toBeNull();
  const status = await engine.status();
  expect(status.positions[0]).toMatchObject({
    unhedged: "-40000000",
    hedgeable: "0",
    dust: "-40000000",
    netDelta: "-40000000",
  });
  expect(events.filter((e) => e.type === "market_status").at(-1)).toMatchObject(
    {
      unhedged: "-40000000",
      hedgeable: "0",
      dust: "-40000000",
      status: "quoting",
    },
  );
  expect(
    f.store.get<{ positions: { dust: bigint }[] }>("status_snapshot")
      ?.positions[0]?.dust,
  ).toBe(-fill.size);
  // The next partial fill raises the accumulated exposure above the $10 minimum.
  f.config.risk.maxUnhedgedUsd = 100;
  await engine.onFill(f.af.fill(70000000n));
  expect(f.lighter.requests).toHaveLength(1);
  expect(f.lighter.requests[0]?.intent.size).toBe(110000000n);
  expect(engine.state("SOL").unhedgedBase).toBe(0n);
  expect(engine.state("SOL").dustBase).toBe(0n);
  expect(engine.breaker.state.latched).toBe(false);
  await engine.shutdown();
  f.store.close();
});

test("hedgeable AF exposure still trips the USD cap and hedges", async () => {
  const f = fixture();
  f.config.risk.maxUnhedgedUsd = 1;
  await f.engine.start(false);
  await f.engine.tick();
  await f.engine.onFill(f.af.fill(110000000n));
  expect(f.engine.breaker.state.latched).toBe(true);
  expect(f.alerts.some((a) => a.reason === "max_unhedged_usd")).toBe(true);
  expect(f.lighter.requests).toHaveLength(1);
  expect(f.engine.state("SOL").unhedgedBase).toBe(0n);
  f.store.close();
});

test("AF quote sizes use the joint step when venue lots differ", async () => {
  const f = fixture();
  const markets = resolveMarkets(
    [required(f.markets[0]).config],
    [{ ...afMarket(), lotInt: 300000n }],
    [lighterMarket()],
  );
  f.feeds.view("SOL").af = required(markets[0]).af;
  const engine = new Engine({ ...f.options, markets });
  await engine.start(false);
  await engine.tick();
  const jointStep = required(markets[0]).jointStep;
  expect(jointStep).toBe(3000000n);
  expect(f.af.orders.length).toBeGreaterThan(0);
  for (const order of f.af.orders) expect(order.size % jointStep).toBe(0n);
  // A residual smaller than one joint step is retained in venue net truth.
  f.af.base = jointStep - 1n;
  await engine.handle({ type: "position", market: "SOL" });
  f.clock.advance(f.config.risk.reconcileQuiescenceMs);
  await engine.reconcileAll();
  expect(f.lighter.requests).toHaveLength(0);
  expect(engine.state("SOL").dustBase).toBe(jointStep - 1n);
  expect(engine.state("SOL").unhedgedBase).toBe(jointStep - 1n);
  await engine.shutdown();
  f.store.close();
});

test("startup upgrades persisted hedger state and clears legacy dust age", async () => {
  const f = fixture();
  f.af.base = 40000000n;
  const legacy = {
    ...f.engine.state("SOL"),
    unhedgedBase: f.af.base,
    unhedgedSince: 1,
  };
  Reflect.deleteProperty(legacy, "hedgeableBase");
  Reflect.deleteProperty(legacy, "dustBase");
  f.store.set("hedger:SOL", legacy);
  const engine = new Engine(f.options);
  await engine.start(false);
  await engine.tick();
  expect(engine.state("SOL").hedgeableBase).toBe(0n);
  expect(engine.state("SOL").dustBase).toBe(f.af.base);
  expect(engine.state("SOL").unhedgedSince).toBeNull();
  expect(engine.breaker.state.latched).toBe(false);
  expect(f.lighter.requests).toHaveLength(0);
  await engine.shutdown();
  f.store.close();
});
