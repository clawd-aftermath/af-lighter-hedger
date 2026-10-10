import { expect, test } from "bun:test";
import { runtimeConfigSchema } from "../../src/config/schema";
import { Logger } from "../../src/core/logger";
import { Engine, SafetyRefusal } from "../../src/engine/engine";
import { configInput } from "../fixtures/config";
import { fixture, required } from "./helpers";

function setup() {
  const f = fixture();
  const events: Record<string, unknown>[] = [];
  f.config.mode = "live";
  const engine = new Engine({
    ...f.options,
    mode: "live",
    logger: new Logger({ write: (line) => events.push(JSON.parse(line)) }),
  });
  return { ...f, engine, events };
}

async function settle(f: ReturnType<typeof setup>) {
  f.clock.advance(f.config.risk.reconcileQuiescenceMs);
  f.feeds.fresh();
  await f.engine.reconcileAll();
  await f.engine.tick();
  expect(f.af.base + f.lighter.base).toBe(0n);
  expect(f.engine.state("SOL").unhedgedBase).toBe(0n);
  expect(f.store.intents(true)).toHaveLength(0);
}

function fillDuringHedge(f: ReturnType<typeof setup>) {
  const hedge = f.lighter.hedge.bind(f.lighter);
  let fill: ReturnType<typeof f.af.fill> | undefined;
  f.lighter.hedge = async (request, context) => {
    // The intent is already active; execute another AF fill before the unknown
    // response causes quote cancellation, then deliver its event separately.
    fill = f.af.fill(200000000n);
    f.lighter.hedge = hedge;
    return hedge(request, context);
  };
  return () => required(fill);
}

test("race A: position then fill sends exactly one hedge without a counter-hedge", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  // Expire startup quiescence so the position event itself must protect us.
  f.clock.advance(f.config.risk.reconcileQuiescenceMs);
  f.feeds.fresh();
  const fill = f.af.fill(200000000n);
  await f.engine.handle({ type: "position", market: "SOL" });
  await f.engine.reconcileAll();
  expect(f.lighter.requests).toHaveLength(0);
  expect(f.engine.state("SOL").unhedgedBase).toBe(0n);
  expect(f.events.at(-1)).toMatchObject({
    type: "reconcile",
    action: "deferred",
    reason: "af_activity",
  });
  f.lighter.timeout = true;
  await f.engine.handle({ type: "fill", fill });
  expect(f.engine.state("SOL").active?.status).toBe("unknown");
  expect(f.lighter.requests.map((r) => r.intent.size)).toEqual([fill.size]);
  f.lighter.resolvable = true;
  await f.engine.reconcileAll();
  await settle(f);
  expect(f.lighter.requests).toHaveLength(1);
  f.store.close();
});

test("race B: fill hedges immediately while the AF position read excludes it", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  const fill = f.af.fill(200000000n);
  const updatedBase = f.af.base;
  f.af.base = 0n;
  const reads = f.af.checks;
  const now = f.clock.now();
  await f.engine.onFill(fill);
  expect(f.clock.now()).toBe(now);
  expect(f.af.checks).toBe(reads);
  expect(f.lighter.requests.map((r) => r.intent.size)).toEqual([fill.size]);
  expect(f.engine.state("SOL").unhedgedBase).toBe(0n);
  // An actual account read still excludes the fill, without changing the ledger.
  expect((await f.engine.status()).positions[0]?.netDelta).toBe(
    String(fill.size),
  );
  expect(f.engine.state("SOL").unhedgedBase).toBe(0n);
  await f.engine.reconcileAll();
  expect(f.lighter.requests).toHaveLength(1);
  f.af.base = updatedBase;
  await f.engine.handle({ type: "position", market: "SOL" });
  await settle(f);
  expect(f.lighter.requests).toHaveLength(1);
  expect(f.events.some((e) => e.reason === "fill_account_unknown")).toBe(false);
  f.store.close();
});

test("race C: lost fill waits for configured position quiescence, then hedges once", async () => {
  const f = setup();
  f.config.risk.reconcileQuiescenceMs = 4500;
  await f.engine.start(false);
  await f.engine.tick();
  f.clock.advance(f.config.risk.reconcileQuiescenceMs);
  f.feeds.fresh();
  const lostFill = f.af.fill(200000000n);
  await f.engine.handle({ type: "position", market: "SOL" });
  await f.engine.tick();
  expect(f.lighter.requests).toHaveLength(0);
  f.clock.advance(f.config.risk.reconcileQuiescenceMs - 1);
  await f.engine.reconcileAll();
  expect(f.lighter.requests).toHaveLength(0);
  f.clock.advance(1);
  f.feeds.fresh();
  await f.engine.reconcileAll();
  expect(f.lighter.requests.map((r) => r.intent.size)).toEqual([lostFill.size]);
  expect(f.store.fills()).toHaveLength(0);
  await settle(f);
  expect(f.lighter.requests).toHaveLength(1);
  f.store.close();
});

