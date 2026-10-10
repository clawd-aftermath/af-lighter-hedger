// Manual, public read-only probe. Never imported by tests; never signs or submits.
// The real-tx recording mode only reserializes sanitized historical data.
import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { AfHttp, stringifyAf } from "../src/venues/aftermath/http";
import {
  AfMarkets,
  hourlyFundingRate,
  normalizeMarket,
} from "../src/venues/aftermath/markets";

async function recordRealTransaction(): Promise<void> {
  const marketId =
    "0x05b5c3bea84c4b8f33cf592d899008336dcbae8c9c6c75b2f8e7b8f7878744c1";
  const endpoint = "https://graphql.mainnet.sui.io/graphql";
  const query = `query { transactions(last: 40, filter: {affectedObject: "${marketId}"}) { nodes { digest transactionBcs } } }`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "af-lighter-hedger-probe/1.0",
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`);
  const result = (await response.json()) as {
    errors?: unknown;
    data: {
      transactions: { nodes: { digest: string; transactionBcs: string }[] };
    };
  };
  if (result.errors) throw new Error("GraphQL transaction query failed");
  const candidates = result.data.transactions.nodes.filter((node) =>
    Transaction.from(fromBase64(node.transactionBcs))
      .getData()
      .commands.some((c) => c.MoveCall?.function === "place_limit_order"),
  );
  const node =
    candidates.find(
      (node) =>
        Transaction.from(fromBase64(node.transactionBcs)).getData().gasData
          .price === "101",
    ) ?? candidates[0];
  if (!node)
    throw new Error("No native order transaction in last 40 BTC transactions");
  const data = Transaction.from(fromBase64(node.transactionBcs)).getData();
  const commandStructure = JSON.stringify(data.commands);
  const originalGasPrice = data.gasData.price;
  const syntheticSender = normalizeSuiAddress("0xa11ce");
  const syntheticDigest = "11111111111111111111111111111111";
  const replacedObjects: string[] = [];
  let addressInputsReplaced = 0;
  data.sender = syntheticSender;
  data.gasData.owner = syntheticSender;
  data.gasData.price = "100";
  data.gasData.budget = "10000000";
  data.gasData.payment = [
    {
      objectId: normalizeSuiAddress("0xa9000"),
      version: "1",
      digest: syntheticDigest,
    },
  ];
  for (const [i, input] of data.inputs.entries()) {
    if (input.$kind === "Pure" && fromBase64(input.Pure.bytes).length === 32) {
      input.Pure.bytes = toBase64(
        bcs.Address.serialize(syntheticSender).toBytes(),
      );
      addressInputsReplaced++;
    } else if (input.$kind === "Object") {
      const object = input.Object;
      const id =
        object.ImmOrOwnedObject?.objectId ??
        object.SharedObject?.objectId ??
        object.Receiving?.objectId;
      if (id !== marketId) {
        replacedObjects.push(
          normalizeSuiAddress(`0x${(0xa0000 + i).toString(16)}`),
        );
        const replacement = replacedObjects.at(-1);
        if (!replacement) throw new Error("Missing synthetic object ID");
        if (object.ImmOrOwnedObject)
          Object.assign(object.ImmOrOwnedObject, {
            objectId: replacement,
            version: "1",
            digest: syntheticDigest,
          });
        if (object.Receiving)
          Object.assign(object.Receiving, {
            objectId: replacement,
            version: "1",
            digest: syntheticDigest,
          });
        if (object.SharedObject) object.SharedObject.objectId = replacement;
      }
    }
  }
  for (const command of data.commands)
    if (command.TransferObjects) {
      const arg = command.TransferObjects.address;
      if (arg.$kind !== "Input" || data.inputs[arg.Input]?.$kind !== "Pure")
        throw new Error("Cannot sanitize computed transfer recipient");
      const input = data.inputs[arg.Input];
      if (input?.Pure)
        input.Pure.bytes = toBase64(
          bcs.Address.serialize(syntheticSender).toBytes(),
        );
    }
  if (JSON.stringify(data.commands) !== commandStructure)
    throw new Error("Sanitization changed command structure");
  const bytes = await Transaction.from(JSON.stringify(data)).build();
  const sanitized = Transaction.from(bytes).getData();
  const commands = sanitized.commands.map((c) =>
    c.MoveCall
      ? `${c.MoveCall.package}::${c.MoveCall.module}::${c.MoveCall.function}`
      : c.$kind,
  );
  const publicPackageIds = [
    ...new Set(
      sanitized.commands.flatMap((c) =>
        c.MoveCall
          ? [
              c.MoveCall.package,
              ...c.MoveCall.typeArguments.flatMap(
                (t) => t.match(/0x[0-9a-f]{60,}(?=::)/g) ?? [],
              ),
            ]
          : [],
      ),
    ),
  ].sort();
  const fixture = {
    transactionDataBase64: toBase64(bytes),
    decoded: sanitized,
    provenance: {
      endpoint,
      query,
      recordedAt: new Date().toISOString(),
      fixtureGasPrice: "100",
      referenceGasPrice: "100",
      syntheticSender,
      syntheticGasPaymentObjectId: normalizeSuiAddress("0xa9000"),
      publicPackageIds,
      syntheticObjectIds: replacedObjects,
      addressInputsReplaced,
      commands,
      note: "This fixture gas price is set to RGP; the gate deliberately continues requiring RGP for every order transaction. All non-market object IDs, sender, gas owner/payment references, and 32-byte pure inputs are synthetic. Command list and argument indexes are unchanged.",
    },
  };
  await Bun.write(
    new URL(
      "../test/fixtures/aftermath/real-order-sanitized.json",
      import.meta.url,
    ),
    `${JSON.stringify(fixture, null, 2)}\n`,
  );
  console.table(commands.map((command, index) => ({ index, command })));
  console.log(
    "Sanitized real order fixture recorded",
  );
}
if (process.argv.includes("--record-real-tx")) {
  await recordRealTransaction();
  process.exit(0);
}

const record = process.argv.includes("--record");
const http = new AfHttp({ baseUrl: process.env.AFTERMATH_BASE_URL });
const markets = new AfMarkets(http);
const rows: { check: string; result: string }[] = [];
const config = await http.read<{ defaultCollateralCoinType: string }>(
  "/api/perpetuals/config",
);
rows.push({ check: "Host", result: `${http.baseUrl}: reachable` });
const all = await markets.allMarkets(config.defaultCollateralCoinType);
rows.push({ check: "Markets", result: `${all.length} parsed` });
const btc = all.find((m) => m.marketParams.baseAssetSymbol === "BTCUSD");
if (!btc) throw new Error("BTCUSD missing");
const datas = await markets.markets();
const prices = await markets.prices([btc.objectId]);
const books = await markets.orderbooks([btc.objectId]);
const sessions = await markets.sessions(1);
const history = await markets.fundingHistory(
  btc.objectId,
  Date.now() - 3_600_000,
  Date.now(),
  3,
);
const normalized = normalizeMarket(btc);
const computed = hourlyFundingRate(normalized);
const difference = Math.abs(computed - normalized.estimatedFundingRate);
rows.push({
  check: "BTC funding",
  result: `${computed} vs ${normalized.estimatedFundingRate}; delta=${difference}`,
});
if (difference > 1e-12) throw new Error("Funding recomputation mismatch");
try {
  const client = new SuiGrpcClient({
    network: "mainnet",
    baseUrl: "https://fullnode.mainnet.sui.io:443",
  });
  const { referenceGasPrice } = await client.getReferenceGasPrice();
  rows.push({ check: "Sui gRPC RGP", result: `${referenceGasPrice} MIST` });
} catch (e) {
  rows.push({ check: "Sui gRPC RGP", result: `FAILED: ${String(e)}` });
}
const wsUrl = new URL("/api/perpetuals/ws/updates", http.baseUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
const frames: { elapsedMs: number; message: unknown }[] = [];
const startedAt = Date.now();
await new Promise<void>((resolve, reject) => {
  const ws = new (
    WebSocket as unknown as new (
      url: string,
      options: Bun.WebSocketOptions,
    ) => WebSocket
  )(wsUrl.href, { headers: { "User-Agent": "af-lighter-hedger-probe/1.0" } });
  const timer = setTimeout(
    () => {
      ws.close();
      resolve();
    },
    record ? 30_000 : 5000,
  );
  ws.onopen = () => {
    for (const stream of ["orderbook", "market", "oracle"])
      ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptionType: { [stream]: { marketId: btc.objectId } },
        }),
      );
  };
  ws.onmessage = (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      message = { ack: String(event.data) };
    }
    // Only these public subscriptions are recorded; never user/marketOrders.
    frames.push({ elapsedMs: Date.now() - startedAt, message });
  };
  ws.onerror = () => {
    clearTimeout(timer);
    ws.close();
    reject(new Error("Public WS connection failed"));
  };
});
rows.push({
  check: "BTC WS",
  result: `${frames.length} public frames over ${Date.now() - startedAt} ms; ${[...new Set(frames.flatMap((f) => Object.keys(f.message as object)))].join(", ")}`,
});
if (record) {
  const path = new URL("../test/fixtures/aftermath/", import.meta.url);
  const write = async (name: string, value: unknown) =>
    Bun.write(new URL(name, path), `${stringifyAf(value)}\n`);
  await write("all-markets.json", { markets: all });
  await write("markets.json", { marketDatas: datas });
  await write("prices.json", { marketsPrices: prices });
  await write("orderbooks.json", { orderbooks: books });
  await write("sessions.json", { sessions });
  await write("funding-history.json", { history });
  await write("ws-public.json", { frames });
  await write("provenance.json", {
    recordedAt: new Date().toISOString(),
    host: http.baseUrl,
    collateralCoinType: config.defaultCollateralCoinType,
    btcMarketId: btc.objectId,
    wsDurationMs: Date.now() - startedAt,
    probe: rows,
    publicChannels: ["orderbook", "market", "oracle"],
  });
}
console.table(rows);
