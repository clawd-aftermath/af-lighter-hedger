import { readFile } from "node:fs/promises";
import { ConfigError, VenueError } from "../../core/errors";

export const orderType = { LIMIT: 0, MARKET: 1 } as const;
export const timeInForce = { IOC: 0, GTT: 1, POST_ONLY: 2 } as const;
export const txType = {
  CREATE_ORDER: 14,
  CANCEL_ORDER: 15,
  CANCEL_ALL_ORDERS: 16,
  MODIFY_ORDER: 17,
  UPDATE_LEVERAGE: 20,
  GROUPED_ORDERS: 28,
  UPDATE_MARGIN: 29,
} as const;
export const MAX_CLIENT_ORDER_INDEX = (1n << 48n) - 1n;

type Int = number | bigint;
export interface APIKey {
  privateKey: string;
  publicKey: string;
}
export interface SignedTransaction {
  txType: number;
  txInfo: string;
  txHash: string;
}

// The positional API mirrors the official signer. No funds-moving wrappers.
export interface LighterSigner {
  GenerateAPIKey(): APIKey;
  CreateClient(
    url: "",
    privateKey: string,
    chainId: Int,
    apiKeyIndex: Int,
    accountIndex: Int,
  ): Record<string, never>;
  CreateAuthToken(
    deadline: Int,
    apiKeyIndex: Int,
    accountIndex: Int,
  ): { authToken: string };
  SignCreateOrder(
    marketIndex: Int,
    clientOrderIndex: Int,
    baseAmount: Int,
    price: Int,
    isAsk: Int,
    orderType: Int,
    timeInForce: Int,
    reduceOnly: Int,
    triggerPrice: Int,
    orderExpiry: Int,
    integratorAccountIndex: Int,
    integratorTakerFee: Int,
    integratorMakerFee: Int,
    selfTradeBehaviorMode: Int,
    selfTradeEqualityMode: Int,
    skipNonce: Int,
    nonce: Int,
    apiKeyIndex: Int,
    accountIndex: Int,
  ): SignedTransaction;
  SignCancelOrder(
    marketIndex: Int,
    orderIndex: Int,
    skipNonce: Int,
    nonce: Int,
    apiKeyIndex: Int,
    accountIndex: Int,
  ): SignedTransaction;
  SignCancelAllOrders(
    timeInForce: Int,
    time: Int,
    cancelAllMarketIndex: Int,
    skipNonce: Int,
    nonce: Int,
    apiKeyIndex: Int,
    accountIndex: Int,
  ): SignedTransaction;
  SignModifyOrder(
    marketIndex: Int,
    index: Int,
    baseAmount: Int,
    price: Int,
    triggerPrice: Int,
    integratorAccountIndex: Int,
    integratorTakerFee: Int,
    integratorMakerFee: Int,
    selfTradeBehaviorMode: Int,
    selfTradeEqualityMode: Int,
    skipNonce: Int,
    nonce: Int,
    orderVersion: Int,
    apiKeyIndex: Int,
    accountIndex: Int,
  ): SignedTransaction;
  SignUpdateLeverage(
    marketIndex: Int,
    fraction: Int,
    marginMode: Int,
    skipNonce: Int,
    nonce: Int,
    apiKeyIndex: Int,
    accountIndex: Int,
  ): SignedTransaction;
}

type RawFunction = (...args: (number | string)[]) => unknown;
const arities = {
  GenerateAPIKey: 0,
  CreateClient: 5,
  CreateAuthToken: 3,
  SignCreateOrder: 19,
  SignCancelOrder: 6,
  SignCancelAllOrders: 7,
  SignModifyOrder: 15,
  SignUpdateLeverage: 7,
} as const;
type FunctionName = keyof typeof arities;
interface GoRuntime {
  importObject: WebAssembly.Imports & {
    gojs: Record<string, (...args: number[]) => void>;
  };
  _scheduledTimeouts: Map<number, ReturnType<typeof setTimeout>>;
  run(instance: WebAssembly.Instance): Promise<void>;
}

function safeInteger(value: unknown): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ConfigError(
        "Signer arguments must be nonnegative safe integers",
      );
    }
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ConfigError("Signer arguments must be nonnegative safe integers");
  }
  return value;
}