test("race D: duplicate fill replay after reconnect never sends an extra hedge", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  const fill = f.af.fill(200000000n);
  await f.engine.onFill(fill);
  await f.engine.handle({ type: "reconnect", venue: "af" });
  await f.engine.handle({ type: "fill", fill });
  await settle(f);
  expect(f.lighter.requests.map((r) => r.intent.size)).toEqual([fill.size]);
  expect(f.store.fills()).toHaveLength(1);
  f.store.close();
});

test("race E: fill during an active hedge produces exactly two hedges for the sum", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  const first = f.af.fill(200000000n);
  const nextFill = fillDuringHedge(f);
  f.lighter.timeout = true;
  await f.engine.onFill(first);
  expect(f.engine.state("SOL").active?.status).toBe("unknown");
  const second = nextFill();
  await f.engine.handle({ type: "position", market: "SOL" });
  await f.engine.onFill(second);
  expect(f.lighter.requests).toHaveLength(1);
  expect(f.engine.state("SOL").unhedgedBase).toBe(-first.size - second.size);
  f.clock.advance(f.config.risk.reconcileQuiescenceMs);
  await f.engine.reconcileAll();
  expect(f.lighter.requests).toHaveLength(1);
  expect(f.events.at(-1)).toMatchObject({
    type: "reconcile",
    action: "deferred",
    reason: "active_hedge",
  });
  f.lighter.timeout = false;
  f.lighter.resolvable = true;
  await f.engine.reconcileAll();
  await settle(f);
  expect(f.lighter.requests.map((r) => r.intent.size)).toEqual([
    first.size,
    second.size,
  ]);
  expect(f.lighter.base).toBe(first.size + second.size);
  f.store.close();
});

test("race: unchanged position events preserve quiescence and periodic reconciliation recovers a lost fill", async () => {
  const f = setup();
  f.config.risk.reconcileQuiescenceMs = 6000;
  await f.engine.start(true);
  await f.engine.tick();
  const fill = f.af.fill(200000000n);
  await f.engine.handle({ type: "position", market: "SOL" });
  f.clock.advance(5000);
  f.feeds.fresh();
  await f.engine.idle();
  // Drain scheduler completion callbacks before advancing the injected clock.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.lighter.requests).toHaveLength(0);
  await f.engine.handle({ type: "position", market: "SOL" });
  f.clock.advance(5000);
  f.feeds.fresh();
  await f.engine.idle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.lighter.requests).toHaveLength(1);
  f.clock.advance(5000);
  f.feeds.fresh();
  await f.engine.idle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.lighter.requests.map((r) => r.intent.size)).toEqual([fill.size]);
  expect(f.af.base + f.lighter.base).toBe(0n);
  await f.engine.shutdown();
  f.store.close();
});

test("race: a position event received during a reconciliation read defers its hedge", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  const fill = f.af.fill(200000000n);
  f.clock.advance(f.config.risk.reconcileQuiescenceMs);
  f.feeds.fresh();
  const position = f.af.position.bind(f.af);
  let notification: Promise<void> | undefined;
  f.af.position = async (symbol) => {
    f.af.position = position;
    notification = f.engine.handle({ type: "position", market: symbol });
    return position(symbol);
  };
  await f.engine.reconcileAll();
  await notification;
  expect(f.lighter.requests).toHaveLength(0);
  await f.engine.onFill(fill);
  await settle(f);
  expect(f.lighter.requests).toHaveLength(1);
  f.store.close();
});

for (const unavailable of [false, true])
  test(`race: fill hedges with ${unavailable ? "unavailable" : "stale"} position reads`, async () => {
    const f = setup();
    await f.engine.start(false);
    await f.engine.tick();
    const fill = f.af.fill(200000000n);
    f.af.fresh = f.lighter.fresh = false;
    if (unavailable)
      f.af.position = async () => {
        throw new Error("account read unavailable");
      };
    await f.engine.onFill(fill);
    expect(f.lighter.requests.map((r) => r.intent.size)).toEqual([fill.size]);
    expect(f.store.fills()).toHaveLength(1);
    expect(f.engine.state("SOL").unhedgedBase).toBe(0n);
    expect(f.alerts.some((a) => a.reason === "fill_account_unknown")).toBe(
      false,
    );
    f.store.close();
  });

