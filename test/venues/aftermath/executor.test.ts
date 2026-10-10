import { expect, test } from "bun:test";
import type { SuiClientTypes } from "@mysten/sui/client";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, type TransactionPlugin } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { AfExecutor } from "../../../src/venues/aftermath/executor";
import {
  type GasConfig,
  ReferenceGasPrice,
} from "../../../src/venues/aftermath/gas";
import { AfHttp } from "../../../src/venues/aftermath/http";
import {
  AGENT,
  builtKind,
  CAP,
  DYNAMIC_COIN_REF,
  DYNAMIC_COIN_TYPE,
  dynamicSuffix,
  PACKAGE,
  POOL,
  RGP,
  SPONSOR,
  synthetic,
} from "./helpers";

function result(abort?: string) {
  const status = abort
    ? {
        success: false,
        error: {
          $kind: "MoveAbort",
          MoveAbort: { abortCode: abort },
          message: "abort",
        },
      }
    : { success: true, error: null };
  return {
    $kind: abort ? "FailedTransaction" : "Transaction",
    [abort ? "FailedTransaction" : "Transaction"]: {
      digest: "synthetic-digest",
      status,
      effects: {
        status,
        gasUsed: {
          computationCost: "100",
          storageCost: "50",
          storageRebate: "10",
          nonRefundableStorageFee: "0",
        },
      },
      events: [{ eventType: `${PACKAGE}::events::UpdatedPremiumTwap` }],
    },
  } as unknown as SuiClientTypes.TransactionResult<{
    effects: true;
    events: true;
  }>;
}
function harness(address = AGENT, abort?: string) {
  const executions: { transaction: Uint8Array; signatures: string[] }[] = [];
  const simulations: Uint8Array[] = [];
  let builds = 0,
    signs = 0,
    rgpReads = 0,
    epoch = "1";
  const plugin: TransactionPlugin = async (data, _options, next) => {
    builds++;
    data.gasData.owner = data.sender;
    data.gasData.budget ??= String(CAP);
    data.gasData.payment = [
      {
        objectId: "0x99",
        version: "1",
        digest: "11111111111111111111111111111111",
      },
    ];
    await next();
  };
  const client = {
    core: { resolveTransactionPlugin: () => plugin },
    getCurrentSystemState: async () => ({
      systemState: {
        epoch,
        epochStartTimestampMs: String(Date.now() - 10000),
        parameters: { epochDurationMs: "86400000" },
      },
    }),
    getObject: async () => ({
      object: {
        ...DYNAMIC_COIN_REF,
        objectId:
          "0x0000000000000000000000000000000000000000000000000000000000000abc",
        owner: { $kind: "AddressOwner", AddressOwner: AGENT },
        type: `0x2::coin::Coin<${DYNAMIC_COIN_TYPE}>`,
      },
    }),
    getReferenceGasPrice: async () => {
      rgpReads++;
      return { referenceGasPrice: String(RGP) };
    },
    executeTransaction: async (input: {
      transaction: Uint8Array;
      signatures: string[];
    }) => {
      executions.push(input);
      return result(abort);
    },
    simulateTransaction: async (input: { transaction: Uint8Array }) => {
      simulations.push(input.transaction);
      return {
        ...result(abort),
        gasPaymentMocked: false,
        commandResults: undefined,
      };
    },
  } as unknown as SuiGrpcClient;
  return {
    client,
    executions,
    simulations,
    signer: {
      address,
      signTransaction: async (bytes: Uint8Array) => {
        signs++;
        expect(bytes.length).toBeGreaterThan(0);
        return { signature: "agentSig" };
      },
    },
    counts: () => ({ builds, signs, rgpReads }),
    setEpoch: (e: string) => {
      epoch = e;
    },
  };
}
const gasSui: GasConfig = { mode: "sui", maxGasBudget: CAP, gasBudget: CAP };
function executor(
  h: ReturnType<typeof harness>,
  gas: GasConfig = gasSui,
  http = new AfHttp(),
) {
  return new AfExecutor({
    client: h.client,
    http,
    signer: h.signer,
    gas,
    allowedPackageIds: [PACKAGE],
  });
}
test("sui kind sets sender, RGP, budget then gates, signs and submits once", async () => {
  const h = harness();
  const receipt = await executor(h).submit(builtKind);
  expect(h.counts()).toEqual({ builds: 1, signs: 1, rgpReads: 1 });
  expect(h.executions[0]?.signatures).toEqual(["agentSig"]);
  const tx = Transaction.from(
    h.executions[0]?.transaction ?? new Uint8Array(),
  ).getData();
  expect(tx.gasData.price).toBe("100");
  expect(tx.gasData.budget).toBe(String(CAP));
  expect(receipt).toMatchObject({
    digest: "synthetic-digest",
    status: "success",
    gasUsed: 140n,
    updatedPremiumTwap: true,
    simulated: false,
  });
});
test("gas-pool uses exact returned full data and signature order without rebuild", async () => {
  const h = harness();
  const bytes = await synthetic({ owner: SPONSOR, pool: true }).build();
  const sponsor = {
    walletAddress: SPONSOR,
    bytes: "terms",
    signature: "termsSig",
  };
  const gas: GasConfig = {
    mode: "gas-pool",
    sponsor,
    gasPoolPackageId: POOL,
    maxGasBudget: CAP,
  };
  await executor(h, gas).submit(async (s) => {
    expect(s).toEqual(sponsor);
    return { txKind: toBase64(bytes), sponsorSignature: "poolSig" };
  });
  expect(h.counts().builds).toBe(0);
  expect(h.executions[0]?.transaction).toEqual(bytes);
  expect(h.executions[0]?.signatures).toEqual(["agentSig", "poolSig"]);
});
test("dynamic-gas posts transaction JSON with sender and signs unchanged returned bytes", async () => {
  const h = harness();
  const { bytes } = await dynamicSuffix();
  let requests = 0;
  const http = new AfHttp({
    fetch: (async (url, init) => {
      requests++;
      expect(String(url)).toBe("https://aftermath.finance/api/dynamic-gas");
      const req = JSON.parse(String(init?.body));
      expect(req.walletAddress).toBe(AGENT);
      expect(req.gasCoinType).toBe(DYNAMIC_COIN_TYPE);
      const json = JSON.parse(req.serializedTx);
      expect(json.gasData.price).toBe("100");
      expect(json.sender.endsWith("01")).toBe(true);
      return Response.json({
        txBytes: toBase64(bytes),
        sponsoredSignature: "dynamicSig",
      });
    }) as typeof fetch,
  });
  await executor(
    h,
    {
      mode: "dynamic-gas",
      gasCoinType: DYNAMIC_COIN_TYPE,
      maxDynamicGasFeeAtomic: 10n,
      maxGasBudget: CAP,
    },
    http,
  ).submit(builtKind);
  expect(requests).toBe(1);
  expect(h.counts().builds).toBe(0);
  expect(h.executions[0]?.transaction).toEqual(bytes);
  expect(h.executions[0]?.signatures).toEqual(["agentSig", "dynamicSig"]);
});
test("dynamic-gas refuses a sponsor payload that changes RGP before signing", async () => {
  const h = harness();
  const { bytes: bad } = await dynamicSuffix("coin", { gasPrice: RGP + 1n });
  const http = new AfHttp({
    fetch: (async () =>
      Response.json({
        txBytes: toBase64(bad),
        sponsoredSignature: "sig",
      })) as unknown as typeof fetch,
  });
  await expect(
    executor(
      h,
      {
        mode: "dynamic-gas",
        gasCoinType: DYNAMIC_COIN_TYPE,
        maxDynamicGasFeeAtomic: 10n,
        maxGasBudget: CAP,
      },
      http,
    ).submit(builtKind),
  ).rejects.toThrow("gas price");
  expect(h.counts().signs).toBe(0);
  expect(h.executions).toHaveLength(0);
});
for (const abort of ["41", "47"] as const)
  test(`simulate maps abort ${abort} without signing or executing`, async () => {
    const h = harness(AGENT, abort);
    const receipt = await executor(h).simulate(builtKind);
    expect(receipt.abort).toEqual({
      code: abort,
      message:
        abort === "41" ? "hasPosition mismatch" : "post-only would cross",
    });
    expect(h.counts().signs).toBe(0);
    expect(h.executions).toHaveLength(0);
    expect(h.simulations).toHaveLength(1);
  });
