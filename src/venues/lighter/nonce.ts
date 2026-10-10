import { ConfigError, VenueError } from "../../core/errors";
import type { SignedTransaction } from "./signer";
import type { SendTxResult, Transaction, TxState } from "./types";

export interface NonceRest {
  readonly profile?: { baseUrl: string };
  nextNonce(accountIndex: bigint, apiKeyIndex: number): Promise<bigint>;
  tx(hash: string): Promise<Transaction | undefined>;
}
export type RejectionStage =
  | "api"
  | "sequencer-before-apply"
  | "sequencer-apply"
  | "matching";
// core-concepts.md: rejection phase, not an error code alone, determines this.
export function consumesNonce(stage: RejectionStage): boolean {
  return stage === "sequencer-apply" || stage === "matching";
}
interface KeyState {
  tail: Promise<void>;
  next?: bigint;
  blockedHash?: string;
  used: Map<string, bigint>;
}
const keys = new Map<string, KeyState>();
export interface UnknownResolution {
  transaction?: Transaction;
  status: TxState;
  nextNonce: bigint;
  usedNonce?: bigint;
  consumed?: boolean;
}
export class NonceManager {
  private state: KeyState;
  constructor(
    private rest: NonceRest,
    readonly accountIndex: bigint,
    readonly apiKeyIndex: number,
    namespace = rest.profile?.baseUrl ?? "default",
  ) {
    if (
      accountIndex < 0n ||
      accountIndex > (1n << 48n) - 1n ||
      !Number.isInteger(apiKeyIndex) ||
      apiKeyIndex < 4 ||
      apiKeyIndex > 254
    )
      throw new ConfigError("Invalid Lighter signing identity");
    const key = `${namespace}:${accountIndex}:${apiKeyIndex}`;
    let state = keys.get(key);
    if (!state) {
      state = { tail: Promise.resolve(), used: new Map() };
      keys.set(key, state);
    }
    this.state = state;
  }
  private queued<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.state.tail.then(fn);
    this.state.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  resync(): Promise<bigint> {
    return this.queued(async () => {
      if (this.state.blockedHash) {
        const resolution = await this.resolve(this.state.blockedHash);
        if (resolution.status === "pending" || resolution.status === "unknown")
          throw new VenueError(
            "Lighter nonce has an unresolved transaction",
            "lighter",
            "NONCE_BLOCKED",
          );
      }
      this.state.next = await this.rest.nextNonce(
        this.accountIndex,
        this.apiKeyIndex,
      );
      return this.state.next;
    });
  }
  recover(stage: RejectionStage, usedNonce: bigint): Promise<bigint> {
    return this.queued(async () => {
      if (this.state.blockedHash)
        throw new VenueError(
          "Resolve transaction before nonce recovery",
          "lighter",
          "NONCE_BLOCKED",
        );
      this.state.next = consumesNonce(stage) ? usedNonce + 1n : usedNonce;
      if (stage !== "api")
        this.state.next = await this.rest.nextNonce(
          this.accountIndex,
          this.apiKeyIndex,
        );
      return this.state.next;
    });
  }
  submit(
    sign: (nonce: bigint) => SignedTransaction,
    send: (tx: SignedTransaction) => Promise<SendTxResult>,
  ): Promise<{ tx: SignedTransaction; response: SendTxResult; nonce: bigint }> {
    return this.queued(async () => {
      if (this.state.blockedHash) {
        const resolution = await this.resolve(this.state.blockedHash);
        if (resolution.status === "pending" || resolution.status === "unknown")
          throw new VenueError(
            "Lighter nonce has an unresolved transaction",
            "lighter",
            "NONCE_BLOCKED",
          );
      }
      const nonce =
        this.state.next ??
        (await this.rest.nextNonce(this.accountIndex, this.apiKeyIndex));
      if (nonce > (1n << 48n) - 1n || nonce < 0n)
        throw new ConfigError("Nonce exceeds uint48 range");
      const tx = sign(nonce);
      if (!tx.txHash)
        throw new ConfigError("Signer did not return transaction hash");
      this.state.used.set(tx.txHash, nonce);
      this.state.blockedHash = tx.txHash;
      const response = await send(tx); // on transport failure keep the key blocked
      if (response.code !== 200) {
        this.state.blockedHash = undefined;
        this.state.used.delete(tx.txHash);
        this.state.next = nonce;
      } else {
        this.state.next = nonce + 1n;
      }
      return { tx, response, nonce };
    });
  }
  resolveUnknown(txHash: string): Promise<UnknownResolution> {
    return this.queued(() => this.resolve(txHash));
  }
  private async resolve(hash: string): Promise<UnknownResolution> {
    // Both checks are mandatory even when one of the endpoints is unavailable.
    const results = await Promise.allSettled([
      this.rest.tx(hash),
      this.rest.nextNonce(this.accountIndex, this.apiKeyIndex),
    ]);
    const txResult = results[0];
    const nonceResult = results[1];
    if (nonceResult.status === "rejected")
      throw new VenueError(
        "Lighter nonce resolution unavailable",
        "lighter",
        "NONCE_LOOKUP",
        true,
      );
    const nextNonce = nonceResult.value;
    const tx = txResult.status === "fulfilled" ? txResult.value : undefined;
    const usedNonce = this.state.used.get(hash) ?? tx?.nonce;
    let status: TxState = tx?.state ?? "unknown";
    if (tx && tx.hash !== hash) status = "unknown";
    if (
      tx?.nonce !== undefined &&
      usedNonce !== undefined &&
      tx.nonce !== usedNonce
    )
      status = "unknown";
    const consumed =
      usedNonce === undefined ? undefined : nextNonce > usedNonce;
    // A final status that disagrees with nextNonce needs another observation.
    if (status === "executed" && consumed === false) status = "unknown";
    if (status === "executed" || status === "failed") {
      this.state.next = nextNonce;
      if (this.state.blockedHash === hash) this.state.blockedHash = undefined;
      this.state.used.delete(hash);
    }
    return {
      status,
      nextNonce,
      usedNonce,
      consumed,
      transaction: tx?.hash === hash ? tx : undefined,
    };
  }
}
