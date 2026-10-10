import { expect, test } from "bun:test";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { OracleReader } from "../../src/engine/oracle";
import type { AfMarkets } from "../../src/venues/aftermath";
import { fixture } from "./helpers";

function harness() {
  const f = fixture();
  let timestamp = "90000",
    symbol = "SOLUSD",
    source = 1,
    historyReads = 0;
  const storage = () => ({
    objectId: "0xa",
    type: "0x1::price_feed_storage::PriceFeedStorage",
    json: {
      storage_id: 9,
      symbol,
      feeds: [
        {
          source_id: source,
          price: "123456789012345678901",
          timestamp_ms: timestamp,
        },
      ],
    },
  });
  const client = {
    getObject: async () => ({
      object: {
        json: {
          market_params: {
            core_params: { base_storage_id: 9, base_source_id: 1 },
          },
        },
      },
    }),
    getTransaction: async () => ({
      $kind: "Transaction",
      Transaction: {
        transaction: {
          inputs: [{ Object: { SharedObject: { objectId: "0xa" } } }],
        },
      },
    }),
    getObjects: async () => ({ objects: [storage()] }),
  } as unknown as SuiGrpcClient;
  const af = {
    http: {
      read: async () => {
        historyReads++;
        return { orders: [{ txDigest: "public-tx" }] };
      },
    },
  } as unknown as AfMarkets;
  return {
    f,
    reader: new OracleReader(client, af, f.markets),
    setTimestamp: (value: string) => {
      timestamp = value;
    },
    setSymbol: (value: string) => {
      symbol = value;
    },
    setSource: (value: number) => {
      source = value;
    },
    reads: () => historyReads,
  };
}
test("oracle reads source timestamp and exact fixed-point price, never receiver time", async () => {
  const h = harness();
  const prices = await h.reader.read();
  expect(prices.get("SOL")).toEqual({ price: 123456789012n, timestamp: 90000 });
  h.f.clock.advance(90000);
  h.setTimestamp("91000");
  expect((await h.reader.read()).get("SOL")?.timestamp).toBe(91000);
  expect(h.reads()).toBe(1);
  h.f.store.close();
});
test("oracle identity mismatch fails closed", async () => {
  const h = harness();
  await h.reader.read();
  h.setSymbol("BTCUSD");
  await expect(h.reader.read()).rejects.toThrow("identity mismatch");
  h.f.store.close();
});
test("oracle rejects missing source and invalid timestamps", async () => {
  const h = harness();
  await h.reader.read();
  h.setSource(2);
  await expect(h.reader.read()).rejects.toThrow("source missing");
  h.setSource(1);
  h.setTimestamp("NaN");
  await expect(h.reader.read()).rejects.toThrow("timestamp");
  h.f.store.close();
});
test("oracle discovery refuses a symbol that cannot be tied to the clearing house", async () => {
  const h = harness();
  h.setSymbol("BTCUSD");
  await expect(h.reader.read()).rejects.toThrow("Cannot discover");
  h.f.store.close();
});