test("queue serializes builders as well as submissions across two instances for one wallet", async () => {
  const h = harness();
  const a = executor(h),
    b = executor(h);
  const seen: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = a.submit(async () => {
    seen.push("first build");
    await barrier;
    return builtKind();
  });
  const second = b.submit(async () => {
    seen.push("second build");
    expect(h.executions).toHaveLength(1);
    return builtKind();
  });
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(seen).toEqual(["first build"]);
  release();
  await Promise.all([first, second]);
  expect(seen).toEqual(["first build", "second build"]);
  expect(h.executions).toHaveLength(2);
});
test("queue continues after failure, submission has no automatic retry", async () => {
  const h = harness();
  let calls = 0;
  h.client.executeTransaction = (async () => {
    calls++;
    throw new Error("lost response");
  }) as SuiGrpcClient["executeTransaction"];
  const ex = executor(h);
  await expect(ex.submit(builtKind)).rejects.toThrow("lost response");
  expect(calls).toBe(1);
  await expect(ex.submit(builtKind)).rejects.toThrow("lost response");
  expect(calls).toBe(2);
});
test("gas-pool rejects missing signature, wrong sender and over-budget bytes before signing", async () => {
  const h = harness();
  const ex = executor(h, {
    mode: "gas-pool",
    sponsor: { walletAddress: SPONSOR, bytes: "terms", signature: "termsSig" },
    gasPoolPackageId: POOL,
    maxGasBudget: CAP,
  });
  await expect(ex.submit(builtKind)).rejects.toThrow("did not return");
  for (const opts of [{ sender: "0x9" }, { budget: CAP + 1n }]) {
    const bytes = await synthetic({
      owner: SPONSOR,
      pool: true,
      ...opts,
    }).build();
    await expect(
      ex.submit(async () => ({
        txKind: toBase64(bytes),
        sponsorSignature: "sig",
      })),
    ).rejects.toThrow();
  }
  expect(h.counts().signs).toBe(0);
});
test("RGP cache refreshes at epoch end with no gRPC calls before then", async () => {
  let now = 1000;
  let stateReads = 0;
  let priceReads = 0;
  const client = {
    getCurrentSystemState: async () => {
      stateReads++;
      return {
        systemState: {
          epoch: now < 2000 ? "1" : "2",
          epochStartTimestampMs: now < 2000 ? "1000" : "2000",
          parameters: { epochDurationMs: "1000" },
        },
      };
    },
    getReferenceGasPrice: async () => {
      priceReads++;
      return { referenceGasPrice: now < 2000 ? "100" : "101" };
    },
  } as unknown as SuiGrpcClient;
  const cache = new ReferenceGasPrice(client, () => now);
  expect(await cache.get()).toBe(100n);
  now = 1999;
  expect(await cache.get()).toBe(100n);
  expect(stateReads).toBe(1);
  expect(priceReads).toBe(1);
  now = 2000;
  expect(await cache.get()).toBe(101n);
  expect(stateReads).toBe(2);
  expect(priceReads).toBe(2);
  cache.invalidate();
  await cache.get();
  expect(stateReads).toBe(3);
  expect(priceReads).toBe(3);
});
test("in-memory Ed25519 keypair signs exact gated transaction bytes", async () => {
  const key = Ed25519Keypair.generate();
  const h = harness(key.toSuiAddress());
  const ex = new AfExecutor({
    client: h.client,
    http: new AfHttp(),
    gas: gasSui,
    allowedPackageIds: [PACKAGE],
    signer: {
      address: key.toSuiAddress(),
      signTransaction: (bytes) => key.signTransaction(bytes),
    },
  });
  await ex.submit(builtKind);
  expect(h.executions[0]?.signatures[0]?.length).toBeGreaterThan(80);
  expect(h.executions[0]?.signatures).toHaveLength(1);
});

