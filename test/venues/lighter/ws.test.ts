import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { Book } from "../../../src/venues/lighter/ws";
import { AuthTokens, LighterWs } from "../../../src/venues/lighter/ws";
import { FakeClock, FakeSocket } from "./helpers";

const bookFrame = (
  type: string,
  nonce: number,
  begin: number,
  asks: unknown[] = [],
) => ({
  type,
  channel: "order_book:1",
  order_book: { nonce, begin_nonce: begin, asks, bids: [] },
});
function setup(options: { auth?: AuthTokens; staleMs?: number } = {}) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const ws = new LighterWs({
    ...options,
    clock,
    random: () => 0.5,
    socket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  ws.subscribeBook(1);
  ws.start();
  const socket = sockets[0];
  if (!socket) throw new Error("missing socket");
  socket.open();
  return { ws, socket, clock, sockets };
}
describe("Lighter WS", () => {
  test("snapshot then deltas update/delete levels", () => {
    const { ws, socket } = setup();
    const books: Book[] = [];
    ws.on("book", (b) => books.push(b));
    socket.frame(
      bookFrame("subscribed/order_book", 10, 0, [{ price: "100", size: "1" }]),
    );
    socket.frame(
      bookFrame("update/order_book", 12, 10, [
        { price: "100", size: "0" },
        { price: "101", size: "2" },
      ]),
    );
    expect(books.at(-1)?.asks.get("101")).toBe("2");
    expect(books.at(-1)?.asks.has("100")).toBe(false);
    expect(books[0]?.asks.get("100")).toBe("1");
    ws.stop();
  });
  test("gap invalidates book and requests a new snapshot", () => {
    const { ws, socket } = setup();
    let books = 0;
    let stale = "";
    ws.on("book", () => books++);
    ws.on("stale", (e) => {
      stale = e.reason;
    });
    socket.frame(bookFrame("subscribed/order_book", 10, 0));
    socket.frame(bookFrame("update/order_book", 12, 11));
    expect(stale).toBe("gap");
    expect(books).toBe(1);
    expect(socket.sent.at(-2)?.type).toBe("unsubscribe");
    expect(socket.sent.at(-1)?.type).toBe("subscribe");
    socket.frame(bookFrame("subscribed/order_book", 20, 0));
    socket.frame(bookFrame("update/order_book", 21, 20));
    expect(books).toBe(3);
    ws.stop();
  });
  test("deltas before a snapshot never publish a book", () => {
    const { ws, socket } = setup();
    let books = 0;
    ws.on("book", () => books++);
    socket.frame(bookFrame("update/order_book", 1, 0));
    expect(books).toBe(0);
    expect(socket.sent.at(-1)?.type).toBe("subscribe");
    ws.stop();
  });
  test("reconnect with backoff resubscribes without old book state", () => {
    const { ws, socket, clock, sockets } = setup();
    socket.frame(bookFrame("subscribed/order_book", 10, 0));
    socket.close();
    clock.advance(499);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets).toHaveLength(2);
    const next = sockets[1];
    next?.open();
    expect(next?.sent[0]?.channel).toBe("order_book/1");
    ws.stop();
  });
  test("ping within 60s and respond to server ping", () => {
    const { ws, socket, clock } = setup({ staleMs: 100000 });
    clock.advance(50000);
    expect(socket.sent.at(-1)?.type).toBe("ping");
    socket.frame({ type: "ping" });
    expect(socket.sent.at(-1)?.type).toBe("pong");
    ws.stop();
  });
  test("watchdog emits stale once until snapshot recovery", () => {
    const { ws, socket, clock } = setup({ staleMs: 2000 });
    let count = 0;
    ws.on("stale", (e) => {
      if (e.reason === "timeout") count++;
    });
    socket.frame(bookFrame("subscribed/order_book", 10, 0));
    clock.advance(5000);
    expect(count).toBe(1);
    socket.frame(bookFrame("subscribed/order_book", 11, 0));
    clock.advance(2000);
    expect(count).toBe(2);
    ws.stop();
  });
  test("private channels require auth", () => {
    const ws = new LighterWs();
    expect(() => ws.subscribeAccountTx(1n)).toThrow("authentication");
  });
  test("tokens refresh five minutes before expiry and resubscribe private only", () => {
    const clock = new FakeClock();
    let tokens = 0;
    const auth = new AuthTokens(
      { CreateAuthToken: () => ({ authToken: `token-${++tokens}` }) },
      1n,
      4,
      clock,
      3600000,
      300000,
    );
    const socket = new FakeSocket();
    const ws = new LighterWs({
      clock,
      auth,
      staleMs: 1e9,
      idleTimeoutMs: 1e9,
      socket: () => socket,
    });
    ws.subscribeBook(1);
    ws.subscribeAccount(1n);
    ws.subscribeAccountTx(1n);
    ws.subscribeAccountOrders(1n, 1);
    ws.subscribeAccountOrders(1n);
    ws.start();
    socket.open();
    expect(tokens).toBe(1);
    clock.advance(3299000);
    expect(tokens).toBe(1);
    clock.advance(1000);
    expect(tokens).toBe(2);
    const subs = socket.sent.filter((s) => s.type === "subscribe");
    expect(subs.filter((s) => s.auth === "token-2")).toHaveLength(4);
    expect(subs.filter((s) => s.channel === "order_book/1")).toHaveLength(1);
    ws.stop();
  });
  test("auth token TTL cannot exceed 8h", () => {
    expect(
      () =>
        new AuthTokens(
          { CreateAuthToken: () => ({ authToken: "t" }) },
          1n,
          4,
          new FakeClock(),
          9 * 3600000,
        ),
    ).toThrow("timing");
  });
  test("market_stats/all emits each market", () => {
    const { ws, socket } = setup();
    ws.subscribeMarketStats("all");
    const rates: string[] = [];
    ws.on("marketStats", (s) => rates.push(s.currentFundingRate ?? ""));
    socket.frame({
      type: "update/market_stats",
      channel: "market_stats:all",
      market_stats: {
        1: { market_id: 1, symbol: "BTC", current_funding_rate: "0.0012" },
        2: { market_id: 2, symbol: "BRENT", current_funding_rate: "-0.0477" },
      },
    });
    expect(rates).toEqual(["0.0012", "-0.0477"]);
    ws.stop();
  });
  test("private order IDs remain bigint and account_orders channel is normalized", () => {
    const socket = new FakeSocket();
    const ws = new LighterWs({
      auth: { get: () => ({ token: "t", expiresAt: 1e15 }) },
      socket: () => socket,
    });
    ws.subscribeAccountOrders(1n, 1);
    ws.start();
    socket.open();
    let id = 0n;
    ws.on("orders", (e) => {
      expect(e.channel).toBe("account_orders/1/1");
      id = e.orders[0]?.orderIndex ?? 0n;
    });
    socket.frame({
      type: "update/account_orders",
      channel: "account_orders:1",
      account: 1,
      orders: {
        1: [
          {
            market_index: 1,
            order_id: "9007199254740993999",
            client_order_index: 123,
            status: "filled",
            filled_base_amount: "1",
            filled_quote_amount: "2",
          },
        ],
      },
    });
    expect(id).toBe(9007199254740993999n);
    ws.stop();
  });
  test("recorded 30s public stream replays with continuous books", async () => {
    const { ws, socket } = setup({ staleMs: 100000 });
    ws.subscribeMarketStats("all");
    let books = 0;
    let gaps = 0;
    let stats = 0;
    ws.on("book", () => books++);
    ws.on("stale", (e) => {
      if (e.reason === "gap") gaps++;
    });
    ws.on("marketStats", () => stats++);
    const lines = (
      await readFile(
        new URL("../../fixtures/lighter/public-stream.ndjson", import.meta.url),
        "utf8",
      )
    )
      .trim()
      .split("\n");
    for (const line of lines) socket.onmessage?.({ data: line });
    expect(books).toBeGreaterThan(100);
    expect(gaps).toBe(0);
    expect(stats).toBeGreaterThan(100);
    ws.stop();
  });
});

