import { describe, expect, test } from "bun:test";
import { NonceManager } from "../../../src/venues/lighter/nonce";
import type { HedgeRequest } from "../../../src/venues/lighter/orders";
import {
  HedgeOrders,
  HedgeUnconfirmed,
  prepareHedge,
} from "../../../src/venues/lighter/orders";
import type { LighterSigner } from "../../../src/venues/lighter/signer";
import type {
  Order,
  SendTxResult,
  Transaction,
} from "../../../src/venues/lighter/types";
import { LighterWs } from "../../../src/venues/lighter/ws";
import { FakeClock, flush, market, order } from "./helpers";

const request: HedgeRequest = {
  marketId: 1,
  side: "buy",
  baseAmount: "0.00123",
  refPrice: "82000.05",
  maxSlippageBps: 20,
  reduceOnly: false,
  clientOrderIndex: 123n,
};
let id = 0;
function setup(useWs = true) {
  const clock = new FakeClock();
  const ws = new LighterWs({
    auth: { get: () => ({ token: "test", expiresAt: 1e15 }) },
  });
  let next = 10n;
  let tx: Transaction | undefined;
  let orders: Order[] = [];
  let response: SendTxResult = { code: 200, txHash: "h" };
  let onSend: () => void = () => {};
  let restCalls = 0;
  const calls: (number | bigint)[][] = [];
  const signer: Pick<
    LighterSigner,
    "SignCreateOrder" | "SignCancelOrder" | "SignCancelAllOrders"
  > = {
    SignCreateOrder: (...args) => {
      calls.push(args);
      return { txType: 14, txInfo: "{}", txHash: "h" };
    },
    SignCancelOrder: (...args) => {
      calls.push(args);
      return { txType: 15, txInfo: "{}", txHash: "h" };
    },
    SignCancelAllOrders: (...args) => {
      calls.push(args);
      return { txType: 16, txInfo: "{}", txHash: "h" };
    },
  };
  const rest = {
    orderBookDetails: async () => [market],
    nextNonce: async () => next,
    tx: async () => tx,
    sendTx: async () => {
      onSend();
      return response;
    },
    accountOrders: async () => {
      restCalls++;
      return { items: orders };
    },
  };
  const nonce = new NonceManager(rest, 42n, 4, `orders-${id++}`);
  const service = new HedgeOrders({
    rest,
    signer,
    nonce,
    ws: useWs ? ws : undefined,
    clock,
    confirmationMs: 2000,
    restAttempts: 1,
  });
  return {
    service,
    clock,
    ws,
    calls,
    restCalls: () => restCalls,
    setTx: (value: Transaction | undefined) => {
      tx = value;
    },
    setNext: (n: bigint) => {
      next = n;
    },
    setOrders: (o: Order[]) => {
      orders = o;
    },
    setResponse: (r: SendTxResult) => {
      response = r;
    },
    onSend: (fn: () => void) => {
      onSend = fn;
    },
  };
}
describe("Lighter hedge orders", () => {
  test("buy worst price rounds down away from fill", () => {
    const p = prepareHedge(request, market);
    expect(p.worstPrice).toBe(821640n);
    expect(p.baseAmount).toBe(123n);
  });
  test("sell worst price rounds up away from fill", () => {
    expect(prepareHedge({ ...request, side: "sell" }, market).worstPrice).toBe(
      818361n,
    );
  });
  test("size always rounds down", () => {
    expect(
      prepareHedge({ ...request, baseAmount: "0.00123999" }, market).baseAmount,
    ).toBe(123n);
  });
  test.each([
    500,
    501,
    Infinity,
    -1,
    0.5,
  ])("guards invalid slippage %s", (value) => {
    expect(() =>
      prepareHedge({ ...request, maxSlippageBps: value }, market),
    ).toThrow("Slippage");
  });
  test("guards uint48 client index and zero reserved ID", () => {
    for (const clientOrderIndex of [0n, -1n, 1n << 48n])
      expect(() =>
        prepareHedge({ ...request, clientOrderIndex }, market),
      ).toThrow("clientOrderIndex");
  });
  test("guards min base after quantizing", () => {
    expect(() =>
      prepareHedge({ ...request, baseAmount: "0.0001999999" }, market),
    ).toThrow("minimum");
  });
  test("guards min quote independently", () => {
    expect(() =>
      prepareHedge({ ...request, refPrice: "100", baseAmount: "0.01" }, market),
    ).toThrow("minimum");
  });
  test("guards zero price/size and inactive market", () => {
    expect(() => prepareHedge({ ...request, refPrice: "0" }, market)).toThrow(
      "positive",
    );
    expect(() => prepareHedge({ ...request, baseAmount: "0" }, market)).toThrow(
      "positive",
    );
    expect(() =>
      prepareHedge(request, { ...market, status: "inactive" }),
    ).toThrow("active");
  });
  test("signs MARKET IOC expiry=0 with explicit nonce", async () => {
    const s = setup();
    s.onSend(() =>
      s.ws.emit("orders", {
        channel: "account_orders/1/42",
        orders: [order()],
      }),
    );
    const result = await s.service.hedge(request);
    expect(result.status).toBe("filled");
    const args = s.calls[0];
    expect(args?.slice(4, 10)).toEqual([0, 1, 0, 0, 0, 0]);
    expect(args?.slice(15)).toEqual([0, 10n, 4, 42n]);
    expect(result.avgPrice).toBe("82000");
    expect(result.fee).toBe("0.02");
  });
  test("reduceOnly and sell reach signer", async () => {
    const s = setup();
    s.onSend(() =>
      s.ws.emit("orders", {
        channel: "account_orders/1/42",
        orders: [order()],
      }),
    );
    await s.service.hedge({ ...request, side: "sell", reduceOnly: true });
    expect(s.calls[0]?.[4]).toBe(1);
    expect(s.calls[0]?.[7]).toBe(1);
  });
  test("event before send acknowledgement is retained", async () => {
    const s = setup();
    s.onSend(() =>
      s.ws.emit("transaction", {
        channel: "account_tx/42",
        transaction: { hash: "h", state: "failed" },
      }),
    );
    expect((await s.service.hedge(request)).status).toBe("failed");
  });
  test("compact account_tx fill is confirmed by hash and client", async () => {
    const s = setup();
    s.onSend(() =>
      s.ws.emit("transaction", {
        channel: "account_tx/42",
        transaction: {
          hash: "h",
          state: "executed",
          eventInfo: {
            m: 1,
            to: { u: 123, is: 123, rs: 0, st: 3 },
            t: { s: 123, p: 820000 },
          },
        },
      }),
    );
    const result = await s.service.hedge(request);
    expect(result.status).toBe("filled");
    expect(result.filledBase).toBe("0.00123");
    expect(result.avgPrice).toBe("82000");
    expect(result.fee).toBeNull();
  });
  test("unrelated client/market/account/hash cannot confirm", async () => {
    const s = setup();
    s.onSend(() => {
      s.ws.emit("orders", {
        channel: "account_orders/1/42",
        orders: [order("filled", "1", "2", 999n)],
      });
      s.ws.emit("orders", {
        channel: "account_orders/1/99",
        orders: [order()],
      });
      s.ws.emit("transaction", {
        channel: "account_tx/42",
        transaction: { hash: "other", state: "failed" },
      });
    });
    s.setTx({ hash: "h", state: "executed", nonce: 10n });
    s.onSend(() => s.setNext(11n));
    s.setOrders([order()]);
    const p = s.service.hedge(request);
    await flush();
    s.clock.advance(2000);
    const result = await p;
    expect(result.status).toBe("filled");
    expect(s.restCalls()).toBe(1);
  });
  test("timeout falls back to tx and accountOrders", async () => {
    const s = setup();
    s.setTx({ hash: "h", state: "executed", nonce: 10n });
    s.onSend(() => s.setNext(11n));
    s.setOrders([order()]);
    const p = s.service.hedge(request);
    await flush();
    s.clock.advance(2000);
    expect((await p).status).toBe("filled");
    expect(s.restCalls()).toBe(1);
  });
  test("partial fill returns actual base and VWAP", async () => {
    const s = setup();
    s.onSend(() =>
      s.ws.emit("orders", {
        channel: "account_orders/1/42",
        orders: [order("canceled-not-enough-liquidity", "0.0005", "41.05")],
      }),
    );
    const result = await s.service.hedge(request);
    expect(result.status).toBe("partial");
    expect(result.filledBase).toBe("0.0005");
    expect(result.avgPrice).toBe("82100");
    expect(result.reason).toBe("canceled-not-enough-liquidity");
  });
  test.each([
    "canceled-too-much-slippage",
    "canceled-not-enough-liquidity",
    "canceled-margin-not-allowed",
    "canceled-reduce-only",
    "canceled-self-trade",
  ])("maps %s", async (status) => {
    const s = setup();
    s.onSend(() =>
      s.ws.emit("orders", {
        channel: "account_orders/1/42",
        orders: [order(status, "0", "0")],
      }),
    );
    const result = await s.service.hedge(request);
    expect(result.status).toBe("canceled");
    expect(result.reason).toBe(status);
    expect(result.avgPrice).toBeNull();
  });
  test("API rejection returns failed, never filled", async () => {
    const s = setup();
    s.setResponse({ code: 21733 });
    const result = await s.service.hedge(request);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("api-21733");
  });
  test("code200 plus executed placement is still unconfirmed without order", async () => {
    const s = setup(false);
    s.setTx({ hash: "h", state: "executed", nonce: 10n });
    s.onSend(() => s.setNext(11n));
    await expect(s.service.hedge(request)).rejects.toBeInstanceOf(
      HedgeUnconfirmed,
    );
  });
  test("REST failed transaction maps failed", async () => {
    const s = setup(false);
    s.setTx({ hash: "h", state: "failed", nonce: 10n });
    expect((await s.service.hedge(request)).status).toBe("failed");
  });
  test("duplicate client index refused across market submissions", async () => {
    const s = setup();
    s.onSend(() =>
      s.ws.emit("orders", {
        channel: "account_orders/1/42",
        orders: [order()],
      }),
    );
    await s.service.hedge(request);
    await expect(s.service.hedge(request)).rejects.toThrow("already submitted");
  });
  test("confirmation listeners are removed", async () => {
    const s = setup();
    s.onSend(() =>
      s.ws.emit("orders", {
        channel: "account_orders/1/42",
        orders: [order()],
      }),
    );
    await s.service.hedge(request);
    expect(s.ws.listenerCount("orders")).toBe(0);
    expect(s.ws.listenerCount("transaction")).toBe(0);
  });
  test("cancel uses only supplied client index", async () => {
    const s = setup(false);
    s.setTx({ hash: "h", state: "executed", nonce: 10n });
    s.onSend(() => s.setNext(11n));
    expect((await s.service.cancelByClientIndex(1, 123n)).state).toBe(
      "executed",
    );
    expect(s.calls[0]).toEqual([1, 123n, 0, 10n, 4, 42n]);
  });
  test("cancelAll signs immediate across all markets", async () => {
    const s = setup(false);
    s.setTx({ hash: "h", state: "executed", nonce: 10n });
    s.onSend(() => s.setNext(11n));
    await s.service.cancelAll();
    expect(s.calls[0]?.slice(0, 4)).toEqual([0, 0, 255, 0]);
  });
});