test("race: fill persistence failure rolls back accounting and refuses a hedge", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  const fill = f.af.fill(200000000n);
  const cursor = f.store.cursor("lighter");
  const saveHedge = f.store.saveHedge.bind(f.store);
  f.store.saveHedge = () => {
    throw new Error("cannot persist hedge");
  };
  await f.engine.onFill(fill);
  expect(f.store.fills()).toHaveLength(0);
  expect(f.store.intents(true)).toHaveLength(0);
  expect(f.store.cursor("lighter")).toBe(cursor);
  expect(f.engine.state("SOL").unhedgedBase).toBe(0n);
  expect(f.engine.state("SOL").active).toBeNull();
  expect(f.lighter.requests).toHaveLength(0);
  expect(f.alerts.some((a) => a.reason === "fill_account_unknown")).toBe(true);
  f.store.saveHedge = saveHedge;
  await f.engine.onFill(fill);
  expect(f.lighter.requests).toHaveLength(1);
  expect(f.af.base + f.lighter.base).toBe(0n);
  f.store.close();
});

test("race: reconnect confirmation accounts for an active hedge before the next fill", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  const first = f.af.fill(200000000n);
  const nextFill = fillDuringHedge(f);
  f.lighter.timeout = true;
  await f.engine.onFill(first);
  const second = nextFill();
  await f.engine.onFill(second);
  f.lighter.timeout = false;
  f.lighter.resolvable = true;
  await f.engine.handle({ type: "reconnect", venue: "af" });
  await settle(f);
  expect(f.lighter.requests.map((r) => r.intent.size)).toEqual([
    first.size,
    second.size,
  ]);
  f.store.close();
});

test("race: startup confirmation applies a persisted active hedge before ticks resume", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  const first = f.af.fill(200000000n);
  const nextFill = fillDuringHedge(f);
  f.lighter.timeout = true;
  await f.engine.onFill(first);
  const second = nextFill();
  await f.engine.onFill(second);
  f.lighter.timeout = false;
  f.lighter.resolvable = true;
  const restarted = new Engine(f.engine.options);
  await restarted.start(false);
  await restarted.onFill(first);
  await restarted.onFill(second);
  await settle({ ...f, engine: restarted });
  expect(f.lighter.requests.map((r) => r.intent.size)).toEqual([
    first.size,
    second.size,
  ]);
  await restarted.shutdown();
  f.store.close();
});

test("race: quiescent reconciliation defers an unknown AF intent", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  f.af.fill(200000000n);
  const intent = f.store.createIntent({
    venue: "af",
    kind: "quote",
    market: "SOL",
    clientId: "unknown",
    payload: {},
  });
  f.store.updateIntent(intent.id, "unknown", "unknown-digest");
  await f.engine.handle({ type: "position", market: "SOL" });
  f.clock.advance(f.config.risk.reconcileQuiescenceMs);
  await f.engine.reconcileAll();
  expect(f.lighter.requests).toHaveLength(0);
  expect(f.engine.state("SOL").unhedgedBase).toBe(0n);
  expect(f.events.at(-1)).toMatchObject({
    type: "reconcile",
    action: "deferred",
    reason: "pending_intent",
  });
  f.store.close();
});

test("race: a lost fill correction requires fresh AF positions", async () => {
  const f = setup();
  await f.engine.start(false);
  await f.engine.tick();
  const fill = f.af.fill(200000000n);
  await f.engine.handle({ type: "position", market: "SOL" });
  f.clock.advance(f.config.risk.reconcileQuiescenceMs);
  f.af.fresh = false;
  await expect(f.engine.reconcileAll()).rejects.toBeInstanceOf(SafetyRefusal);
  expect(f.lighter.requests).toHaveLength(0);
  expect(f.alerts.some((a) => a.reason === "stale_af")).toBe(true);
  f.af.fresh = true;
  await f.engine.reconcileAll();
  expect(f.lighter.requests.map((r) => r.intent.size)).toEqual([fill.size]);
  expect(f.af.base + f.lighter.base).toBe(0n);
  f.store.close();
});

test("race: lost fill correction rounds to the joint hedge step and retains dust", async () => {
  const f = setup();
  await f.engine.start(false);
  f.af.base = -200500000n;
  await f.engine.handle({ type: "position", market: "SOL" });
  f.clock.advance(f.config.risk.reconcileQuiescenceMs);
  await f.engine.reconcileAll();
  expect(f.lighter.requests.map((r) => r.intent.size)).toEqual([200000000n]);
  expect(f.af.base + f.lighter.base).toBe(-500000n);
  expect(f.engine.state("SOL").dustBase).toBe(-500000n);
  await f.engine.reconcileAll();
  expect(f.lighter.requests).toHaveLength(1);
  f.store.close();
});

test("reconcile quiescence config defaults to 3000 ms and validates overrides", () => {
  const f = fixture();
  expect(f.config.risk.reconcileQuiescenceMs).toBe(3000);
  const parse = (reconcileQuiescenceMs: number) =>
    runtimeConfigSchema.safeParse({
      ...configInput(f.config),
      risk: { ...f.config.risk, reconcileQuiescenceMs },
    });
  expect(parse(4500).success).toBe(true);
  for (const invalid of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(parse(invalid).success).toBe(false);
  f.store.close();
});
