import { SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { Command } from "commander";
import { stringify } from "yaml";
import { usdcToInt } from "../../core/units";
import { SafetyRefusal } from "../../engine/engine";
import { resolveMarkets } from "../../engine/markets";
import { gasConfig } from "../../engine/runtime";
import {
  type OperatorDependencies,
  type OperatorOptions,
  operatorClients,
  operatorSettings,
  suiKey,
} from "../../ops/operator";
import { AfBuilders } from "../../venues/aftermath/builders";
import { AfExecutor } from "../../venues/aftermath/executor";
import { AfHttp } from "../../venues/aftermath/http";
import { catalog } from "./markets";

export const TERMS_MESSAGE = "Aftermath Terms and Conditions";
export async function termsSignature(deps: OperatorDependencies) {
  const write = deps.write ?? console.log;
  write(
    "Run only on the POOL OWNER's machine with bun --no-env-file and an exported AF_OWNER_PRIVATE_KEY. The owner key must never live on the bot host. Remove it from this environment when finished.",
  );
  const value = (deps.env ?? process.env).AF_OWNER_PRIVATE_KEY;
  if (!value?.trim())
    throw new Error(
      "AF_OWNER_PRIVATE_KEY is required in the process environment",
    );
  const key = suiKey(value);
  const signed = await key.signPersonalMessage(
    new TextEncoder().encode(TERMS_MESSAGE),
  );
  write(
    stringify({
      ownerAddress: key.toSuiAddress(),
      termsBytesB64: signed.bytes,
      termsSignature: signed.signature,
    }).trimEnd(),
  );
}
export async function allocate(
  symbol: string,
  amount: string,
  options: OperatorOptions & { confirm?: boolean },
  deps: OperatorDependencies,
) {
  const write = deps.write ?? console.log;
  if (!/^\d+(?:\.\d{1,6})?$/.test(amount))
    throw new Error("USDC amount must have at most six decimals");
  const atomic = usdcToInt(amount);
  if (atomic <= 0n || atomic > (1n << 64n) - 1n)
    throw new Error("USDC amount must be positive and fit u64");
  write(
    `Preview: allocate ${amount} USDC (${atomic} atomic units) to ${symbol.toUpperCase()} on Aftermath. This moves account collateral into the market.`,
  );
  // Refusal precedes key reads, client creation and any transaction builder.
  if (!options.confirm)
    throw new SafetyRefusal(
      "Allocation requires --confirm; no transaction built or submitted",
    );
  const { config, markets } = operatorSettings(options);
  if (config.mode !== "live")
    throw new SafetyRefusal(
      "Allocation requires mode: live in the selected config and --confirm",
    );
  const entry = markets.find(
    (m) => m.symbol === symbol.toUpperCase() && m.enabled,
  );
  if (!entry || entry.symbol === "BYD")
    throw new SafetyRefusal(
      "Select a configured enabled market with matching underlying",
    );
  const env = deps.env ?? process.env;
  if (!env.AF_AGENT_PRIVATE_KEY)
    throw new Error("AF_AGENT_PRIVATE_KEY is required");
  const key = suiKey(env.AF_AGENT_PRIVATE_KEY);
  const address = key.toSuiAddress();
  if (
    config.aftermath.agentAddress &&
    normalizeSuiAddress(config.aftermath.agentAddress) !== address
  )
    throw new SafetyRefusal("Agent address does not match key");
  const clients = operatorClients(config, deps);
  const data = await catalog(clients);
  const resolved = resolveMarkets([entry], data.af, data.lighter)[0];
  if (!resolved) throw new Error("Market not resolved");
  const cap = await clients.agentCap(address);
  if (
    !cap?.isAgent ||
    cap.accountId !== BigInt(config.aftermath.accountId ?? "-1")
  )
    throw new SafetyRefusal("Agent cap required for the configured account");
  const raw = data.datas.find((d) => d.market.objectId === resolved.af.id);
  if (
    !raw ||
    raw.market.collateralCoinType !== cap.collateralCoinType ||
    !/::usdc::USDC$/.test(cap.collateralCoinType)
  )
    throw new SafetyRefusal(
      "Allocation requires a matching USDC collateral market and account",
    );
  const snapshot = await clients.afAccount();
  if (
    snapshot.accountId !== cap.accountId ||
    !Number.isFinite(snapshot.availableCollateral) ||
    snapshot.availableCollateral < Number(atomic) / 1e6
  )
    throw new SafetyRefusal("Insufficient unallocated account collateral");
  write(
    `Confirmed preview: profile=${config.profile}; account=${cap.accountId}; market=${resolved.af.id}; gas=${config.aftermath.gas.mode}`,
  );
  const http = new AfHttp({ baseUrl: config.aftermath.baseUrl });
  const builder = new AfBuilders(http);
  const executor = new AfExecutor({
    client: new SuiGrpcClient({
      network: config.profile,
      baseUrl: env.SUI_GRPC_URL ?? config.aftermath.grpcUrl,
    }),
    http,
    signer: { address, signTransaction: (bytes) => key.signTransaction(bytes) },
    gas: gasConfig(config),
    allowedPackageIds: [resolved.af.packageId],
  });
  const receipt = await executor.submit((sponsor) =>
    builder.allocateCollateral({
      walletAddress: address,
      accountId: cap.accountId,
      accountCapId: cap.objectId,
      marketId: resolved.af.id,
      allocateAmount: atomic,
      sponsor,
    }),
  );
  write(`Allocation ${receipt.status}; digest=${receipt.digest}`);
  if (receipt.status !== "success")
    throw new Error("Allocation failed; inspect the digest before retrying");
}
export async function lighterCheck(
  options: OperatorOptions,
  deps: OperatorDependencies,
) {
  const { config } = operatorSettings(options);
  const write = deps.write ?? console.log;
  write(
    "Standard: 0% maker/taker; 300 ms taker and cancel; 60 REST requests/min including sends. Plus: 0.005% maker/taker; 300 ms taker/cancel, 0 ms maker; 24,000 weighted reads and 4,000 sends/min. Premium without stake: 0.0040% maker / 0.0280% taker; 140 ms taker, 0 ms maker/cancel; 24,000 weighted reads and 4,000 sends/min, with staking discounts and higher send tiers. See https://apidocs.lighter.xyz/docs/account-types and docs/lighter-accounts.md.",
  );
  const key = (deps.env ?? process.env).LIGHTER_API_PRIVATE_KEY;
  if (!key?.trim()) {
    write(
      "FAIL LIGHTER_API_PRIVATE_KEY: absent; set a registered trading key in the environment",
    );
    throw new Error("Lighter setup check failed");
  }
  const clients = operatorClients(config, deps);
  try {
    const account = await clients.lighterAccount();
    if (account.accountIndex !== BigInt(config.lighter.accountIndex))
      throw new Error();
    write(
      `PASS account index: ${config.lighter.accountIndex}; keep it private because account data is public by index`,
    );
    const limits = await clients.lighterLimits(key);
    write(
      `PASS API key index: ${config.lighter.apiKeyIndex} (4–254); accountLimits accepted auth; key registered`,
    );
    const match = limits.userTierName.toLowerCase() === config.lighter.tier;
    write(
      `${match ? "PASS" : "FAIL"} tier: actual=${limits.userTierName}, configured=${config.lighter.tier}; match lighter.tier to the account`,
    );
    if (!match) throw new Error();
  } catch {
    write(
      "FAIL Lighter setup: account, key or tier could not be verified; check registration, indices, profile and configured tier",
    );
    throw new Error("Lighter setup check failed");
  }
}
export function registerSetup(
  program: Command,
  getDeps: () => OperatorDependencies,
) {
  const setup = program
    .command("setup")
    .description("Account readiness and guarded setup helpers");
  const af = setup
    .command("aftermath")
    .description("Aftermath agent and gas setup");
  af.command("terms-signature")
    .description("Sign reusable GasPool terms on the pool owner's machine")
    .action(() => termsSignature(getDeps()));
  af.command("allocate <symbol> <usdc>")
    .description(
      "Preview and explicitly confirm allocation of account collateral",
    )
    .option("--config <path>", "Runtime YAML; must select live mode to submit")
    .option("--markets-file <path>", "Market YAML")
    .option("--confirm", "Submit the agent-signed allocation")
    .action(
      (
        symbol: string,
        usdc: string,
        options: OperatorOptions & { confirm?: boolean },
      ) => allocate(symbol, usdc, options, getDeps()),
    );
  setup
    .command("lighter")
    .description("Lighter account setup")
    .command("check")
    .description("Verify account, key registration and tier")
    .option("--config <path>", "Runtime YAML")
    .option("--markets-file <path>", "Market YAML")
    .action((options: OperatorOptions) => lighterCheck(options, getDeps()));
}
