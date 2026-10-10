import { expect, test } from "bun:test";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import {
  type GateOptions,
  gateTransaction,
} from "../../../src/venues/aftermath/tx-gate";
import {
  AGENT,
  CAP,
  dynamicSuffix,
  fixture,
  PACKAGE,
  POOL,
  RGP,
  SPONSOR,
  synthetic,
} from "./helpers";

const policy: GateOptions = {
  agentAddress: AGENT,
  allowedPackageIds: [PACKAGE],
  mode: "sui",
  referenceGasPrice: RGP,
  maxGasBudget: CAP,
};
test("allows native PTB shapes and exact RGP", async () => {
  gateTransaction(await synthetic().build(), "data", policy);
});
test("allows kind only with explicit local sender/gas context", async () => {
  const kind = await synthetic().build({ onlyTransactionKind: true });
  gateTransaction(kind, "kind", {
    ...policy,
    kindContext: { sender: AGENT, gasPrice: RGP },
  });
  expect(() => gateTransaction(kind, "kind", policy)).toThrow("wrong sender");
});
// Each matrix entry constructs and serializes locally, so the gate exercises
// real Sui 2.35 BCS rather than a JSON representation of a transaction.
for (const [name, opts, overrides] of [
  ["wrong sender", { sender: "0x9" }, {}],
  ["above RGP taker", { price: 101n }, {}],
  ["below RGP taker", { price: 99n }, {}],
  ["budget over cap", { budget: CAP + 1n }, {}],
  ["self paid with sponsor owner", { owner: SPONSOR }, {}],
  ["sponsored with agent owner", {}, { mode: "dynamic-gas" }],
  ["empty allowlist", {}, { allowedPackageIds: [] }],
  ["wrong package allowlist", {}, { allowedPackageIds: ["0x8"] }],
] as const)
  test(`deny ${name}`, async () => {
    const bytes = await synthetic(opts).build();
    expect(() =>
      gateTransaction(bytes, "data", { ...policy, ...overrides }),
    ).toThrow();
  });
test("reject foreign transfer including SplitCoins plus transfer", async () => {
  const tx = synthetic();
  const coin = tx.splitCoins(tx.gas, [tx.pure.u64(1)]);
  tx.transferObjects([coin], tx.pure.address("0x9"));
  const bytes = await tx.build();
  expect(() => gateTransaction(bytes, "data", policy)).toThrow(
    "foreign transfer",
  );
});
test("allow split and transfer to sender", async () => {
  const tx = synthetic();
  const coin = tx.splitCoins(tx.gas, [tx.pure.u64(1)]);
  tx.transferObjects([coin], tx.pure.address(AGENT));
  gateTransaction(await tx.build(), "data", policy);
});
test("reject computed recipient", async () => {
  const tx = synthetic();
  const recipient = tx.moveCall({ target: `${PACKAGE}::account::recipient` });
  tx.transferObjects([tx.gas], recipient);
  const bytes = await tx.build();
  expect(() => gateTransaction(bytes, "data", policy)).toThrow("pure address");
});
test("gas-pool permits one exact trailing rebate call", async () => {
  const bytes = await synthetic({ owner: SPONSOR, pool: true }).build();
  gateTransaction(bytes, "data", {
    ...policy,
    mode: "gas-pool",
    gasPoolPackageId: POOL,
  });
});
test("gas-pool rejects commands appended after rebate", async () => {
  const tx = synthetic({ owner: SPONSOR, pool: true });
  tx.moveCall({ target: `${PACKAGE}::account::share` });
  const bytes = await tx.build();
  expect(() =>
    gateTransaction(bytes, "data", {
      ...policy,
      mode: "gas-pool",
      gasPoolPackageId: POOL,
    }),
  ).toThrow("gas-pool command");
});
test("gas-pool rejects missing, duplicate and wrong rebate function", async () => {
  for (const variant of ["missing", "duplicate", "wrong"]) {
    const tx = synthetic({ owner: SPONSOR, pool: variant !== "missing" });
    if (variant !== "missing")
      tx.moveCall({
        target: `${POOL}::gas_pool::${variant === "duplicate" ? "rebate_sponsor" : "withdraw"}`,
      });
    const bytes = await tx.build();
    expect(() =>
      gateTransaction(bytes, "data", {
        ...policy,
        mode: "gas-pool",
        gasPoolPackageId: POOL,
      }),
    ).toThrow();
  }
});
test("sui mode rejects gas-pool call", async () => {
  const bytes = await synthetic({ pool: true }).build();
  expect(() =>
    gateTransaction(bytes, "data", { ...policy, gasPoolPackageId: POOL }),
  ).toThrow();
});
test("dynamic gas requires foreign owner and unchanged RGP", async () => {
  const ok = await dynamicSuffix();
  gateTransaction(ok.bytes, "data", {
    ...policy,
    mode: "dynamic-gas",
    dynamicGas: ok.policy,
  });
  const bad = await dynamicSuffix("coin", { gasPrice: RGP + 1n });
  expect(() =>
    gateTransaction(bad.bytes, "data", {
      ...policy,
      mode: "dynamic-gas",
      dynamicGas: bad.policy,
    }),
  ).toThrow("gas price");
});
test("reject publish and malformed/trailing BCS", async () => {
  const tx = synthetic();
  tx.publish({ modules: [], dependencies: [] });
  const bytes = await tx.build();
  expect(() => gateTransaction(bytes, "data", policy)).toThrow(
    "unsupported command",
  );
  expect(() => gateTransaction(new Uint8Array([255]), "data", policy)).toThrow(
    "invalid BCS",
  );
  const good = await synthetic().build();
  expect(() =>
    gateTransaction(new Uint8Array([...good, 0]), "data", policy),
  ).toThrow();
});
test("caller cannot bypass price check with post-only intent flag", async () => {
  const bytes = await synthetic({ price: RGP + 1n }).build();
  expect(() =>
    gateTransaction(bytes, "data", { ...policy, takesLiquidity: false }),
  ).toThrow("gas price");
});

