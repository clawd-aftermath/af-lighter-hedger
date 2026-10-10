import { normalizeSuiAddress } from "@mysten/sui/utils";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import type { Command } from "commander";
import { strategyTunableMessage } from "../../config/schema";
import { resolveMarkets } from "../../engine/markets";
import { gasConfig } from "../../engine/runtime";
import {
  type Check,
  type OperatorDependencies,
  type OperatorOptions,
  operatorClients,
  operatorSettings,
  printChecks,
  suiKey,
} from "../../ops/operator";
import { normalizeMarket } from "../../venues/aftermath/markets";

export async function doctor(
  options: OperatorOptions,
  deps: OperatorDependencies,
) {
  const checks: Check[] = [];
  const add = (
    status: Check["status"],
    name: string,
    reason: string,
    hint: string,
  ) => checks.push({ status, name, reason, hint });
  const probe = async (
    name: string,
    hint: string,
    run: () => Promise<string>,
  ) => {
    try {
      add("PASS", name, await run(), hint);
    } catch {
      add("FAIL", name, "Check could not be verified", hint);
    }
  };
  let settings: ReturnType<typeof operatorSettings>;
  try {
    settings = operatorSettings(options);
    gasConfig(settings.config);
    add(
      "PASS",
      "configuration",
      "Runtime and markets YAML valid",
      "Use --config and --markets-file for your own files",
    );
  } catch {
    add(
      "FAIL",
      "configuration",
      "Invalid or unreadable configuration",
      "Validate YAML, required fields and gas fee caps",
    );
    printChecks(checks, deps);
    return;
  }
  const { config, markets } = settings;
  add(
    config.strategy.placeholders
      ? config.mode === "paper"
        ? "WARN"
        : "FAIL"
      : "PASS",
    "strategy tunables",
    config.strategy.placeholders
      ? strategyTunableMessage(config)
      : "All tunables explicitly configured",
    "Set every strategy tunable in YAML; see docs/configuration.md#strategy",
  );
  const env = deps.env ?? process.env;
  const clients = operatorClients(config, deps);
  for (const name of ["AF_AGENT_PRIVATE_KEY", "LIGHTER_API_PRIVATE_KEY"])
    add(
      env[name]?.trim() ? "PASS" : config.mode === "paper" ? "WARN" : "FAIL",
      name,
      env[name]?.trim() ? "present" : "absent",
      "Set in the environment for dry/live; paper requires no keys",
    );
  if (env.AF_OWNER_PRIVATE_KEY)
    add(
      "FAIL",
      "owner key isolation",
      "AF_OWNER_PRIVATE_KEY is present on the bot host",
      "Remove it; generate terms only on the pool owner's machine",
    );
  await probe(
    "Lighter signer",
    "Restore the pinned WASM and matching runtime; see signer upgrade docs",
    async () => {
      await clients.signer();
      return "WASM loaded";
    },
  );
  let afData: Awaited<ReturnType<typeof clients.afMarkets>> | undefined;
  let lighterData:
    | Awaited<ReturnType<typeof clients.lighterMarkets>>
    | undefined;
  await probe(
    "Aftermath API",
    "Check baseUrl, network and User-Agent access",
    async () => {
      afData = await clients.afMarkets();
      if (!afData.length) throw new Error();
      return "Host reachable with User-Agent; markets returned";
    },
  );
  await probe(
    "Sui gRPC RGP",
    "Check grpcUrl and outbound gRPC support",
    async () => {
      const price = await clients.rgp();
      if (price <= 0n) throw new Error();
      return `${price} MIST reference gas price`;
    },
  );
  await probe(
    "Lighter API",
    "Check baseUrl and public API access",
    async () => {
      lighterData = await clients.lighterMarkets();
      if (!lighterData.length) throw new Error();
      return "Market catalog reachable";
    },
  );
  if (afData && lighterData)
    await probe(
      "market resolution",
      "Run markets check for each configured market; repair IDs or disable missing markets",
      async () => {
        const resolved = resolveMarkets(
          markets,
          afData?.map((d) => normalizeMarket(d.market, d.metadata)) ?? [],
          lighterData ?? [],
        );
        if (!resolved.length) throw new Error();
        return `${resolved.length} enabled paired markets`;
      },
    );
  const afKey = env.AF_AGENT_PRIVATE_KEY;
  if (afKey?.trim()) {
    let address: string | undefined;
    await probe(
      "AF agent key",
      "Use the agent suiprivkey and matching agentAddress",
      async () => {
        address = suiKey(afKey).toSuiAddress();
        if (
          config.aftermath.agentAddress &&
          normalizeSuiAddress(config.aftermath.agentAddress) !== address
        )
          throw new Error();
        return "Supported key and matching address";
      },
    );
    if (address) {
      const agent = address;
      await probe(
        "AF agent cap",
        "Set accountId; grant this agent from the account owner wallet in Aftermath",
        async () => {
          const cap = await clients.agentCap(agent);
          if (
            !cap?.isAgent ||
            cap.accountId !== BigInt(config.aftermath.accountId ?? "-1")
          )
            throw new Error();
          return "isAgent=true for configured account";
        },
      );
      const gas = config.aftermath.gas;
      if (gas.mode === "gas-pool")
        await probe(
          "AF gas pool terms",
          "Regenerate terms-signature on the pool owner's machine and paste its public YAML",
          async () => {
            const terms = gas.gasPool;
            if (
              !terms ||
              Buffer.from(terms.termsBytesB64, "base64").toString("utf8") !==
                "Aftermath Terms and Conditions"
            )
              throw new Error();
            const key = await verifyPersonalMessageSignature(
              Buffer.from(terms.termsBytesB64, "base64"),
              terms.termsSignature,
            );
            if (key.toSuiAddress() !== normalizeSuiAddress(terms.ownerAddress))
              throw new Error();
            return "Exact personal-message terms signed by the configured pool owner";
          },
        );
      if (gas.mode === "gas-pool")
        await probe(
          "AF gas pool",
          "Create, share, top up and whitelist the agent from the pool owner wallet",
          async () => {
            const pool = await clients.gasPool(gas.gasPool?.ownerAddress ?? "");
            if (
              !pool.gasPoolId ||
              BigInt(pool.balance) <= 0n ||
              !pool.whitelistedAddresses.some(
                (a) => normalizeSuiAddress(a) === agent,
              )
            )
              throw new Error();
            return `${pool.balance} MIST; agent whitelisted`;
          },
        );
      else
        await probe(
          gas.mode === "sui" ? "agent SUI gas" : "agent USDC gas",
          "Top up the agent gas balance separately from trading collateral",
          async () => {
            const coin =
              gas.mode === "sui" ? "0x2::sui::SUI" : gas.dynamicGas?.coinType;
            if (
              !coin ||
              (gas.mode === "dynamic-gas" && !/::usdc::USDC$/.test(coin))
            )
              throw new Error();
            const balance = await clients.balance(agent, coin);
            const minimum =
              gas.mode === "sui"
                ? BigInt(gas.maxGasBudgetMist)
                : BigInt(gas.dynamicGas?.maxFeeAtomic ?? "0");
            if (balance <= 0n || balance < minimum) throw new Error();
            return `${balance} atomic units; covers configured cap`;
          },
        );
      await probe(
        "AF collateral",
        "Deposit USDC from the owner wallet and allocate to each trading market",
        async () => {
          const account = await clients.afAccount();
          if (
            account.accountId !== BigInt(config.aftermath.accountId ?? "-1") ||
            !Number.isFinite(account.totalEquityUsd) ||
            account.totalEquityUsd <= 0 ||
            !Number.isFinite(account.availableCollateralUsd)
          )
            throw new Error();
          return `equity=${account.totalEquityUsd} USD; unallocated available=${account.availableCollateralUsd} USD`;
        },
      );
    }
  } else
    add(
      "WARN",
      "AF account checks",
      "Skipped without AF_AGENT_PRIVATE_KEY",
      "Configure the agent before dry/live",
    );
  const lighterKey = env.LIGHTER_API_PRIVATE_KEY;
  if (lighterKey?.trim()) {
    await probe(
      "Lighter API key and tier",
      "Register API key index 4–254 on the configured account; match lighter.tier",
      async () => {
        const limits = await clients.lighterLimits(lighterKey);
        if (limits.userTierName.toLowerCase() !== config.lighter.tier) {
          add(
            "FAIL",
            "Lighter tier",
            `actual=${limits.userTierName}; configured=${config.lighter.tier}`,
            "Set lighter.tier to the actual tier",
          );
        }
        return `accountLimits accepted auth; tier=${limits.userTierName}`;
      },
    );
    await probe(
      "Lighter collateral",
      "Deposit USDC into the configured Lighter account; leave margin for fees and losses",
      async () => {
        const account = await clients.lighterAccount();
        const collateral = Number(account.collateral);
        const available = Number(account.availableBalance);
        if (
          account.accountIndex !== BigInt(config.lighter.accountIndex) ||
          !Number.isFinite(collateral) ||
          collateral <= 0 ||
          !Number.isFinite(available) ||
          available <= 0
        )
          throw new Error();
        return `collateral=${collateral} USD; available=${available} USD`;
      },
    );
  } else
    add(
      "WARN",
      "Lighter account checks",
      "Skipped without LIGHTER_API_PRIVATE_KEY",
      "Register a dedicated trading key before dry/live",
    );
  printChecks(checks, deps);
}
export function registerDoctor(
  program: Command,
  getDeps: () => OperatorDependencies,
) {
  program
    .command("doctor")
    .description(
      "Read-only configuration, connectivity, keys, gas and collateral checks",
    )
    .option("--config <path>", "Runtime YAML")
    .option("--markets-file <path>", "Market YAML")
    .action((options: OperatorOptions) => doctor(options, getDeps()));
}
