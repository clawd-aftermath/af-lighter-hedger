import { readFileSync } from "node:fs";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { DEFAULT_CONFIG, DEFAULT_MARKETS } from "../config/defaults";
import { parseYaml } from "../config/load";
import {
  type MarketConfig,
  marketsSchema,
  parseConfig,
  type RuntimeConfig,
  runtimeConfigSchema,
} from "../config/schema";
import { AfAccount } from "../venues/aftermath/account";
import { AfHttp } from "../venues/aftermath/http";
import { AfMarkets } from "../venues/aftermath/markets";
import type {
  AccountCap,
  AccountState,
  MarketData,
  Orderbook,
} from "../venues/aftermath/types";
import { LighterRest } from "../venues/lighter/rest";
import {
  type LighterSigner,
  loadLighterSigner,
} from "../venues/lighter/signer";
import type {
  Account,
  AccountLimits,
  BookOrder,
  FundingRow,
  Market,
} from "../venues/lighter/types";
import { array, object, parseMarket } from "../venues/lighter/types";

export interface OperatorMarket extends Market {
  initialMarginFraction?: number;
  indexPrice?: number;
}

export interface OperatorOptions {
  config?: string;
  marketsFile?: string;
}
export interface OperatorClients {
  afMarkets(): Promise<MarketData[]>;
  afBooks(ids: string[]): Promise<{ marketId: string; orderbook: Orderbook }[]>;
  lighterMarkets(): Promise<OperatorMarket[]>;
  lighterBook(id: number): Promise<{ bids: BookOrder[]; asks: BookOrder[] }>;
  lighterFunding(id: number): Promise<FundingRow[]>;
  rgp(): Promise<bigint>;
  signer(): Promise<LighterSigner>;
  lighterLimits(key: string): Promise<AccountLimits>;
  lighterAccount(): Promise<Account>;
  agentCap(address: string): Promise<AccountCap | undefined>;
  afAccount(): Promise<AccountState>;
  balance(address: string, coinType: string): Promise<bigint>;
  gasPool(owner: string): Promise<{
    gasPoolId: string | null;
    balance: bigint;
    whitelistedAddresses: string[];
  }>;
}
export interface OperatorDependencies {
  env?: Readonly<Record<string, string | undefined>>;
  write?: (text: string) => void;
  clients?: (config: RuntimeConfig) => OperatorClients;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}
export function operatorSettings(options: OperatorOptions) {
  return {
    config: options.config
      ? parseConfig(
          runtimeConfigSchema,
          parseYaml(readFileSync(options.config, "utf8")),
        )
      : structuredClone(DEFAULT_CONFIG),
    markets: options.marketsFile
      ? parseConfig(
          marketsSchema,
          parseYaml(readFileSync(options.marketsFile, "utf8")),
        )
      : structuredClone(DEFAULT_MARKETS),
  };
}
export function suiKey(value: string) {
  // Do not let decoder errors echo user input.
  try {
    const key = decodeSuiPrivateKey(value);
    if (key.scheme === "ED25519")
      return Ed25519Keypair.fromSecretKey(key.secretKey);
    if (key.scheme === "Secp256k1")
      return Secp256k1Keypair.fromSecretKey(key.secretKey);
    if (key.scheme === "Secp256r1")
      return Secp256r1Keypair.fromSecretKey(key.secretKey);
  } catch {
    /* replaced by safe error below */
  }
  throw new Error(
    "Invalid Sui private key; use a supported suiprivkey encoding",
  );
}
export function operatorClients(
  config: RuntimeConfig,
  deps: OperatorDependencies,
): OperatorClients {
  if (deps.clients) return deps.clients(config);
  const env = deps.env ?? process.env;
  const http = new AfHttp({ baseUrl: config.aftermath.baseUrl });
  const af = new AfMarkets(http);
  const account = new AfAccount(http);
  const client = new SuiGrpcClient({
    network: config.profile,
    baseUrl: env.SUI_GRPC_URL ?? config.aftermath.grpcUrl,
  });
  const rest = new LighterRest({
    network: config.profile,
    baseUrl: config.lighter.baseUrl,
    tier: config.lighter.tier,
  });
  const accountId = () => {
    if (config.aftermath.accountId === undefined)
      throw new Error("Configure aftermath.accountId");
    return BigInt(config.aftermath.accountId);
  };
  return {
    afMarkets: () => af.markets(),
    afBooks: (ids) => af.orderbooks(ids),
    lighterMarkets: async () => {
      const response = await fetch(
        `${config.lighter.baseUrl}/api/v1/orderBookDetails`,
        { signal: AbortSignal.timeout(15000) },
      );
      if (!response.ok) throw new Error("Lighter catalog unavailable");
      const data = object(await response.json());
      if (data.code !== 200) throw new Error("Lighter catalog rejected");
      return array(data.order_book_details).map((value) => {
        const raw = object(value);
        const imr = Number(raw.default_initial_margin_fraction) / 10000;
        const price = Number(raw.index_price);
        return {
          ...parseMarket(raw),
          initialMarginFraction:
            Number.isFinite(imr) && imr > 0 ? imr : undefined,
          indexPrice: Number.isFinite(price) && price > 0 ? price : undefined,
        };
      });
    },
    lighterBook: (id) => rest.orderBookOrders(id, 100),
    lighterFunding: (id) => {
      const end = Math.floor((deps.now ?? Date.now)() / 1000);
      return rest.fundings(id, end - 86400, end, 24);
    },
    rgp: async () =>
      BigInt((await client.getReferenceGasPrice()).referenceGasPrice),
    signer: loadLighterSigner,
    lighterLimits: async (key) => {
      const signer = await loadLighterSigner();
      signer.CreateClient(
        "",
        key,
        config.lighter.chainId,
        config.lighter.apiKeyIndex,
        config.lighter.accountIndex,
      );
      const authenticated = new LighterRest({
        network: config.profile,
        baseUrl: config.lighter.baseUrl,
        tier: config.lighter.tier,
        auth: () =>
          signer.CreateAuthToken(
            Math.floor(Date.now() / 1000) + 600,
            config.lighter.apiKeyIndex,
            config.lighter.accountIndex,
          ).authToken,
      });
      return authenticated.accountLimits(BigInt(config.lighter.accountIndex));
    },
    lighterAccount: () => rest.account(BigInt(config.lighter.accountIndex)),
    agentCap: (address) => account.agentCap(address, accountId()),
    afAccount: async () => (await account.snapshot(accountId())).state,
    balance: async (owner, coinType) =>
      BigInt((await client.getBalance({ owner, coinType })).balance.balance),
    gasPool: (walletAddress) =>
      http.read("/api/gas-pool/pool", { walletAddress }),
  };
}
export type CheckStatus = "PASS" | "WARN" | "FAIL";
export interface Check {
  status: CheckStatus;
  name: string;
  reason: string;
  hint: string;
}
export class CheckFailure extends Error {}
export function printChecks(checks: Check[], deps: OperatorDependencies): void {
  for (const c of checks)
    (deps.write ?? console.log)(
      `${c.status} ${c.name}: ${c.reason}; ${c.hint}`,
    );
  if (checks.some((c) => c.status === "FAIL"))
    throw new CheckFailure("Operator checks failed");
}
export const defaultMarket = (symbol: string): MarketConfig =>
  marketsSchema.parse([
    { symbol, aftermath: { marketId: "auto" }, lighter: { marketId: "auto" } },
  ])[0] as MarketConfig;
