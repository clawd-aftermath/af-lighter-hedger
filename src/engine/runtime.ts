import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { loadSecrets } from "../config/load";
import type { MarketConfig, RuntimeConfig } from "../config/schema";
import { alertSink } from "../ops/alerts";
import { modeLogger } from "../ops/logging";
import { dryVenues } from "../paper/dry";
import { PaperVenues } from "../paper/venues";
import type { StateStore } from "../state/store";
import {
  AfAccount,
  AfBuilders,
  AfExecutor,
  AfHttp,
  AfMarkets,
  type GasConfig,
} from "../venues/aftermath";
import {
  AuthTokens,
  LighterRest,
  LighterWs,
  loadLighterSigner,
  NonceManager,
  profiles,
  systemClock,
} from "../venues/lighter";
import { RealAfVenue, RealLighterVenue } from "./adapters";
import { Engine, SafetyRefusal } from "./engine";
import { PublicFeeds } from "./feeds";
import { resolveMarkets } from "./markets";
import { OracleReader } from "./oracle";

export function gasConfig(config: RuntimeConfig): GasConfig {
  const gas = config.aftermath.gas;
  const maxGasBudget = BigInt(gas.maxGasBudgetMist);
  if (gas.mode === "sui") return { mode: "sui", maxGasBudget };
  if (gas.mode === "gas-pool") {
    if (!gas.gasPool || !gas.gasPoolPackageId)
      throw new SafetyRefusal(
        "Gas pool terms and package id required for this profile",
      );
    return {
      mode: "gas-pool",
      maxGasBudget,
      gasPoolPackageId: gas.gasPoolPackageId,
      sponsor: {
        walletAddress: gas.gasPool.ownerAddress,
        bytes: gas.gasPool.termsBytesB64,
        signature: gas.gasPool.termsSignature,
        gasBudget: gas.gasPool.gasBudgetMist
          ? BigInt(gas.gasPool.gasBudgetMist)
          : undefined,
      },
    };
  }
  // The existing schema lacks a reimbursement fee cap, so this mode cannot
  // satisfy the executor's transaction gate. Refuse before any builder request.
  if (!gas.dynamicGas?.maxFeeAtomic)
    throw new SafetyRefusal("dynamic-gas requires maxFeeAtomic");
  return {
    mode: "dynamic-gas",
    gasCoinType: gas.dynamicGas.coinType,
    maxDynamicGasFeeAtomic: BigInt(gas.dynamicGas.maxFeeAtomic),
    maxGasBudget,
  };
}
export function runtimeSummary(
  config: RuntimeConfig,
  markets: readonly MarketConfig[],
) {
  return {
    mode: config.mode,
    profile: config.profile,
    markets: markets
      .filter((m) => m.enabled)
      .map((m) => ({
        symbol: m.symbol,
        clipUsd: m.clipUsd,
        maxPositionUsd: m.maxPositionUsd,
      })),
    maxTotalNotionalUsd: config.risk.maxTotalNotionalUsd,
    maxUnhedgedUsd: config.risk.maxUnhedgedUsd,
    gasMode: config.aftermath.gas.mode,
    lighterTier: config.lighter.tier,
  };
}
export async function createRuntime(
  config: RuntimeConfig,
  markets: readonly MarketConfig[],
  store: StateStore,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const clock = systemClock;
  store.set("accounting_capabilities", {
    afFundingPayments: config.mode === "paper" ? "paper" : "derived",
    lighterFundingPayments:
      config.mode !== "paper" ? "positionFunding" : "paper",
    gasUsd: "AF SUI index reference",
  });
  const http = new AfHttp({ baseUrl: config.aftermath.baseUrl });
  const afMarkets = new AfMarkets(http);
  const account = new AfAccount(http);
  let signer: Awaited<ReturnType<typeof loadLighterSigner>> | undefined;
  let tokens: AuthTokens | undefined;
  let keypair: Ed25519Keypair | Secp256k1Keypair | Secp256r1Keypair | undefined;
  if (config.mode !== "paper") {
    const secrets = loadSecrets(config, env);
    if (!secrets.afAgentPrivateKey || !secrets.lighterApiPrivateKey)
      throw new SafetyRefusal("Both venue keys are required in dry/live mode");
    const parsed = decodeSuiPrivateKey(secrets.afAgentPrivateKey);
    keypair =
      parsed.scheme === "ED25519"
        ? Ed25519Keypair.fromSecretKey(parsed.secretKey)
        : parsed.scheme === "Secp256k1"
          ? Secp256k1Keypair.fromSecretKey(parsed.secretKey)
          : parsed.scheme === "Secp256r1"
            ? Secp256r1Keypair.fromSecretKey(parsed.secretKey)
            : undefined;
    if (!keypair) throw new SafetyRefusal("Unsupported Sui agent key scheme");
    if (
      config.aftermath.agentAddress &&
      config.aftermath.agentAddress !== keypair.toSuiAddress()
    )
      throw new SafetyRefusal("Agent address does not match key");
    signer = await loadLighterSigner();
    signer.CreateClient(
      "",
      secrets.lighterApiPrivateKey,
      config.lighter.chainId ?? profiles[config.profile].chainId,
      config.lighter.apiKeyIndex,
      BigInt(config.lighter.accountIndex),
    );
    tokens = new AuthTokens(
      signer,
      BigInt(config.lighter.accountIndex),
      config.lighter.apiKeyIndex,
      clock,
    );
  }
  const rest = new LighterRest({
    network: config.profile,
    baseUrl: config.lighter.baseUrl,
    tier: config.lighter.tier,
    auth: tokens ? () => tokens.get().token : undefined,
  });
  const [afData, lighterData] = await Promise.all([
    afMarkets.normalized(),
    rest.orderBookDetails(),
  ]);
  const resolved = resolveMarkets(markets, afData, lighterData);
  const sui = afData.find((m) => m.baseSymbol === "SUI");
  if (sui) store.set("sui_usd_price", BigInt(Math.round(sui.indexPrice * 1e9)));
  const ws = new LighterWs({
    network: config.profile,
    url: rest.profile.wsUrl,
    auth: tokens,
    clock,
    pingMs: 5000,
    idleTimeoutMs: config.risk.stalenessMs.liveness,
    staleMs: Math.max(
      config.risk.stalenessMs.lighterBook,
      config.risk.stalenessMs.lighterStats,
    ),
  });
  let realAf: RealAfVenue | undefined;
  let realLighter: RealLighterVenue | undefined;
  const feeds = new PublicFeeds({
    markets: resolved,
    config,
    oracle: new OracleReader(
      new SuiGrpcClient({
        network: config.profile,
        baseUrl: env.SUI_GRPC_URL ?? config.aftermath.grpcUrl,
      }),
      afMarkets,
      resolved,
    ),
    afMarkets,
    afAccount: account,
    lighterRest: rest,
    lighterWs: ws,
    clock,
    accountId:
      config.mode === "live" && config.aftermath.accountId
        ? BigInt(config.aftermath.accountId)
        : undefined,
    onAfAccount: (state) => realAf?.apply(state),
    onLighterAccount: (state, snapshot) =>
      realLighter?.account.apply(state, snapshot),
  });
  const paper = new PaperVenues(
    feeds,
    resolved,
    store,
    clock,
    config.mode === "paper",
  );
  let venues = { af: paper.af, lighter: paper.lighter };
  if (config.mode !== "paper") {
    if (!keypair || !signer || config.aftermath.accountId === undefined)
      throw new SafetyRefusal(
        "Dry/live mode requires an explicit AF accountId",
      );
    const address = keypair.toSuiAddress();
    const cap = await account.agentCap(
      address,
      BigInt(config.aftermath.accountId),
    );
    if (!cap)
      throw new SafetyRefusal(
        "Selected wallet must have the account's agent cap",
      );
    const client = new SuiGrpcClient({
      network: config.profile,
      baseUrl: env.SUI_GRPC_URL ?? config.aftermath.grpcUrl,
    });
    const executor = new AfExecutor({
      client,
      http,
      signer: {
        address,
        signTransaction: (bytes) => keypair.signTransaction(bytes),
      },
      gas: gasConfig(config),
      allowedPackageIds: resolved.map((m) => m.af.packageId),
    });
    realAf = new RealAfVenue({
      markets: resolved,
      account,
      builders: new AfBuilders(http),
      executor,
      client,
      identity: {
        walletAddress: address,
        accountId: cap.accountId,
        accountCapId: cap.objectId,
      },
      feeds,
      store,
      clock,
      dry: config.mode === "dry",
    });
    const nonce = new NonceManager(
      rest,
      BigInt(config.lighter.accountIndex),
      config.lighter.apiKeyIndex,
    );
    realLighter = new RealLighterVenue({
      markets: resolved,
      rest,
      signer,
      nonce,
      ws,
      store,
      clock,
    });
    if (config.mode === "live") {
      ws.subscribeAccount(BigInt(config.lighter.accountIndex));
      ws.subscribeAccountTx(BigInt(config.lighter.accountIndex));
      ws.subscribeAccountOrders(BigInt(config.lighter.accountIndex));
      const limits = await rest.accountLimits(
        BigInt(config.lighter.accountIndex),
      );
      if (limits.userTierName.toLowerCase() !== config.lighter.tier)
        throw new SafetyRefusal(
          "Configured Lighter tier differs from the actual account tier",
        );
      venues = { af: realAf, lighter: realLighter };
    } else
      venues = dryVenues(paper, realAf, realLighter, store, () =>
        rest.nextNonce(
          BigInt(config.lighter.accountIndex),
          config.lighter.apiKeyIndex,
        ),
      );
  }
  const engine = new Engine({
    mode: config.mode,
    logger: modeLogger(
      config.mode,
      {
        level: env.HEDGER_DEBUG === "1" ? "debug" : "info",
        now: () => new Date(clock.now()),
      },
      env,
    ),
    config,
    markets: resolved,
    store,
    ...venues,
    feeds: config.mode === "live" ? feeds : paper.feeds,
    alerts: alertSink(env),
    clock,
  });
  return {
    engine,
    close: () => {
      feeds.stop();
      realLighter?.stop();
    },
  };
}
