import { expect, test } from "bun:test";
import {
  AfUpdates,
  type Socket,
  type Subscription,
} from "../../../src/venues/aftermath/ws";
import { fixture } from "./helpers";

class FakeSocket implements Socket {
  onopen: Socket["onopen"] = null;
  onmessage: Socket["onmessage"] = null;
  onclose: Socket["onclose"] = null;
  onerror: Socket["onerror"] = null;
  sent: string[] = [];
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.onclose?.(new CloseEvent("close"));
  }
  open() {
    this.onopen?.(new Event("open"));
  }
  message(payload: unknown) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(payload) }),
    );
  }
  text(s: string) {
    this.onmessage?.(new MessageEvent("message", { data: s }));
  }
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 2));
function harness(
  snapshot: (subscription: Subscription) => Promise<unknown>,
  extra: Partial<ConstructorParameters<typeof AfUpdates>[0]> = {},
) {
  const sockets: FakeSocket[] = [];
  const ws = new AfUpdates({
    baseUrl: "https://aftermath.finance",
    snapshot,
    reconnectBaseMs: 1,
    random: () => 0.5,
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    ...extra,
  });
  ws.subscribe({ orderbook: { marketId: "market" } });
  return { ws, sockets };
}
test("WS derives URL and bigint subscriptions", async () => {
  const { ws, sockets } = harness(async () => ({}));
  ws.subscribe({ user: { accountId: 7n } });
  ws.subscribe({ userOrders: { accountId: 7n } });
  expect(ws.url).toBe("wss://aftermath.finance/api/perpetuals/ws/updates");
  ws.start();
  sockets[0]?.open();
  await flush();
  expect(sockets[0]?.sent).toContain(
    '{"action":"subscribe","subscriptionType":{"user":{"accountId":"7n"}}}',
  );
  ws.stop();
});
test("reconnect resubscribes and snapshots before buffered deltas", async () => {
  const releases: (() => void)[] = [];
  const seen: string[] = [];
  const { ws, sockets } = harness(async () => {
    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    return { fresh: true };
  });
  ws.on("snapshot", () => seen.push("snapshot"));
  ws.on("orderbook", () => seen.push("delta"));
  ws.start();
  sockets[0]?.open();
  sockets[0]?.message({
    orderbook: { marketId: "market", orderbookDeltas: { nonce: "1n" } },
  });
  expect(seen).toEqual([]);
  releases[0]?.();
  await flush();
  expect(seen).toEqual(["snapshot", "delta"]);
  sockets[0]?.close();
  await flush();
  expect(sockets).toHaveLength(2);
  sockets[1]?.open();
  expect(sockets[1]?.sent).toEqual(sockets[0]?.sent ?? []);
  sockets[1]?.message({
    orderbook: { marketId: "market", orderbookDeltas: { nonce: "2n" } },
  });
  expect(seen).toHaveLength(2);
  releases[1]?.();
  await flush();
  expect(seen).toEqual(["snapshot", "delta", "snapshot", "delta"]);
  ws.stop();
});
test("snapshot failure never releases queued deltas", async () => {
  const { ws, sockets } = harness(async () => {
    throw new Error("REST down");
  });
  let count = 0;
  const errors: string[] = [];
  ws.on("orderbook", () => count++);
  ws.on("error", (e) => errors.push(e.message));
  ws.start();
  sockets[0]?.open();
  sockets[0]?.message({ orderbook: { marketId: "market" } });
  await flush();
  expect(count).toBe(0);
  expect(errors).toContain("REST down");
  ws.stop();
});
test("watchdog emits stale once per quiet period and recovers on data", async () => {
  let now = 0;
  let stale = 0;
  const { ws, sockets } = harness(async () => ({}), {
    now: () => now,
    staleMs: 5000,
  });
  ws.on("stale", () => stale++);
  ws.start();
  sockets[0]?.open();
  await flush();
  now = 5000;
  ws.checkStaleness();
  ws.checkStaleness();
  expect(stale).toBe(1);
  sockets[0]?.message({
    orderbook: { marketId: "market", orderbookDeltas: { nonce: "1n" } },
  });
  now = 10001;
  ws.checkStaleness();
  expect(stale).toBe(2);
  ws.stop();
});
test("late snapshot completion and old socket messages cannot leak after stop", async () => {
  let release!: () => void;
  const { ws, sockets } = harness(async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return {};
  });
  let events = 0;
  ws.on("snapshot", () => events++);
  ws.on("orderbook", () => events++);
  ws.start();
  sockets[0]?.open();
  ws.stop();
  release();
  sockets[0]?.message({ orderbook: { marketId: "market" } });
  await flush();
  expect(events).toBe(0);
  expect(sockets).toHaveLength(1);
});
test("live acknowledgments are tolerated and recorded public shapes revive bigint", async () => {
  const { frames } = (await fixture("ws-public")) as {
    frames: { message: Record<string, unknown> }[];
  };
  const { ws, sockets } = harness(async () => ({}));
  const seen: string[] = [];
  let errors = 0;
  for (const key of ["market", "oracle", "orderbook"] as const)
    ws.on(key, () => seen.push(key));
  ws.on("error", () => errors++);
  const marketId = (
    frames.find((f) => f.message.oracle)?.message.oracle as { marketId: string }
  ).marketId;
  ws.subscribe({ orderbook: { marketId } });
  ws.subscribe({ market: { marketId } });
  ws.subscribe({ oracle: { marketId } });
  ws.start();
  sockets[0]?.open();
  await flush();
  sockets[0]?.text("Subscription successful");
  for (const key of ["market", "oracle", "orderbook"]) {
    const frame = frames.find((f) => f.message[key]);
    if (!frame) throw new Error(`Missing ${key}`);
    sockets[0]?.text(
      JSON.stringify(frame.message, (_, v) =>
        typeof v === "bigint" ? `${v}n` : v,
      ),
    );
  }
  expect(seen).toEqual(["market", "oracle", "orderbook"]);
  expect(errors).toBe(0);
  ws.stop();
});
test("bounded snapshot buffering closes transport rather than applying unknown state", async () => {
  const { ws, sockets } = harness(async () => new Promise(() => {}), {
    maxBufferedMessages: 1,
  });
  let errors = 0;
  let updates = 0;
  ws.on("error", () => errors++);
  ws.on("orderbook", () => updates++);
  ws.start();
  sockets[0]?.open();
  sockets[0]?.message({ orderbook: { marketId: "market" } });
  sockets[0]?.message({ orderbook: { marketId: "market" } });
  expect(errors).toBe(1);
  expect(updates).toBe(0);
  ws.stop();
});

