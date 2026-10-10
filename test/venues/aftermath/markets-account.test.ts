import { expect, test } from "bun:test";
import { AfAccount, hasPosition } from "../../../src/venues/aftermath/account";
import { AfHttp } from "../../../src/venues/aftermath/http";
import {
  AfMarkets,
  hourlyFundingRate,
  marketPackageIds,
  normalizeMarket,
} from "../../../src/venues/aftermath/markets";
import type {
  MarketData,
  MarketPrice,
  Position,
  RawMarket,
} from "../../../src/venues/aftermath/types";
import { fixture } from "./helpers";

test("48 recorded markets normalize with funding identity and dynamic periods", async () => {
  const { markets } = (await fixture("all-markets")) as {
    markets: RawMarket[];
  };
  expect(markets).toHaveLength(48);
  const periods = new Set<number>();
  for (const raw of markets) {
    const m = normalizeMarket(raw);
    periods.add(m.fundingPeriodMs);
    expect(m.tickInt).toBeGreaterThan(0n);
    expect(m.lotInt).toBeGreaterThan(0n);
    expect(m.maxLeverage).toBe(1 / m.imr);
    expect(
      Math.abs(hourlyFundingRate(m) - m.estimatedFundingRate),
    ).toBeLessThan(1e-12);
  }
  expect(periods.size).toBeGreaterThan(1);
  expect(marketPackageIds(markets)).toHaveLength(1);
});
test("metadata carries session and mark comes from prices, never fabricated", async () => {
  const { marketDatas } = (await fixture("markets")) as {
    marketDatas: MarketData[];
  };
  const { marketsPrices } = (await fixture("prices")) as {
    marketsPrices: MarketPrice[];
  };
  const btc = marketDatas.find(
    (d) => d.market.marketParams.baseAssetSymbol === "BTCUSD",
  );
  if (!btc) throw new Error("BTC missing");
  expect(normalizeMarket(btc.market, btc.metadata).markPrice).toBeNull();
  const m = normalizeMarket(btc.market, btc.metadata, marketsPrices[0]);
  expect(m.symbol).toBe("BTC");
  expect(m.baseSymbol).toBe("BTC");
  expect(m.markPrice).toBe(marketsPrices[0]?.markPrice ?? null);
  expect(m.makerFee).toBe(-0.00005);
  const trad = marketDatas.find((d) => d.metadata?.session);
  if (!trad) throw new Error("Session missing");
  expect(normalizeMarket(trad.market, trad.metadata).session).toEqual({
    isOpen: trad.metadata?.session?.isOpen ?? true,
    nextTransitionAt: trad.metadata?.session?.nextTransitionAt ?? null,
  });
});
test("malformed market fails closed", async () => {
  const { markets } = (await fixture("all-markets")) as {
    markets: RawMarket[];
  };
  const raw = markets[0];
  if (!raw) throw new Error("missing");
  expect(() => normalizeMarket({ ...raw, indexPrice: 0 })).toThrow();
  expect(() =>
    normalizeMarket({
      ...raw,
      marketParams: { ...raw.marketParams, fundingPeriodMs: 0n },
    }),
  ).toThrow();
});
test("market endpoint methods use confirmed live envelopes", async () => {
  const paths: string[] = [];
  const h = new AfHttp({
    fetch: (async (url, init) => {
      const route = String(url).split("/api/perpetuals/")[1] ?? "";
      paths.push(route);
      const name = (
        {
          "all-markets": "all-markets",
          markets: "markets",
          "markets/prices": "prices",
          "markets/orderbooks": "orderbooks",
          "markets/sessions": "sessions",
          "market/funding-history": "funding-history",
        } as Record<string, string>
      )[route];
      if (!name) throw new Error("Unknown route");
      expect(init?.method).toBe("POST");
      return new Response(
        await Bun.file(
          new URL(`../../fixtures/aftermath/${name}.json`, import.meta.url),
        ).text(),
      );
    }) as typeof fetch,
  });
  const m = new AfMarkets(h);
  expect(await m.allMarkets("synthetic")).toHaveLength(48);
  expect(await m.markets()).toHaveLength(48);
  expect(await m.prices(["market"])).toHaveLength(1);
  expect((await m.orderbooks(["market"]))[0]?.orderbook.nonce).toBeTypeOf(
    "bigint",
  );
  expect((await m.sessions()).length).toBeGreaterThan(0);
  expect((await m.fundingHistory("market", 0, 1)).length).toBeGreaterThan(0);
  expect(paths).toHaveLength(6);
  await expect(m.sessions(15)).rejects.toThrow();
});
test("hasPosition uses entry existence even with zero exposure", () => {
  const position = { marketId: "m", baseAssetAmount: 0 } as Position;
  expect(hasPosition([position], "m")).toBe(true);
  expect(hasPosition([position], "other")).toBe(false);
});
test("finds agent capability and detailed history preserves cursor", async () => {
  const h = new AfHttp({
    fetch: (async (url, init) => {
      const req = JSON.parse(String(init?.body));
      if (String(url).endsWith("owned"))
        return Response.json({
          accountCaps: [
            { isAgent: false, accountId: "1n" },
            { isAgent: true, accountId: "2n" },
          ],
        });
      expect(req.accountId).toBe("2n");
      expect(req.beforeTimestampCursor).toBe(50);
      return Response.json({ trades: [], nextBeforeTimestampCursor: 30 });
    }) as typeof fetch,
  });
  const account = new AfAccount(h);
  expect(await account.agentCap("0x1")).toMatchObject({
    accountId: 2n,
    isAgent: true,
  });
  expect(
    await account.orderHistoryDetailed(2n, { beforeTimestampCursor: 50 }),
  ).toEqual({ trades: [], nextBeforeTimestampCursor: 30 });
});

test("account snapshot exposes hasPosition(marketId) even for zero base", async () => {
  const http = new AfHttp({
    fetch: (async () =>
      Response.json({
        accounts: [
          {
            accountId: "7n",
            positions: [
              {
                marketId: "m",
                baseAssetAmount: 0,
                entryPrice: 0,
                collateral: 1,
                pendingOrders: [],
                unrealizedFundingsUsd: 0,
              },
            ],
          },
        ],
      })) as unknown as typeof fetch,
  });
  const view = await new AfAccount(http).snapshot(7n);
  expect(view.hasPosition("m")).toBe(true);
  expect(view.hasPosition("x")).toBe(false);
});
