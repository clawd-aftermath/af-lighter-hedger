import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { AfMarkets } from "../venues/aftermath";
import type { ResolvedMarket } from "./markets";
export interface OraclePrice {
  price: bigint;
  timestamp: number;
}
interface Storage {
  symbol: string;
  storage_id: number;
  feeds: { source_id: number; price: string; timestamp_ms: string }[];
}
// AF's public price frames omit timestamps. Read the same price-feed storage
// referenced by the clearing house, and use its source timestamp and price.
export class OracleReader {
  private objects = new Map<
    string,
    { id: string; source: number; storage: number }
  >();
  constructor(
    private client: SuiGrpcClient,
    private af: AfMarkets,
    private markets: readonly ResolvedMarket[],
  ) {}
  async discover(): Promise<void> {
    for (const market of this.markets) {
      const { object } = await this.client.getObject({
        objectId: market.af.id,
        include: { json: true },
      });
      const core = (
        object.json as {
          market_params: {
            core_params: { base_storage_id: number; base_source_id: number };
          };
        }
      ).market_params.core_params;
      const history = await this.af.http.read<{
        orders: { txDigest: string }[];
      }>("/api/perpetuals/market/order-history", {
        marketId: market.af.id,
        limit: 5,
      });
      for (const order of history.orders) {
        const tx = await this.client.getTransaction({
          digest: order.txDigest,
          include: { transaction: true },
        });
        if (tx.$kind !== "Transaction") continue;
        const ids = tx.Transaction.transaction.inputs.flatMap((input) =>
          "Object" in input && "SharedObject" in input.Object
            ? [input.Object.SharedObject.objectId]
            : [],
        );
        const result = await this.client.getObjects({
          objectIds: ids,
          include: { json: true },
        });
        const found = result.objects.find(
          (o) =>
            !(o instanceof Error) &&
            o.type?.includes("::price_feed_storage::PriceFeedStorage") &&
            (o.json as unknown as Storage).storage_id ===
              core.base_storage_id &&
            (o.json as unknown as Storage).symbol ===
              `${market.config.symbol}USD`,
        );
        if (found && !(found instanceof Error)) {
          this.objects.set(market.config.symbol, {
            id: found.objectId,
            source: core.base_source_id,
            storage: core.base_storage_id,
          });
          break;
        }
      }
      if (!this.objects.has(market.config.symbol))
        throw new Error(
          `Cannot discover authoritative AF oracle for ${market.config.symbol}`,
        );
    }
  }
  async read(): Promise<Map<string, OraclePrice>> {
    if (this.objects.size !== this.markets.length) await this.discover();
    const entries = [...this.objects];
    const result = await this.client.getObjects({
      objectIds: entries.map(([, o]) => o.id),
      include: { json: true },
    });
    const prices = new Map<string, OraclePrice>();
    entries.forEach(([symbol, entry], i) => {
      const object = result.objects[i];
      if (!object || object instanceof Error)
        throw new Error(`AF oracle read unavailable for ${symbol}`);
      const storage = object.json as unknown as Storage;
      if (
        storage.storage_id !== entry.storage ||
        storage.symbol !== `${symbol}USD`
      )
        throw new Error("AF oracle identity mismatch");
      const feed = storage.feeds.find((f) => f.source_id === entry.source);
      if (!feed) throw new Error("AF oracle source missing");
      const timestamp = Number(feed.timestamp_ms),
        price = BigInt(feed.price) / 1000000000n;
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || price <= 0n)
        throw new Error("Invalid AF oracle price or timestamp");
      prices.set(symbol, { price, timestamp });
    });
    return prices;
  }
}
