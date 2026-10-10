import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { GasMode, SponsorConfig } from "./types";

export type GasConfig =
  | { mode: "sui"; gasBudget?: bigint; maxGasBudget: bigint }
  | {
      mode: "gas-pool";
      sponsor: SponsorConfig;
      gasPoolPackageId: string;
      maxGasBudget: bigint;
    }
  | {
      mode: "dynamic-gas";
      gasCoinType: string;
      maxDynamicGasFeeAtomic: bigint;
      gasBudget?: bigint;
      maxGasBudget: bigint;
    };
export interface GasPriceClient {
  getCurrentSystemState: SuiGrpcClient["getCurrentSystemState"];
  getReferenceGasPrice: SuiGrpcClient["getReferenceGasPrice"];
}
export class ReferenceGasPrice {
  private cached?: { epoch: string; price: bigint; expiresAt: number };
  private pending?: Promise<bigint>;
  private revision = 0;
  constructor(
    private readonly client: GasPriceClient,
    private readonly now: () => number = Date.now,
  ) {}
  get(): Promise<bigint> {
    const now = this.now();
    if (this.cached && now < this.cached.expiresAt)
      return Promise.resolve(this.cached.price);
    if (this.pending) return this.pending;
    const revision = this.revision;
    const pending = this.refresh(revision);
    this.pending = pending;
    void pending.then(
      () => {
        if (this.pending === pending) this.pending = undefined;
      },
      () => {
        if (this.pending === pending) this.pending = undefined;
      },
    );
    return pending;
  }
  private async refresh(revision: number): Promise<bigint> {
    // On an epoch boundary retry a bounded number of times; a price read that
    // finishes after epoch end is never cached against the previous epoch.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { systemState } = await this.client.getCurrentSystemState();
      const start = Number(systemState.epochStartTimestampMs);
      const duration = Number(systemState.parameters.epochDurationMs);
      const expiresAt = start + duration;
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        !Number.isSafeInteger(duration) ||
        duration <= 0 ||
        !Number.isSafeInteger(expiresAt)
      )
        throw new Error("Invalid epoch timestamps");
      if (this.now() < start) throw new Error("Clock precedes epoch start");
      if (this.now() >= expiresAt) continue;
      const { referenceGasPrice } = await this.client.getReferenceGasPrice();
      const price = BigInt(referenceGasPrice);
      if (price <= 0n) throw new Error("Invalid reference gas price");
      if (this.now() >= expiresAt) continue;
      if (revision === this.revision)
        this.cached = { epoch: systemState.epoch, price, expiresAt };
      return price;
    }
    throw new Error("Epoch ended during reference gas price reads");
  }
  invalidate(): void {
    this.revision++;
    this.cached = undefined;
    this.pending = undefined;
  }
}
export function builderSponsor(config: GasConfig): SponsorConfig | undefined {
  return config.mode === "gas-pool" ? config.sponsor : undefined;
}
export function gasMode(config: GasConfig): GasMode {
  return config.mode;
}