test("dry gas-pool uses unsponsored kind and never requests sponsorship", async () => {
  const h = harness();
  const ex = executor(h, {
    mode: "gas-pool",
    sponsor: { walletAddress: SPONSOR, bytes: "terms", signature: "sig" },
    gasPoolPackageId: POOL,
    maxGasBudget: CAP,
  });
  await ex.simulate(async (s) => {
    expect(s).toBeUndefined();
    return builtKind();
  });
  expect(h.counts().signs).toBe(0);
  expect(h.simulations).toHaveLength(1);
});
test("default allowlist resolves from public all-markets package IDs", async () => {
  const { AfMarkets } = await import("../../../src/venues/aftermath/markets");
  const { fixture } = await import("./helpers");
  const { stringifyAf } = await import("../../../src/venues/aftermath/http");
  const h = harness();
  const publicMarkets = (await fixture("all-markets")) as {
    markets: { packageId: string }[];
  };
  const http = new AfHttp({
    fetch: (async () =>
      new Response(stringifyAf(publicMarkets))) as unknown as typeof fetch,
  });
  // Return a real public package ID but no private object/cap/addresses.
  const kind = synthetic();
  const actualPackage = publicMarkets.markets[0]?.packageId;
  if (!actualPackage) throw new Error("Missing public package");
  const data = kind.getData();
  for (const c of data.commands)
    if (c.$kind === "MoveCall") c.MoveCall.package = actualPackage;
  const encoded = await Transaction.from(JSON.stringify(data)).build({
    onlyTransactionKind: true,
  });
  await new AfExecutor({
    client: h.client,
    http,
    signer: h.signer,
    gas: gasSui,
    marketSource: {
      markets: new AfMarkets(http),
      collateralCoinType: "synthetic",
    },
  }).submit(async () => ({
    txKind: toBase64(encoded),
    sponsorSignature: null,
  }));
  expect(h.executions).toHaveLength(1);
});