test("snapshot nonce discards pre-snapshot deltas and detects gaps", async () => {
  const { ws, sockets } = harness(async () => ({
    marketId: "market",
    orderbook: { nonce: 5n },
  }));
  const seen: bigint[] = [];
  let gaps = 0;
  ws.on("orderbook", (d) => seen.push(d.orderbookDeltas.nonce));
  ws.on("resync", () => {
    gaps++;
  });
  ws.start();
  sockets[0]?.open();
  sockets[0]?.message({
    orderbook: { marketId: "market", orderbookDeltas: { nonce: "4n" } },
  });
  sockets[0]?.message({
    orderbook: { marketId: "market", orderbookDeltas: { nonce: "6n" } },
  });
  await flush();
  expect(seen).toEqual([6n]);
  sockets[0]?.message({
    orderbook: { marketId: "market", orderbookDeltas: { nonce: "6n" } },
  });
  sockets[0]?.message({
    orderbook: { marketId: "market", orderbookDeltas: { nonce: "8n" } },
  });
  expect(seen).toEqual([6n]);
  expect(gaps).toBe(1);
  ws.stop();
});
test("user WS wraps the account; pendingOrders retain clientOrderId", async () => {
  const { ws, sockets } = harness(async () => ({}));
  ws.subscribe({ user: { accountId: 7n } });
  ws.subscribe({ userOrders: { accountId: 7n } });
  let userId: bigint | undefined;
  let clientId: bigint | null | undefined;
  let fills = 0;
  ws.on("user", (u) => {
    userId = u.account.accountId;
    clientId = u.account.positions[0]?.pendingOrders[0]?.clientOrderId;
  });
  ws.on("userOrders", (u) => {
    fills += u.orders.length;
  });
  ws.start();
  sockets[0]?.open();
  await flush();
  sockets[0]?.message({
    user: {
      account: {
        accountId: "7n",
        positions: [
          {
            marketId: "market",
            baseAssetAmount: 0,
            pendingOrders: [{ clientOrderId: "10n" }],
          },
        ],
      },
      stopOrders: null,
      twapOrders: null,
    },
  });
  sockets[0]?.message({
    userOrders: {
      accountId: "7n",
      orders: [{ eventType: "FilledTakerOrder", size: 0.1, price: 1 }],
    },
  });
  expect(userId).toBe(7n);
  expect(clientId).toBe(10n);
  expect(fills).toBe(1);
  ws.stop();
});
test("unsubscribe suppresses queued and late frames", async () => {
  const { ws, sockets } = harness(async () => ({}));
  let updates = 0;
  ws.on("orderbook", () => updates++);
  ws.start();
  sockets[0]?.open();
  await flush();
  ws.unsubscribe({ orderbook: { marketId: "market" } });
  sockets[0]?.message({
    orderbook: { marketId: "market", orderbookDeltas: { nonce: "1n" } },
  });
  expect(updates).toBe(0);
  expect(sockets[0]?.sent.at(-1)).toContain('"unsubscribe"');
  ws.stop();
});

