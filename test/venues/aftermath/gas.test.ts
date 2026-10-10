import { expect, test } from "bun:test";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { ReferenceGasPrice } from "../../../src/venues/aftermath/gas";

function clockClient() {
  let now = 1000,
    stateReads = 0,
    priceReads = 0;
  const client = {
    getCurrentSystemState: async () => {
      stateReads++;
      return {
        systemState: {
          epoch: String(Math.floor(now / 1000)),
          epochStartTimestampMs: String(Math.floor(now / 1000) * 1000),
          parameters: { epochDurationMs: "1000" },
        },
      };
    },
    getReferenceGasPrice: async () => {
      priceReads++;
      return { referenceGasPrice: "100" };
    },
  } as unknown as SuiGrpcClient;
  return {
    client,
    now: () => now,
    setNow: (value: number) => {
      now = value;
    },
    counts: () => ({ stateReads, priceReads }),
  };
}
test("many submits within epoch reuse price without any gRPC calls", async () => {
  const h = clockClient();
  const cache = new ReferenceGasPrice(h.client, h.now);
  for (let i = 0; i < 10; i++) {
    h.setNow(1000 + i * 50);
    expect(await cache.get()).toBe(100n);
  }
  expect(h.counts()).toEqual({ stateReads: 1, priceReads: 1 });
});
test("concurrent cache misses share one state/price fetch", async () => {
  const h = clockClient();
  const cache = new ReferenceGasPrice(h.client, h.now);
  expect(await Promise.all([cache.get(), cache.get(), cache.get()])).toEqual([
    100n,
    100n,
    100n,
  ]);
  expect(h.counts()).toEqual({ stateReads: 1, priceReads: 1 });
});
test("epoch end and invalidate each refresh the cache", async () => {
  const h = clockClient();
  const cache = new ReferenceGasPrice(h.client, h.now);
  await cache.get();
  h.setNow(2000);
  await cache.get();
  cache.invalidate();
  await cache.get();
  expect(h.counts()).toEqual({ stateReads: 3, priceReads: 3 });
});
test("price finishing after epoch end is refreshed before being cached", async () => {
  const h = clockClient();
  let prices = 0;
  h.client.getReferenceGasPrice = async () => {
    if (++prices === 1) {
      h.setNow(2000);
      return { referenceGasPrice: "100" };
    }
    return { referenceGasPrice: "101" };
  };
  const cache = new ReferenceGasPrice(h.client, h.now);
  expect(await cache.get()).toBe(101n);
  expect(prices).toBe(2);
  expect(await cache.get()).toBe(101n);
  expect(prices).toBe(2);
});
test("invalid epoch timing or nonpositive RGP never enters cache", async () => {
  const h = clockClient();
  h.client.getReferenceGasPrice = async () => ({ referenceGasPrice: "0" });
  await expect(new ReferenceGasPrice(h.client, h.now).get()).rejects.toThrow(
    "reference gas price",
  );
  h.client.getCurrentSystemState = (async () => ({
    systemState: {
      epoch: "1",
      epochStartTimestampMs: "1000",
      parameters: { epochDurationMs: "0" },
    },
  })) as unknown as SuiGrpcClient["getCurrentSystemState"];
  await expect(new ReferenceGasPrice(h.client, h.now).get()).rejects.toThrow(
    "epoch timestamps",
  );
});