function atMost(
  value: number | string | undefined,
  max: number,
  field: string,
): void {
  if (typeof value !== "number" || value > max) {
    throw new ConfigError(`${field} exceeds its signer range`);
  }
}

let singleton: Promise<LighterSigner> | undefined;

export function loadLighterSigner(): Promise<LighterSigner> {
  singleton ??= initialize();
  return singleton;
}

async function initialize(): Promise<LighterSigner> {
  const globals = globalThis as unknown as Record<string, unknown>;
  try {
    const vendor = new URL("../../../vendor/lighter-signer/", import.meta.url);
    await import(new URL("wasm_exec.js", vendor).href);
    const Go = globals.Go as new () => GoRuntime;
    const go = new Go();
    // Unref only this Go instance's timers: idle WASM must not keep Bun alive.
    // This adapter relies on the pinned, matching wasm_exec.js runtime.
    const schedule = go.importObject.gojs["runtime.scheduleTimeoutEvent"];
    if (!schedule) throw new Error("Go timer adapter missing");
    go.importObject.gojs["runtime.scheduleTimeoutEvent"] = (...args) => {
      schedule(...args);
      for (const timer of go._scheduledTimeouts.values()) timer.unref();
    };
    const bytes = await readFile(new URL("lighter-signer.wasm", vendor));
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    const before = new Set(Object.keys(globals));
    let runtimeFailure: unknown;
    void go.run(instance).catch((error: unknown) => {
      runtimeFailure = error;
    });
    const functions = {} as Record<FunctionName, RawFunction>;
    for (const name of Object.keys(arities) as FunctionName[]) {
      if (typeof globals[name] !== "function")
        throw new Error(`Missing WASM export: ${name}`);
      functions[name] = globals[name] as RawFunction;
    }
    // Keep callbacks private, including upstream exports that can move funds.
    for (const name of Object.keys(globals)) {
      if (!before.has(name) && typeof globals[name] === "function")
        delete globals[name];
    }
    let clientChainId: number | undefined;
    const wrapper: Record<string, (...args: unknown[]) => unknown> = {};
    for (const name of Object.keys(arities) as FunctionName[]) {
      wrapper[name] = (...args) => {
        if (runtimeFailure)
          throw new VenueError(
            "Go signer runtime stopped",
            "lighter",
            "WASM_RUNTIME",
            false,
            { cause: runtimeFailure },
          );
        if (args.length !== arities[name])
          throw new ConfigError(
            `${name} requires ${arities[name]} arguments; use 0 for unused fields`,
          );
        const values = args.map((value, index) => {
          if (name === "CreateClient" && index < 2) {
            if (typeof value !== "string" || (index === 0 && value !== ""))
              throw new ConfigError(
                "CreateClient requires an empty URL and a private key string",
              );
            return value;
          }
          return safeInteger(value);
        });
        if (
          name === "SignCreateOrder" ||
          name === "SignCancelOrder" ||
          name === "SignModifyOrder"
        ) {
          atMost(values[1], Number(MAX_CLIENT_ORDER_INDEX), "clientOrderIndex");
        }
        if (name === "SignCreateOrder" || name === "SignModifyOrder") {
          atMost(values[3], 0xffff_ffff, "price");
          atMost(
            values[name === "SignCreateOrder" ? 8 : 4],
            0xffff_ffff,
            "triggerPrice",
          );
        }
        if (name.startsWith("Sign") && name !== "SignCancelAllOrders")
          atMost(values[0], 0x7fff, "marketIndex");
        if (
          name === "CreateClient" &&
          clientChainId !== undefined &&
          values[2] !== clientChainId
        )
          throw new ConfigError("Cannot mix chain IDs in one WASM signer");
        const result = functions[name](...values);
        if (!result || typeof result !== "object")
          throw new VenueError(
            "Invalid signer result",
            "lighter",
            "WASM_RESULT",
          );
        if ("error" in result)
          throw new VenueError(String(result.error), "lighter", "SIGNER_ERROR");
        if (name === "CreateClient") clientChainId = values[2] as number;
        return result;
      };
    }
    return Object.freeze(wrapper) as unknown as LighterSigner;
  } catch (cause) {
    throw new VenueError(
      "Failed to load Lighter WASM signer",
      "lighter",
      "WASM_LOAD",
      false,
      { cause },
    );
  }
}