test("REST compact multi-fill result aggregates VWAP", async () => {
  const s = setup(false);
  s.setTx({
    hash: "h",
    nonce: 10n,
    state: "executed",
    eventInfo: [
      { m: 1, to: { u: 123, is: 123, rs: 73, st: 2 }, t: { s: 50, p: 820000 } },
      { m: 1, to: { u: 123, is: 123, rs: 0, st: 3 }, t: { s: 73, p: 821000 } },
    ],
  });
  s.onSend(() => s.setNext(11n));
  const result = await s.service.hedge(request);
  expect(result.status).toBe("filled");
  expect(result.filledBase).toBe("0.00123");
  expect(Number(result.avgPrice)).toBeCloseTo(
    (50 * 82000 + 73 * 82100) / 123,
    8,
  );
});
test("REST compact partial cancellation preserves fills", async () => {
  const s = setup(false);
  s.setTx({
    hash: "h",
    nonce: 10n,
    state: "executed",
    eventInfo: [
      { m: 1, to: { u: 123, is: 123, rs: 73, st: 2 }, t: { s: 50, p: 820000 } },
      { m: 1, to: { u: 123, is: 123, rs: 73, st: 10 } },
    ],
  });
  s.onSend(() => s.setNext(11n));
  const result = await s.service.hedge(request);
  expect(result.status).toBe("partial");
  expect(result.filledBase).toBe("0.0005");
  expect(result.reason).toBe("canceled-not-enough-liquidity");
});
test("executed no-op application error is failed via REST", async () => {
  const s = setup(false);
  s.setTx({
    hash: "h",
    nonce: 10n,
    state: "executed",
    eventInfo: { m: 1, ae: "invalid size" },
  });
  s.onSend(() => s.setNext(11n));
  expect((await s.service.hedge(request)).reason).toBe("application-rejection");
});
test("order claiming more fill than submitted is unconfirmed", async () => {
  const s = setup(false);
  s.setOrders([order("filled", "10", "820000")]);
  s.setTx({ hash: "h", state: "executed", nonce: 10n });
  s.onSend(() => s.setNext(11n));
  await expect(s.service.hedge(request)).rejects.toBeInstanceOf(
    HedgeUnconfirmed,
  );
});
test("incomplete compact trade list cannot invent fill price", async () => {
  const s = setup(false);
  s.setTx({
    hash: "h",
    nonce: 10n,
    state: "executed",
    eventInfo: {
      m: 1,
      to: { u: 123, is: 123, rs: 0, st: 3 },
      t: { s: 50, p: 820000 },
    },
  });
  s.onSend(() => s.setNext(11n));
  await expect(s.service.hedge(request)).rejects.toBeInstanceOf(
    HedgeUnconfirmed,
  );
});

test("sell minimum quote applies at worst rounded price", () => {
  expect(() =>
    prepareHedge(
      {
        ...request,
        side: "sell",
        baseAmount: "0.1",
        refPrice: "100",
        maxSlippageBps: 100,
      },
      market,
    ),
  ).toThrow("minimum");
});
test("unknown hedge leaves nonce blocked after REST reconciliation", async () => {
  const s = setup(false);
  await expect(s.service.hedge(request)).rejects.toBeInstanceOf(
    HedgeUnconfirmed,
  );
  await expect(
    s.service.hedge({ ...request, clientOrderIndex: 124n }),
  ).rejects.toThrow("unresolved");
  expect(s.calls).toHaveLength(1);
});
test("cancel accepted without terminal tx never claims success", async () => {
  const s = setup(false);
  await expect(s.service.cancelAll()).rejects.toThrow("unconfirmed");
  expect(s.calls).toHaveLength(1);
});