async function realOrder() {
  const recorded = (await fixture("real-order-sanitized")) as {
    transactionDataBase64: string;
    provenance: {
      syntheticSender: string;
      commands: string[];
      originalDigest: string;
    };
    decoded: ReturnType<Transaction["getData"]>;
  };
  const tx = Transaction.from(fromBase64(recorded.transactionDataBase64));
  const packageId = tx
    .getData()
    .commands.find((c) => c.MoveCall?.module === "clearing_house")
    ?.MoveCall?.package;
  if (!packageId) throw new Error("Missing real Aftermath package");
  return {
    recorded,
    tx,
    policy: {
      ...policy,
      agentAddress: recorded.provenance.syntheticSender,
      allowedPackageIds: [packageId],
    },
  };
}
test("sanitized real BTC builder transaction passes at RGP with exact stdlib helpers", async () => {
  const real = await realOrder();
  gateTransaction(await real.tx.build(), "data", real.policy);
  expect(
    real.recorded.provenance.commands.some((c) => c.endsWith("::option::none")),
  ).toBe(true);
  expect(
    real.recorded.provenance.commands.filter((c) =>
      c.endsWith("::place_limit_order"),
    ),
  ).toHaveLength(2);
});
for (const mutation of [
  "framework-transfer",
  "foreign-recipient",
  "priority-price",
  "wrong-package",
] as const)
  test(`sanitized real tx denies ${mutation}`, async () => {
    const real = await realOrder();
    let tx = real.tx;
    if (mutation === "framework-transfer")
      tx.moveCall({
        target: "0x2::transfer::public_transfer",
        arguments: [tx.gas, tx.pure.address("0xb0b")],
      });
    if (mutation === "foreign-recipient")
      tx.transferObjects([tx.gas], tx.pure.address("0xb0b"));
    if (mutation === "priority-price") tx.setGasPrice(RGP + 1n);
    if (mutation === "wrong-package") {
      const data = tx.getData();
      const call = data.commands.find(
        (c) => c.MoveCall?.module === "clearing_house",
      )?.MoveCall;
      if (!call) throw new Error("Missing call");
      call.package = "0xdead";
      tx = Transaction.from(JSON.stringify(data));
    }
    const bytes = await tx.build();
    expect(() => gateTransaction(bytes, "data", real.policy)).toThrow();
  });
for (const helper of ["none", "some"] as const)
  test(`stdlib option::${helper} explicitly allowed`, async () => {
    const tx = synthetic();
    tx.moveCall({
      target: `0x1::option::${helper}`,
      typeArguments: ["u64"],
      arguments: helper === "some" ? [tx.pure.u64(1)] : [],
    });
    gateTransaction(await tx.build(), "data", policy);
  });