test("bucketed topOfOrderbook uses its published flat payload", async () => {
  const { ws, sockets } = harness(async () => ({}));
  ws.subscribe({
    topOfOrderbook: {
      marketId: "market",
      priceBucketSize: 1,
      bucketsNumber: 5,
    },
  });
  let price: number | undefined;
  ws.on("topOfOrderbook", (b) => {
    price = b.asks[0]?.price;
  });
  ws.start();
  sockets[0]?.open();
  await flush();
  sockets[0]?.message({
    topOfOrderbook: {
      marketId: "market",
      asks: [
        { price: 100, size: 1, totalSize: 1, sizeUsd: 100, totalSizeUsd: 100 },
      ],
      bids: [],
      minAskPrice: 100,
      maxBidPrice: null,
    },
  });
  expect(price).toBe(100);
  ws.stop();
});

test("REST recovery helper chooses each stream's endpoint and rejects missing targets", async () => {
  const { restSnapshot } = await import("../../../src/venues/aftermath/ws");
  const { AfMarkets } = await import("../../../src/venues/aftermath/markets");
  const { AfAccount } = await import("../../../src/venues/aftermath/account");
  const { AfHttp, stringifyAf } = await import(
    "../../../src/venues/aftermath/http"
  );
  const paths: string[] = [];
  const http = new AfHttp({
    fetch: (async (url: string | URL | Request) => {
      const path = String(url).split("/api/perpetuals/")[1];
      paths.push(path ?? "");
      if (path === "accounts/positions") return Response.json({ accounts: [] });
      if (path?.includes("order-history"))
        return Response.json({ trades: [], nextBeforeTimestampCursor: null });
      const name =
        path === "markets"
          ? "markets"
          : path === "markets/prices"
            ? "prices"
            : "orderbooks";
      return new Response(stringifyAf(await fixture(name)));
    }) as unknown as typeof fetch,
  });
  const snapshot = restSnapshot(new AfMarkets(http), new AfAccount(http));
  await snapshot({ orderbook: { marketId: "m" } });
  await snapshot({
    topOfOrderbook: { marketId: "m", priceBucketSize: 1, bucketsNumber: 5 },
  });
  await snapshot({ market: { marketId: "m" } });
  await snapshot({ oracle: { marketId: "m" } });
  await expect(snapshot({ user: { accountId: 7n } })).rejects.toThrow(
    "missing subscription",
  );
  await snapshot({ userOrders: { accountId: 7n } });
  expect(paths).toEqual([
    "markets/orderbooks",
    "markets/orderbooks",
    "markets",
    "markets/prices",
    "accounts/positions",
    "account/order-history-detailed",
  ]);
});

test("lagging REST snapshot catches up on the same socket before more deltas", async () => {
  let snapshots = 0;
  const { ws, sockets } = harness(async () => ({
    marketId: "market",
    orderbook: { nonce: ++snapshots === 1 ? 5n : 8n },
  }));
  const seen: bigint[] = [];
  let recoveries = 0;
  let errors = 0;
  ws.on("orderbook", (d) => seen.push(d.orderbookDeltas.nonce));
  ws.on("resync", () => recoveries++);
  ws.on("error", () => errors++);
  ws.start();
  sockets[0]?.open();
  await flush();
  sockets[0]?.message({
    orderbook: { marketId: "market", orderbookDeltas: { nonce: "8n" } },
  });
  sockets[0]?.message({
    orderbook: { marketId: "market", orderbookDeltas: { nonce: "9n" } },
  });
  expect(seen).toEqual([]);
  await flush();
  expect(seen).toEqual([9n]);
  expect(snapshots).toBe(2);
  expect(recoveries).toBe(1);
  expect(errors).toBe(0);
  expect(sockets).toHaveLength(1);
  ws.stop();
});

test("persistent nonce gaps stop releasing deltas after bounded resnapshots", async () => {
  const { ws, sockets } = harness(async () => ({
    marketId: "market",
    orderbook: { nonce: 5n },
  }));
  let errors = 0;
  let updates = 0;
  ws.on("error", (e) => {
    if (e.message.includes("persists")) errors++;
  });
  ws.on("orderbook", () => updates++);
  ws.start();
  sockets[0]?.open();
  await flush();
  sockets[0]?.message({
    orderbook: { marketId: "market", orderbookDeltas: { nonce: "8n" } },
  });
  await flush();
  expect(errors).toBe(1);
  expect(updates).toBe(0);
  ws.stop();
});
test("REST snapshot cannot roll back an applied orderbook nonce", async () => {
  let calls = 0;
  const { ws, sockets } = harness(async () => ({
    marketId: "market",
    orderbook: { nonce: ++calls === 1 ? 5n : 4n },
  }));
  let snapshots = 0;
  const errors: string[] = [];
  ws.on("snapshot", () => snapshots++);
  ws.on("error", (e) => errors.push(e.message));
  ws.start();
  sockets[0]?.open();
  await flush();
  sockets[0]?.message({
    orderbook: { marketId: "market", orderbookDeltas: { nonce: "6n" } },
  });
  sockets[0]?.message({
    orderbook: { marketId: "market", orderbookDeltas: { nonce: "8n" } },
  });
  await flush();
  expect(snapshots).toBe(1);
  expect(errors).toContain("REST snapshot nonce went backwards");
  ws.stop();
});
