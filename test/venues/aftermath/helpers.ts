import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { parseAf } from "../../../src/venues/aftermath/http";
import { normalizeMarket } from "../../../src/venues/aftermath/markets";
import type { RawMarket } from "../../../src/venues/aftermath/types";

export const AGENT = "0x1";
export const SPONSOR = "0x2";
export const PACKAGE = "0x3";
export const POOL = "0x4";
export const RGP = 100n;
export const CAP = 10000000n;
export const fixture = async (name: string): Promise<unknown> =>
  parseAf(
    await Bun.file(
      new URL(`../../fixtures/aftermath/${name}.json`, import.meta.url),
    ).text(),
  );
export async function btcMarket() {
  const r = (await fixture("all-markets")) as { markets: RawMarket[] };
  return normalizeMarket(
    r.markets.find((m) => m.marketParams.baseAssetSymbol === "BTCUSD"),
  );
}
// Synthetic objects and addresses only. These fixtures never leave the tests.
export function synthetic(
  options: {
    sender?: string;
    owner?: string;
    price?: bigint;
    budget?: bigint;
    pool?: boolean;
    placement?: boolean;
  } = {},
) {
  const t = new Transaction();
  t.setSender(options.sender ?? AGENT);
  t.setGasOwner(options.owner ?? options.sender ?? AGENT);
  t.setGasPrice(options.price ?? RGP);
  t.setGasBudget(options.budget ?? CAP);
  t.setGasPayment([
    {
      objectId: "0x99",
      version: "1",
      digest: "11111111111111111111111111111111",
    },
  ]);
  const account = t.sharedObjectRef({
    objectId: "0x20",
    initialSharedVersion: "1",
    mutable: true,
  });
  const market = t.sharedObjectRef({
    objectId: "0x21",
    initialSharedVersion: "1",
    mutable: true,
  });
  const cap = t.objectRef({
    objectId: "0x22",
    version: "1",
    digest: "11111111111111111111111111111111",
  });
  t.moveCall({
    target: `${PACKAGE}::clearing_house::try_cancel_orders`,
    arguments: [account, market, cap, t.pure.vector("u128", [])],
  });
  t.moveCall({
    target: `${PACKAGE}::account::create_market_position`,
    arguments: [account, market, cap],
  });
  const session = t.moveCall({
    target: `${PACKAGE}::clearing_house::start_session`,
    arguments: [account, market, cap],
  });
  if (options.placement !== false)
    t.moveCall({
      target: `${PACKAGE}::session::place_limit_order`,
      arguments: [
        session,
        t.pure.u64(0),
        t.pure.u64(82500000000000n),
        t.pure.u64(100000n),
        t.pure.u64(2),
        t.pure.bool(false),
      ],
    });
  t.moveCall({
    target: `${PACKAGE}::clearing_house::end_session`,
    arguments: [session, account, market],
  });
  t.moveCall({ target: `${PACKAGE}::account::share`, arguments: [account] });
  if (options.pool)
    t.moveCall({
      target: `${POOL}::gas_pool::rebate_sponsor`,
      arguments: [t.gas, t.pure.address(SPONSOR)],
    });
  return t;
}
export async function builtKind() {
  return {
    txKind: toBase64(await synthetic().build({ onlyTransactionKind: true })),
    sponsorSignature: null,
  };
}

export const DYNAMIC_COIN_TYPE = "0x5::usdc::USDC";
export const DYNAMIC_COIN_REF = {
  objectId: "0xabc",
  version: "1",
  digest: "11111111111111111111111111111111",
};
export async function dynamicSuffix(
  shape: "coin" | "balance" | "balance-split" = "coin",
  options: {
    fee?: bigint;
    recipient?: string;
    owner?: string;
    reservation?: bigint;
    withdrawFrom?: "sender" | "sponsor";
    coinType?: string;
    gasPrice?: bigint;
  } = {},
) {
  const original = Transaction.fromKind(
    await synthetic().build({ onlyTransactionKind: true }),
  );
  original.setSender(AGENT);
  original.setGasPrice(RGP);
  const originalTransaction = await original.toJSON();
  const tx = Transaction.from(originalTransaction);
  tx.setGasOwner(options.owner ?? SPONSOR);
  tx.setGasPrice(options.gasPrice ?? RGP);
  tx.setGasBudget(CAP);
  tx.setGasPayment([
    { objectId: "0x99", version: "1", digest: DYNAMIC_COIN_REF.digest },
  ]);
  const fee = options.fee ?? 5n;
  const coinType = options.coinType ?? DYNAMIC_COIN_TYPE;
  const coin = {
    ...DYNAMIC_COIN_REF,
    owner: AGENT,
    objectType: `0x2::coin::Coin<${coinType}>`,
  };
  if (shape === "coin") {
    const split = tx.splitCoins(tx.objectRef(DYNAMIC_COIN_REF), [
      tx.pure.u64(fee),
    ]);
    const reimbursement = split[0];
    if (!reimbursement) throw new Error("Missing split result");
    if (!reimbursement) throw new Error("Missing reimbursement result");
    tx.transferObjects(
      [reimbursement],
      tx.pure.address(options.recipient ?? SPONSOR),
    );
  } else {
    const withdrawal = tx.withdrawal({
      amount: options.reservation ?? fee,
      type: coinType,
      from: options.withdrawFrom ?? "sender",
    });
    const redeemed = tx.moveCall({
      target: "0x2::coin::redeem_funds",
      typeArguments: [coinType],
      arguments: [withdrawal],
    });
    const reimbursement =
      shape === "balance-split"
        ? tx.splitCoins(redeemed, [tx.pure.u64(fee)])[0]
        : redeemed;
    if (!reimbursement) throw new Error("Missing reimbursement result");
    tx.transferObjects(
      [reimbursement],
      tx.pure.address(options.recipient ?? SPONSOR),
    );
  }
  return {
    tx,
    bytes: await tx.build(),
    policy: {
      originalTransaction,
      gasCoinType: DYNAMIC_COIN_TYPE,
      maxDynamicGasFeeAtomic: 10n,
      coin,
    },
  };
}