for (const target of [
  "0x1::vector::empty",
  "0x1::option::destroy_some",
  "0x2::transfer::public_transfer",
  "0x2::coin::split",
] as const)
  test(`deny non-allowlisted system helper ${target}`, async () => {
    const tx = synthetic();
    tx.moveCall({ target });
    const bytes = await tx.build();
    expect(() =>
      gateTransaction(bytes, "data", {
        ...policy,
        allowedPackageIds: [PACKAGE, "0x1", "0x2"],
      }),
    ).toThrow("outside allowlist");
  });
for (const shape of ["coin", "balance", "balance-split"] as const) {
  test(`dynamic-gas accepts exact ${shape} reimbursement suffix`, async () => {
    const d = await dynamicSuffix(shape);
    gateTransaction(d.bytes, "data", {
      ...policy,
      mode: "dynamic-gas",
      dynamicGas: d.policy,
    });
  });
  test(`dynamic-gas rejects over-cap ${shape} fee`, async () => {
    const d = await dynamicSuffix(shape, { fee: 11n });
    expect(() =>
      gateTransaction(d.bytes, "data", {
        ...policy,
        mode: "dynamic-gas",
        dynamicGas: d.policy,
      }),
    ).toThrow("fee exceeds cap");
  });
  test(`dynamic-gas rejects ${shape} recipient unequal to gas owner`, async () => {
    const d = await dynamicSuffix(shape, { recipient: "0xb0b" });
    expect(() =>
      gateTransaction(d.bytes, "data", {
        ...policy,
        mode: "dynamic-gas",
        dynamicGas: d.policy,
      }),
    ).toThrow("recipient");
  });
  test(`dynamic-gas rejects ${shape} agent reimbursement`, async () => {
    const d = await dynamicSuffix(shape, { recipient: AGENT });
    expect(() =>
      gateTransaction(d.bytes, "data", {
        ...policy,
        mode: "dynamic-gas",
        dynamicGas: d.policy,
      }),
    ).toThrow("recipient");
  });
  test(`dynamic-gas rejects command after ${shape} suffix`, async () => {
    const d = await dynamicSuffix(shape);
    d.tx.moveCall({ target: `${PACKAGE}::clearing_house::share` });
    const bytes = await d.tx.build();
    expect(() =>
      gateTransaction(bytes, "data", {
        ...policy,
        mode: "dynamic-gas",
        dynamicGas: d.policy,
      }),
    ).toThrow();
  });
}
test("dynamic-gas rejects changed prefix input and changed prefix command", async () => {
  const d = await dynamicSuffix();
  for (const mutation of ["input", "command"]) {
    const data = d.tx.getData();
    if (mutation === "input") {
      const pure = data.inputs.find((i) => i.Pure)?.Pure;
      if (!pure) throw new Error("Missing pure");
      pure.bytes = "AQAAAAAAAAA=";
    } else {
      const call = data.commands.find((c) => c.MoveCall)?.MoveCall;
      if (!call) throw new Error("Missing call");
      call.function = "withdraw";
    }
    const bytes = await Transaction.from(JSON.stringify(data)).build();
    expect(() =>
      gateTransaction(bytes, "data", {
        ...policy,
        mode: "dynamic-gas",
        dynamicGas: d.policy,
      }),
    ).toThrow("original inputs or commands changed");
  }
});
test("dynamic-gas requires independent sender-owned coin type/version/digest metadata", async () => {
  const d = await dynamicSuffix();
  for (const coin of [
    undefined,
    { ...d.policy.coin, owner: SPONSOR },
    { ...d.policy.coin, objectType: "0x2::coin::Coin<0x6::usd::USD>" },
    { ...d.policy.coin, version: "2" },
    { ...d.policy.coin, digest: "different" },
  ]) {
    expect(() =>
      gateTransaction(d.bytes, "data", {
        ...policy,
        mode: "dynamic-gas",
        dynamicGas: { ...d.policy, coin },
      }),
    ).toThrow();
  }
});
test("dynamic-gas rejects sponsor-sourced withdrawal, wrong type and oversized reservation", async () => {
  for (const opts of [
    { withdrawFrom: "sponsor" as const },
    { coinType: "0x6::usd::USD" },
    { reservation: 11n },
  ]) {
    const d = await dynamicSuffix("balance-split", opts);
    expect(() =>
      gateTransaction(d.bytes, "data", {
        ...policy,
        mode: "dynamic-gas",
        dynamicGas: d.policy,
      }),
    ).toThrow();
  }
});
test("dynamic-gas rejects extra inputs and a missing reimbursement suffix", async () => {
  const d = await dynamicSuffix();
  d.tx.pure.u64(3);
  const bytes = await d.tx.build();
  expect(() =>
    gateTransaction(bytes, "data", {
      ...policy,
      mode: "dynamic-gas",
      dynamicGas: d.policy,
    }),
  ).toThrow("extra dynamic gas input");
  const prefix = Transaction.from(d.policy.originalTransaction);
  prefix.setGasOwner(SPONSOR);
  prefix.setGasBudget(CAP);
  prefix.setGasPayment(synthetic().getData().gasData.payment ?? []);
  const empty = await prefix.build();
  expect(() =>
    gateTransaction(empty, "data", {
      ...policy,
      mode: "dynamic-gas",
      dynamicGas: d.policy,
    }),
  ).toThrow("original inputs or commands changed");
});

