import { expect, test } from "bun:test";
import {
  AfBuilders,
  type CancelAndPlaceRequest,
  OrderType,
  validateOrder,
} from "../../../src/venues/aftermath/builders";
import { AfHttp } from "../../../src/venues/aftermath/http";
import { btcMarket } from "./helpers";

const base = { walletAddress: "0x1", accountId: 7n };
function builder(
  capture: (body: Record<string, unknown>, url: string) => void = () => {},
  sponsored = false,
) {
  return new AfBuilders(
    new AfHttp({
      fetch: (async (url, init) => {
        capture(JSON.parse(String(init?.body)), String(url));
        return Response.json({
          txKind: "AAAA",
          sponsorSignature: sponsored ? "sponsor" : undefined,
        });
      }) as typeof fetch,
    }),
  );
}
test("cancel-and-place sends batch enum, IDs, expiry, position and safe defaults", async () => {
  const m = await btcMarket();
  const req: CancelAndPlaceRequest = {
    ...base,
    marketId: m.id,
    orderType: OrderType.POST_ONLY,
    reduceOnly: false,
    hasPosition: true,
    ordersToPlace: [
      { side: 0, price: 82500000000000n, size: 100000n, clientOrderId: 8n },
    ],
    clientOrderIdsToCancel: [9n],
    expiryTimestamp: 1791600000000n,
  };
  const b = builder((body) => {
    expect(body).toMatchObject({
      accountId: "7n",
      orderType: 2,
      reduceOnly: false,
      shouldAbortOnMissingId: false,
      shouldDeallocateFreeCollateral: false,
      hasPosition: true,
      clientOrderIdsToCancel: ["9n"],
      expiryTimestamp: "1791600000000n",
    });
  });
  expect(await b.cancelAndPlaceOrders(req, m)).toEqual({
    txKind: "AAAA",
    sponsorSignature: null,
  });
});
for (const [name, change] of [
  ["tick", { price: 82500000000001n }],
  ["size", { size: 0n }],
  ["notional", { size: 1n }],
  ["side", { side: 2 }],
  ["client ID", { clientOrderId: -1n }],
] as const)
  test(`reject invalid ${name}`, async () => {
    const m = await btcMarket();
    expect(() =>
      validateOrder(
        Object.assign(
          { side: 0, price: 82500000000000n, size: 100000n },
          change,
        ) as Parameters<typeof validateOrder>[0],
        m,
      ),
    ).toThrow();
  });
test("reject lot mismatch", async () => {
  const m = await btcMarket();
  expect(() =>
    validateOrder(
      { side: 0, price: 82500000000000n, size: 100001n },
      { ...m, lotInt: 10n },
    ),
  ).toThrow();
});
test("maxPendingOrders includes existing orders after cancellation", async () => {
  const m = await btcMarket();
  const req = {
    ...base,
    marketId: m.id,
    orderType: 2,
    reduceOnly: false,
    hasPosition: true,
    ordersToPlace: [
      { side: 0 as const, price: 82500000000000n, size: 100000n },
    ],
  };
  expect(() =>
    builder().cancelAndPlaceOrders(req, m, m.maxPendingOrders),
  ).toThrow("Too many");
  expect(() =>
    builder().cancelAndPlaceOrders({ ...req, orderType: 8 as OrderType }, m),
  ).toThrow("orderType");
  expect(() =>
    builder().cancelAndPlaceOrders({ ...req, marketId: "other" }, m),
  ).toThrow("Market mismatch");
});
test("cancel wire data and gas-pool sponsor response", async () => {
  const sponsor = {
    walletAddress: "0x2",
    bytes: "terms",
    signature: "sig",
    gasBudget: 100n,
  };
  const b = builder((body) => {
    expect(body.sponsor).toEqual({ ...sponsor, gasBudget: "100n" });
    expect(body.shouldAbortOnMissingId).toBe(false);
  }, true);
  expect(
    (
      await b.cancelOrders({
        ...base,
        sponsor,
        marketIdsToData: {
          m: { orderIds: [1n], clientOrderIds: [2n], collateralChange: 0 },
        },
      })
    ).sponsorSignature,
  ).toBe("sponsor");
});
test("market unwind enforces reduce-only, lot size and slippage", async () => {
  const m = await btcMarket();
  const r = {
    ...base,
    marketId: m.id,
    side: 1 as const,
    size: 100000n,
    hasPosition: true,
    reduceOnly: true as const,
    slippage: 0.01,
    collateralChange: 0,
    cancelSlTp: true,
  };
  await builder().placeMarketOrder(r, m);
  expect(() => builder().placeMarketOrder({ ...r, slippage: 1 }, m)).toThrow(
    "slippage",
  );
  expect(() =>
    builder().placeMarketOrder({ ...r, hasPosition: false }, m),
  ).toThrow("position");
});
test("allocation and setup routes use exact native names and collateral units", async () => {
  const seen: string[] = [];
  const b = builder((_body, url) => seen.push(url.split("/").at(-1) ?? ""));
  await b.allocateCollateral({
    ...base,
    marketId: "m",
    allocateAmount: 1000000n,
  });
  await b.depositCollateral({
    ...base,
    collateralCoinType: "synthetic",
    depositAmount: 1000000n,
  });
  await b.grantAgentWallet({ accountId: 7n, recipientAddress: "0x2" });
  expect(seen).toEqual([
    "allocate-collateral",
    "deposit-collateral",
    "grant-agent-wallet",
  ]);
  expect(() =>
    b.allocateCollateral({ ...base, marketId: "m", allocateAmount: 0n }),
  ).toThrow();
});
