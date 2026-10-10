import { expect, test } from "bun:test";
import type { SuiClientTypes } from "@mysten/sui/client";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { RealLighterVenue } from "../../src/engine/adapters";
import type { HedgeSubmission } from "../../src/engine/types";
import { AfExecutor, AfHttp } from "../../src/venues/aftermath";
import {
  LighterRest,
  type LighterSigner,
  NonceManager,
} from "../../src/venues/lighter";
import { CAP, PACKAGE, RGP, synthetic } from "../venues/aftermath/helpers";
import { fixture, required } from "./helpers";

function execution() {
  return {
    $kind: "Transaction",
    Transaction: {
      digest: "digest",
      status: { success: true, error: null },
      effects: {
        gasUsed: {
          computationCost: "1",
          storageCost: "0",
          storageRebate: "0",
          nonRefundableStorageFee: "0",
        },
      },
      events: [],
    },
  } as unknown as SuiClientTypes.TransactionResult<{
    effects: true;
    events: true;
  }>;
}
function executorHarness() {
  let sends = 0;
  let simulations = 0;
  const client = {
    getCurrentSystemState: async () => ({
      systemState: {
        epoch: "1",
        epochStartTimestampMs: "0",
        parameters: { epochDurationMs: String(1e15) },
      },
    }),
    getReferenceGasPrice: async () => ({ referenceGasPrice: String(RGP) }),
    executeTransaction: async () => {
      sends++;
      return execution();
    },
    simulateTransaction: async () => {
      simulations++;
      return execution();
    },
  } as unknown as SuiGrpcClient;
  const executor = new AfExecutor({
    client,
    http: new AfHttp(),
    signer: {
      address: "0x1",
      signTransaction: async () => ({ signature: "signature" }),
    },
    gas: {
      mode: "gas-pool",
      gasPoolPackageId: "0x4",
      maxGasBudget: CAP,
      sponsor: {
        walletAddress: "0x2",
        bytes: "terms",
        signature: "terms-signature",
      },
    },
    allowedPackageIds: [PACKAGE],
  });
  return { executor, counts: () => ({ sends, simulations }) };
}
test("AF executor durably exposes final digest before send", async () => {
  const f = fixture();
  const h = executorHarness();
  const bytes = await synthetic({ pool: true, owner: "0x2" }).build();
  const intent = f.store.createIntent({
    venue: "af",
    kind: "quote",
    clientId: "1",
    market: "SOL",
    payload: {},
  });
  let hash = "";
  await h.executor.submit(
    async () => ({ txKind: toBase64(bytes), sponsorSignature: "sponsor" }),
    (digest) => {
      expect(h.counts().sends).toBe(0);
      hash = digest;
      f.store.updateIntent(intent.id, "sending", digest);
    },
  );
  expect(hash).toBe(await Transaction.from(bytes).getDigest());
  expect(f.store.intent(intent.id)?.txHash).toBe(hash);
  expect(h.counts().sends).toBe(1);
  f.store.close();
});
test("failed AF durable hook prevents submission", async () => {
  const h = executorHarness();
  const bytes = await synthetic({ pool: true, owner: "0x2" }).build();
  await expect(
    h.executor.submit(
      async () => ({ txKind: toBase64(bytes), sponsorSignature: "sponsor" }),
      () => {
        throw new Error("disk failed");
      },
    ),
  ).rejects.toThrow("disk failed");
  expect(h.counts().sends).toBe(0);
});
function lighterHarness() {
  const f = fixture();
  let sendCalls = 0;
  const rest = new LighterRest({ tier: "plus" });
  rest.orderBookDetails = async () => f.markets.map((m) => m.lighter);
  rest.nextNonce = async () => (sendCalls ? 2n : 1n);
  rest.tx = async (hash) => ({ hash, nonce: 1n, state: "executed" });
  rest.accountOrders = async (_account, clients) => ({
    items: clients.map((client) => ({
      clientOrderIndex: client,
      marketId: 2,
      status: "filled",
      filledBase: "0.5",
      filledQuote: "50",
      fee: "0",
    })),
  });
  const signer = {
    SignCreateOrder: () => ({
      txType: 14,
      txInfo: "signed",
      txHash: "signed-hash",
    }),
  } as unknown as LighterSigner;
  const nonce = new NonceManager(rest, 1n, 4, crypto.randomUUID());
  const venue = new RealLighterVenue({
    markets: f.markets,
    rest,
    signer,
    nonce,
    store: f.store,
    clock: f.clock,
  });
  const request: HedgeSubmission = {
    intent: {
      marketId: "SOL",
      clientOrderIndex: 1n,
      side: "BID",
      size: 500000000n,
      slippageBps: 50,
    },
    baseAmount: 500n,
    refPrice: 100000000000n,
    reduceOnly: false,
  };
  const intent = f.store.createIntent({
    venue: "lighter",
    kind: "hedge",
    clientId: "1",
    market: "SOL",
    payload: request,
  });
  f.store.advanceCursor("lighter", 2n);
  rest.sendTx = async (tx) => {
    sendCalls++;
    expect(f.store.intent(intent.id)?.txHash).toBe(tx.txHash);
    expect(f.store.intent(intent.id)?.status).toBe("sending");
    return { code: 200, txHash: tx.txHash };
  };
  return {
    ...f,
    venue,
    rest,
    intent,
    request,
    sends: () => sendCalls,
    context: {
      intent,
      beforeSend: (hash: string) =>
        f.store.updateIntent(intent.id, "sending", hash),
    },
  };
}
test("real Lighter adapter persists signed hash before transport and confirms via REST", async () => {
  const h = lighterHarness();
  const result = await h.venue.hedge(h.request, h.context);
  expect(result.status).toBe("filled");
  expect(h.sends()).toBe(1);
  expect(result.txHash).toBe("signed-hash");
  h.store.close();
});
test("Lighter adapter resolution requires both tx/nonce and terminal order", async () => {
  const h = lighterHarness();
  await h.venue.hedge(h.request, h.context);
  const intent = h.store.intent(h.intent.id);
  if (!intent) throw new Error("missing intent");
  h.rest.accountOrders = async () => ({ items: [] });
  expect((await h.venue.resolve(intent)).status).toBe("unknown");
  h.rest.accountOrders = async () => ({
    items: [
      {
        clientOrderIndex: 1n,
        marketId: 2,
        status: "filled",
        filledBase: "0.5",
        filledQuote: "50",
      },
    ],
  });
  expect((await h.venue.resolve(intent)).status).toBe("confirmed");
  h.store.close();
});

test("Lighter funding uses authoritative payment rows with venue source", async () => {
  const f = fixture();
  let pages = 0;
  const rest = {
    positionFunding: async () => {
      pages++;
      return {
        items: [
          {
            marketId: 2,
            fundingId: "payment-1",
            timestamp: 1234,
            change: "-0.125",
          },
        ],
        nextCursor: undefined,
      };
    },
  } as unknown as LighterRest;
  const nonce = new NonceManager(rest, 1n, 4, crypto.randomUUID());
  const venue = new RealLighterVenue({
    markets: f.markets,
    rest,
    signer: {} as LighterSigner,
    nonce,
    store: f.store,
    clock: f.clock,
  });
  const rows = await venue.funding();
  expect(rows).toEqual([
    {
      venue: "lighter",
      market: "SOL",
      ts: 1234,
      amount: -125000000n,
      key: "payment-1",
      source: "venue",
    },
  ]);
  expect(pages).toBe(1);
  f.store.funding(required(rows[0]));
  f.store.funding(required(rows[0]));
  expect(f.engine.pnl()[0]?.fundingPaid).toBe("125000000");
  expect(f.store.fundingPayments()).toHaveLength(1);
  f.store.close();
});