for (const shape of ["balance", "balance-split"] as const)
  test(`executor accepts unchanged dynamic ${shape} suffix without coin-object reads`, async () => {
    const h = harness();
    let coinReads = 0;
    h.client.getObject = (async () => {
      coinReads++;
      throw new Error("Unexpected coin lookup");
    }) as SuiGrpcClient["getObject"];
    const { bytes } = await dynamicSuffix(shape);
    const http = new AfHttp({
      fetch: (async () =>
        Response.json({
          txBytes: toBase64(bytes),
          sponsoredSignature: "balanceSig",
        })) as unknown as typeof fetch,
    });
    await executor(
      h,
      {
        mode: "dynamic-gas",
        gasCoinType: DYNAMIC_COIN_TYPE,
        maxDynamicGasFeeAtomic: 10n,
        maxGasBudget: CAP,
      },
      http,
    ).submit(builtKind);
    expect(coinReads).toBe(0);
    expect(h.counts().builds).toBe(0);
    expect(h.executions[0]?.transaction).toEqual(bytes);
    expect(h.executions[0]?.signatures).toEqual(["agentSig", "balanceSig"]);
  });
test("executor rejects foreign coin ownership from independent gRPC read before signing", async () => {
  const h = harness();
  h.client.getObject = (async () => ({
    object: {
      ...DYNAMIC_COIN_REF,
      owner: { $kind: "AddressOwner", AddressOwner: SPONSOR },
      type: `0x2::coin::Coin<${DYNAMIC_COIN_TYPE}>`,
    },
  })) as unknown as SuiGrpcClient["getObject"];
  const { bytes } = await dynamicSuffix();
  const http = new AfHttp({
    fetch: (async () =>
      Response.json({
        txBytes: toBase64(bytes),
        sponsoredSignature: "sig",
      })) as unknown as typeof fetch,
  });
  await expect(
    executor(
      h,
      {
        mode: "dynamic-gas",
        gasCoinType: DYNAMIC_COIN_TYPE,
        maxDynamicGasFeeAtomic: 10n,
        maxGasBudget: CAP,
      },
      http,
    ).submit(builtKind),
  ).rejects.toThrow("ownership");
  expect(h.counts().signs).toBe(0);
  expect(h.executions).toHaveLength(0);
});
test("executor requires explicit dynamic gas fee cap at configuration", () => {
  const h = harness();
  expect(() =>
    executor(h, {
      mode: "dynamic-gas",
      gasCoinType: DYNAMIC_COIN_TYPE,
      maxGasBudget: CAP,
    } as GasConfig),
  ).toThrow("fee cap");
});