test("deltas during gap recovery do not flood resubscriptions", () => {
  const { ws, socket } = setup();
  socket.frame(bookFrame("subscribed/order_book", 10, 0));
  socket.frame(bookFrame("update/order_book", 12, 11));
  const count = socket.sent.length;
  for (let i = 0; i < 10; i++)
    socket.frame(bookFrame("update/order_book", 20 + i, 19 + i));
  expect(socket.sent.length).toBe(count);
  ws.stop();
});
test("malformed delta closes connection and invalidates old state", () => {
  const { ws, socket } = setup();
  let stale = false;
  let faults = 0;
  ws.on("stale", () => {
    stale = true;
  });
  ws.on("fault", () => faults++);
  socket.frame(bookFrame("subscribed/order_book", 10, 0));
  socket.frame(
    bookFrame("update/order_book", 11, 10, [
      { price: "1", size: "1" },
      { price: "bad", size: "1" },
    ]),
  );
  expect(socket.readyState).toBe(3);
  expect(stale).toBe(true);
  expect(faults).toBe(1);
  ws.stop();
});
test("connection setup timeout reconnects", () => {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const ws = new LighterWs({
    clock,
    connectTimeoutMs: 1000,
    random: () => 0.5,
    socket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  ws.start();
  clock.advance(1500);
  expect(sockets).toHaveLength(2);
  ws.stop();
});
test("quiet dead connection reconnects despite successful local ping writes", () => {
  const { ws, socket, clock } = setup({ staleMs: 1e9 });
  clock.advance(120000);
  expect(socket.readyState).toBe(3);
  ws.stop();
});
test("old socket messages after close cannot publish a snapshot", () => {
  const { ws, socket } = setup();
  let books = 0;
  ws.on("book", () => books++);
  socket.close();
  socket.frame(bookFrame("subscribed/order_book", 10, 0));
  expect(books).toBe(0);
  ws.stop();
});