test("real native prefix is preserved in a valid dynamic-gas reimbursement", async () => {
  const real = await realOrder();
  const kind = await real.tx.build({ onlyTransactionKind: true });
  const original = Transaction.fromKind(kind);
  original.setSender(real.policy.agentAddress);
  original.setGasPrice(RGP);
  const originalTransaction = await original.toJSON();
  const tx = Transaction.from(originalTransaction);
  tx.setGasOwner(SPONSOR);
  tx.setGasBudget(CAP);
  tx.setGasPayment(synthetic().getData().gasData.payment ?? []);
  const withdrawal = tx.withdrawal({ amount: 5n, type: "0x5::usdc::USDC" });
  const coin = tx.moveCall({
    target: "0x2::coin::redeem_funds",
    typeArguments: ["0x5::usdc::USDC"],
    arguments: [withdrawal],
  });
  tx.transferObjects([coin], tx.pure.address(SPONSOR));
  gateTransaction(await tx.build(), "data", {
    ...real.policy,
    mode: "dynamic-gas",
    dynamicGas: {
      originalTransaction,
      gasCoinType: "0x5::usdc::USDC",
      maxDynamicGasFeeAtomic: 10n,
    },
  });
});
test("reimbursement cannot substitute a prefix coin, use GasCoin or transfer two objects", async () => {
  const d = await dynamicSuffix();
  const start = Transaction.from(d.policy.originalTransaction).getData()
    .commands.length;
  for (const mutation of ["prefix-result", "gas-coin", "two-objects"]) {
    const data = d.tx.getData();
    const split = data.commands[start]?.SplitCoins;
    const transfer = data.commands[start + 1]?.TransferObjects;
    if (!split || !transfer) throw new Error("Missing suffix");
    if (mutation === "prefix-result")
      split.coin = { $kind: "Result", Result: 0 };
    if (mutation === "gas-coin")
      split.coin = { $kind: "GasCoin", GasCoin: true };
    if (mutation === "two-objects")
      transfer.objects.push({ $kind: "GasCoin", GasCoin: true });
    const bytes = await Transaction.from(JSON.stringify(data)).build();
    expect(() =>
      gateTransaction(bytes, "data", {
        ...policy,
        mode: "dynamic-gas",
        dynamicGas: d.policy,
      }),
    ).toThrow();
  }
});

test("sanitized fixture BCS matches its decoded form and contains only public or synthetic IDs", async () => {
  const real = await realOrder();
  expect(real.tx.getData()).toEqual(real.recorded.decoded);
  const data = real.tx.getData();
  expect(data.sender?.endsWith("a11ce")).toBe(true);
  expect(data.gasData.owner).toBe(data.sender ?? null);
  for (const input of data.inputs) {
    const ref =
      input.Object?.ImmOrOwnedObject ??
      input.Object?.SharedObject ??
      input.Object?.Receiving;
    if (
      ref &&
      ref.objectId !==
        "0x05b5c3bea84c4b8f33cf592d899008336dcbae8c9c6c75b2f8e7b8f7878744c1"
    )
      expect(ref.objectId).toMatch(/^0x0+a000[0-9a-f]+$/);
  }
  expect(data.gasData.payment?.[0]?.objectId).toMatch(/^0x0+a9000$/);
});
