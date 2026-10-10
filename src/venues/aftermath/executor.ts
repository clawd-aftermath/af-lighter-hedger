import type { SuiClientTypes } from "@mysten/sui/client";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";
import { type GasConfig, ReferenceGasPrice } from "./gas";
import type { AfHttp } from "./http";
import { type AfMarkets, marketPackageIds } from "./markets";
import {
  type DynamicGasPolicy,
  dynamicGasCoinReference,
  gateTransaction,
} from "./tx-gate";
import type { BuiltTransaction, SponsorConfig } from "./types";

export interface TransactionSigner {
  address: string;
  signTransaction(bytes: Uint8Array): Promise<{ signature: string }>;
}
export interface ExecutorOptions {
  client: SuiGrpcClient;
  http: AfHttp;
  signer: TransactionSigner;
  gas: GasConfig;
  now?: () => number;
  allowedPackageIds?: readonly string[];
  marketSource?: { markets: AfMarkets; collateralCoinType: string };
}
export interface ExecutionReceipt {
  digest: string;
  status: "success" | "failure";
  effects: SuiClientTypes.TransactionEffects;
  gasUsed: bigint;
  events: SuiClientTypes.Event[];
  updatedPremiumTwap: boolean;
  abort: { code: string | null; message: string } | null;
  simulated: boolean;
}
type Result = SuiClientTypes.TransactionResult<{ effects: true; events: true }>;
// Shared across executors: two instances for one wallet cannot bypass the queue.
const tails = new Map<string, Promise<void>>();
function serialize<T>(wallet: string, job: () => Promise<T>): Promise<T> {
  const key = normalizeSuiAddress(wallet);
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.then(job);
  const tail = result.then(
    () => {},
    () => {},
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}
export function parseExecution(
  result: Result,
  simulated = false,
): ExecutionReceipt {
  const tx =
    result.$kind === "Transaction"
      ? result.Transaction
      : result.FailedTransaction;
  const effects = tx.effects;
  if (!effects) throw new Error("gRPC response missing requested effects");
  const events = tx.events ?? [];
  const error = tx.status.error;
  const code =
    error && "MoveAbort" in error ? (error.MoveAbort?.abortCode ?? null) : null;
  const message =
    code === "41"
      ? "hasPosition mismatch"
      : code === "47"
        ? "post-only would cross"
        : (error?.message ?? "");
  return {
    digest: tx.digest,
    status: tx.status.success ? "success" : "failure",
    effects,
    gasUsed:
      BigInt(effects.gasUsed.computationCost) +
      BigInt(effects.gasUsed.storageCost) -
      BigInt(effects.gasUsed.storageRebate),
    events,
    updatedPremiumTwap: events.some(
      (e) => e.eventType.split("::").at(-1) === "UpdatedPremiumTwap",
    ),
    abort: error ? { code, message } : null,
    simulated,
  };
}
export class AfExecutor {
  private readonly gasPrice: ReferenceGasPrice;
  private packages?: readonly string[];
  constructor(private readonly options: ExecutorOptions) {
    this.gasPrice = new ReferenceGasPrice(options.client, options.now);
    this.packages = options.allowedPackageIds;
    if (
      options.gas.mode === "gas-pool" &&
      options.gas.sponsor.gasBudget !== undefined &&
      (options.gas.sponsor.gasBudget <= 0n ||
        options.gas.sponsor.gasBudget > options.gas.maxGasBudget)
    )
      throw new Error("Sponsor gas budget exceeds cap");
    if (
      options.gas.mode === "dynamic-gas" &&
      (typeof options.gas.maxDynamicGasFeeAtomic !== "bigint" ||
        options.gas.maxDynamicGasFeeAtomic < 0n)
    )
      throw new Error("Dynamic gas fee cap required");
    if (!this.packages && !options.marketSource)
      throw new Error("Package allowlist or public market source required");
    if (
      options.gas.maxGasBudget <= 0n ||
      ("gasBudget" in options.gas &&
        options.gas.gasBudget !== undefined &&
        (options.gas.gasBudget <= 0n ||
          options.gas.gasBudget > options.gas.maxGasBudget))
    )
      throw new Error("Invalid gas budget policy");
  }
  submit(
    build: (sponsor?: SponsorConfig) => Promise<BuiltTransaction>,
    beforeSubmit?: (digest: string) => void | Promise<void>,
  ): Promise<ExecutionReceipt> {
    return serialize(this.options.signer.address, () =>
      this.run(build, false, beforeSubmit),
    );
  }
  simulate(
    build: (sponsor?: SponsorConfig) => Promise<BuiltTransaction>,
  ): Promise<ExecutionReceipt> {
    return serialize(this.options.signer.address, () => this.run(build, true));
  }
  private async run(
    build: (sponsor?: SponsorConfig) => Promise<BuiltTransaction>,
    dry: boolean,
    beforeSubmit?: (digest: string) => void | Promise<void>,
  ): Promise<ExecutionReceipt> {
    const { client, http, signer, gas } = this.options;
    if (!this.packages) {
      const source = this.options.marketSource;
      if (!source) throw new Error("Missing market source");
      this.packages = marketPackageIds(
        await source.markets.allMarkets(source.collateralCoinType),
      );
    }
    const rgp = await this.gasPrice.get();
    const built = await build(
      !dry && gas.mode === "gas-pool" ? gas.sponsor : undefined,
    );
    const mode = dry ? "sui" : gas.mode;
    const policy = {
      agentAddress: signer.address,
      allowedPackageIds: this.packages,
      mode,
      referenceGasPrice: rgp,
      maxGasBudget: gas.maxGasBudget,
      gasPoolPackageId:
        gas.mode === "gas-pool" ? gas.gasPoolPackageId : undefined,
    };
    let bytes: Uint8Array;
    let sponsorSignature: string | null = null;
    let dynamicGas: DynamicGasPolicy | undefined;
    if (!dry && gas.mode === "gas-pool") {
      if (!built.sponsorSignature)
        throw new Error(
          "Gas-pool builder did not return sponsored TransactionData",
        );
      bytes = fromBase64(built.txKind);
      sponsorSignature = built.sponsorSignature;
      // No Transaction.fromKind, setter, toJSON, or rebuild on signed data.
    } else {
      if (built.sponsorSignature)
        throw new Error("Unexpected sponsored builder response");
      const kind = fromBase64(built.txKind);
      gateTransaction(kind, "kind", {
        ...policy,
        mode: "sui",
        kindContext: { sender: signer.address, gasPrice: rgp },
      });
      const tx = Transaction.fromKind(kind);
      tx.setSender(signer.address);
      tx.setGasPrice(rgp);
      if ("gasBudget" in gas && gas.gasBudget !== undefined)
        tx.setGasBudget(gas.gasBudget);
      if (!dry && gas.mode === "dynamic-gas") {
        const serializedTx = await tx.toJSON();
        const sponsored = await http.post<{
          txBytes: string;
          sponsoredSignature: string;
        }>("/api/dynamic-gas", {
          serializedTx,
          walletAddress: signer.address,
          gasCoinType: gas.gasCoinType,
        });
        if (!sponsored.txBytes || !sponsored.sponsoredSignature)
          throw new Error("Invalid dynamic-gas response");
        bytes = fromBase64(sponsored.txBytes);
        sponsorSignature = sponsored.sponsoredSignature;
        dynamicGas = {
          originalTransaction: serializedTx,
          gasCoinType: gas.gasCoinType,
          maxDynamicGasFeeAtomic: gas.maxDynamicGasFeeAtomic,
        };
        const coinRef = dynamicGasCoinReference(bytes, serializedTx);
        if (coinRef) {
          const { object } = await client.getObject({
            objectId: coinRef.objectId,
          });
          if (object.owner.$kind !== "AddressOwner")
            throw new Error("Reimbursement coin must be owned by sender");
          dynamicGas.coin = {
            objectId: object.objectId,
            version: object.version,
            digest: object.digest,
            owner: object.owner.AddressOwner,
            objectType: object.type,
          };
        }
      } else {
        bytes = await tx.build({ client });
      }
    }
    gateTransaction(bytes, "data", { ...policy, dynamicGas });
    if (dry)
      return parseExecution(
        await client.simulateTransaction({
          transaction: bytes,
          include: { effects: true, events: true },
        }),
        true,
      );
    const { signature } = await signer.signTransaction(bytes.slice());
    const signatures = sponsorSignature
      ? [signature, sponsorSignature]
      : [signature];
    await beforeSubmit?.(await Transaction.from(bytes).getDigest());
    // Exactly one submission attempt. A lost response must be reconciled by the
    // runner; blindly rebuilding/retrying could duplicate a trade.
    return parseExecution(
      await client.executeTransaction({
        transaction: bytes,
        signatures,
        include: { effects: true, events: true },
      }),
    );
  }
}
