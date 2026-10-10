import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Command, CommanderError, Option } from "commander";
import { DEFAULT_CONFIG, DEFAULT_MARKETS } from "../config/defaults";
import { loadSecrets, parseYaml } from "../config/load";
import {
  type MarketConfig,
  marketsSchema,
  parseConfig,
  type RuntimeConfig,
  runtimeConfigSchema,
  strategyTunableMessage,
} from "../config/schema";
import { SafetyRefusal } from "../engine/engine";
import { createRuntime, runtimeSummary } from "../engine/runtime";
import { serveHealth } from "../ops/health";
import { errorFields, modeLogger } from "../ops/logging";
import type { OperatorDependencies } from "../ops/operator";
import { Breaker } from "../risk/breaker";
import { enqueueControl, ProcessLease, runningProcess } from "../state/control";
import { encode, StateStore } from "../state/store";
import { registerDoctor } from "./commands/doctor";
import { registerFunding } from "./commands/funding";
import { registerMarkets } from "./commands/markets";
import { registerMeasure } from "./commands/measure";
import { registerSetup } from "./commands/setup";

export interface CliOptions {
  config?: string;
  marketsFile?: string;
  markets?: string;
  mode?: RuntimeConfig["mode"];
  confirmLive?: boolean;
  confirm?: boolean;
  byMarket?: boolean;
  note?: string;
}
export interface CliDependencies extends OperatorDependencies {
  env?: Readonly<Record<string, string | undefined>>;
  write?: (text: string) => void;
  error?: (text: string) => void;
  runtime?: typeof createRuntime;
}
export function readSettings(options: CliOptions): {
  config: RuntimeConfig;
  markets: MarketConfig[];
} {
  const config = options.config
    ? parseConfig(
        runtimeConfigSchema,
        parseYaml(readFileSync(options.config, "utf8")),
      )
    : structuredClone(DEFAULT_CONFIG);
  if (options.mode) config.mode = options.mode;
  const markets = options.marketsFile
    ? parseConfig(
        marketsSchema,
        parseYaml(readFileSync(options.marketsFile, "utf8")),
      )
    : structuredClone(DEFAULT_MARKETS);
  const selected = options.markets
    ?.split(",")
    .map((s) => s.trim().toUpperCase());
  if (
    selected?.some(
      (s) => !s || !markets.some((m) => m.symbol === s && m.enabled),
    )
  )
    throw new SafetyRefusal("--markets contains an unknown or disabled symbol");
  const result = markets.filter(
    (m) => m.enabled && (!selected || selected.includes(m.symbol)),
  );
  if (!result.length) throw new SafetyRefusal("No enabled markets selected");
  return { config, markets: result };
}
export function stateNamespace(config: RuntimeConfig): string {
  return `${config.mode}:${config.profile}:af:${config.aftermath.accountId ?? "paper"}:lighter:${config.lighter.accountIndex}`;
}
function state(
  config: RuntimeConfig,
  env: Readonly<Record<string, string | undefined>>,
): StateStore {
  const path = env.BOT_STATE_PATH ?? ".state/bot.sqlite";
  mkdirSync(dirname(path), { recursive: true });
  return new StateStore(path, stateNamespace(config));
}
export function attachSignals(
  engine: { shutdown(): Promise<void> },
  done: (code: number) => void,
): () => void {
  let shuttingDown = false;
  const handler = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void engine.shutdown().then(
      () => done(0),
      () => done(1),
    );
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}
export async function execute(
  command: string,
  argument: string | undefined,
  options: CliOptions,
  deps: CliDependencies,
): Promise<void> {
  const env = deps.env ?? process.env;
  const write = deps.write ?? console.log;
  // Confirmation precedes state creation, key loading and venue clients.
  const unconfirmedLive =
    command === "run" && options.mode === "live" && !options.confirmLive;
  let settings: ReturnType<typeof readSettings>;
  try {
    settings = readSettings(options);
  } catch (error) {
    if (unconfirmedLive)
      throw new SafetyRefusal("Live run requires --confirm-live");
    throw error;
  }
  const { config, markets } = settings;
  if (command === "run") {
    modeLogger(
      config.mode,
      { write: (line) => write(line.trimEnd()) },
      env,
    ).info("run_summary", {
      type: "run_summary",
      ...runtimeSummary(config, markets),
    });
    if (config.mode === "live" && !options.confirmLive)
      throw new SafetyRefusal("Live run requires --confirm-live");
    if (config.strategy.placeholders) {
      const message = strategyTunableMessage(config);
      if (config.mode !== "paper") throw new SafetyRefusal(message);
      modeLogger(
        config.mode,
        { write: (line) => write(line.trimEnd()) },
        env,
      ).warn(`Paper mode uses neutral placeholders. ${message}`);
    }
  }
  if (command === "flatten" && !options.confirm)
    throw new SafetyRefusal("flatten requires --confirm");
  if (command === "breaker-reset" && !options.note?.trim())
    throw new SafetyRefusal("breaker reset requires --note");
  const store = state(config, env);
  let closeRuntime: (() => void) | undefined;
  let cleanupEngine: import("../engine/engine").Engine | undefined;
  let lease: ProcessLease | undefined;
  try {
    if (command === "breaker-reset" && !runningProcess(store)) {
      const breaker = new Breaker(store, Date.now);
      breaker.reset({ acknowledged: true, note: options.note as string });
      store.set("breaker_reset_note", { note: options.note, ts: Date.now() });
      write(encode({ mode: config.mode, breaker: breaker.state }));
      return;
    }
    if (runningProcess(store)) {
      if (command === "run")
        throw new SafetyRefusal("A bot is already running for this namespace");
      if (command === "status") {
        const status = store.get("status_snapshot");
        if (!status)
          throw new SafetyRefusal("Running bot has no status snapshot yet");
        write(
          encode({
            ...(status as object),
            intents: store.intents(true),
            breaker: store.load(),
          }),
        );
        return;
      }
      if (command === "pnl") {
        write(encode(pnlFromStore(store, options.byMarket ?? false)));
        return;
      }
      const request = enqueueControl(
        store,
        command === "breaker-reset"
          ? "breaker-reset"
          : (command as "cancel-all" | "flatten"),
        command === "breaker-reset" ? options.note : argument,
      );
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const result =
          store.get<import("../state/control").ControlRequest>("control");
        if (
          result?.id === request.id &&
          (result.status === "ok" || result.status === "error")
        ) {
          if (result.status === "error")
            throw new SafetyRefusal(
              result.message ?? "Operator command failed",
            );
          write(encode(result));
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new SafetyRefusal(
        "Operator command is still pending; inspect status before retrying",
      );
    }
    if (command === "pnl") {
      write(encode(pnlFromStore(store, options.byMarket ?? false)));
      return;
    }
    if (config.mode !== "paper")
      try {
        loadSecrets(config, env);
      } catch {
        throw new SafetyRefusal("Dry/live mode requires both venue keys");
      }
    lease = new ProcessLease(store);
    lease.acquire();
    const runtime = await (deps.runtime ?? createRuntime)(
      config,
      markets,
      store,
      env,
    );
    closeRuntime = runtime.close;
    cleanupEngine = runtime.engine;
    if (command === "status") {
      await runtime.engine.options.feeds.refresh();
      write(encode(await runtime.engine.status()));
      return;
    }
    if (command === "cancel-all") {
      await runtime.engine.tripBreaker("operator_cancel_all");
      write(encode({ mode: config.mode, status: "canceled" }));
      return;
    }
    if (command === "flatten") {
      await runtime.engine.flatten(argument ?? "all", true);
      write(encode({ mode: config.mode, status: "flat", market: argument }));
      return;
    }
    await runtime.engine.start();
    const port = env.BOT_HEALTH_PORT ? Number(env.BOT_HEALTH_PORT) : 9090;
    const server = serveHealth(runtime.engine, {
      port,
      hostname: env.BOT_HEALTH_HOST ?? "127.0.0.1",
    });
    await new Promise<void>((resolve, reject) => {
      const detach = attachSignals(runtime.engine, (code) => {
        server.stop(true);
        detach();
        code === 0
          ? resolve()
          : reject(new Error("Shutdown could not verify cancellation"));
      });
    });
  } finally {
    try {
      if (cleanupEngine?.isRunning) await cleanupEngine.shutdown();
    } finally {
      try {
        closeRuntime?.();
        lease?.release();
      } finally {
        store.close();
      }
    }
  }
}
export function pnlFromStore(store: StateStore, byMarket: boolean) {
  const rows = store.pnlRows();
  const payments = store.fundingPayments();
  const symbols = byMarket
    ? [
        ...new Set([
          ...rows.map((r) => r.market),
          ...payments.map((p) => p.market),
        ]),
      ]
    : ["all"];
  return symbols.map((m) => {
    const selected = rows.filter((r) => m === "all" || r.market === m);
    const funding = payments.filter((p) => m === "all" || p.market === m);
    const sum = (key: "spread" | "rebates" | "hedgeCosts" | "gas") =>
      selected.reduce((s, r) => s + r[key], 0n);
    return {
      mode: store.namespace.split(":")[0],
      market: m,
      usdScale: 1000000000n,
      spread: sum("spread"),
      makerRebates: sum("rebates"),
      hedgeCosts: sum("hedgeCosts"),
      fundingReceived: funding
        .filter((p) => p.amount > 0n)
        .reduce((s, p) => s + p.amount, 0n),
      fundingPaid: funding
        .filter((p) => p.amount < 0n)
        .reduce((s, p) => s - p.amount, 0n),
      fundingByVenue: ["af", "lighter"].flatMap((venue) =>
        ["derived", "venue", "paper"].map((source) => ({
          venue,
          source,
          amount: funding
            .filter((p) => p.venue === venue && p.source === source)
            .reduce((sum, p) => sum + p.amount, 0n),
        })),
      ),
      gas: sum("gas"),
      accounting: store.get("accounting_capabilities"),
    };
  });
}
export function createCli(deps: CliDependencies = {}) {
  const program = new Command()
    .name("hedger")
    .description("Aftermath / Lighter hedger")
    .option("--debug", "Include stacks and error causes")
    .exitOverride();
  program.hook("preAction", () => {
    if (program.opts().debug)
      deps = {
        ...deps,
        env: { ...(deps.env ?? process.env), HEDGER_DEBUG: "1" },
      };
  });
  program.configureOutput({
    writeOut: (text) => (deps.write ?? console.log)(text.trimEnd()),
    writeErr: (text) => (deps.error ?? console.error)(text.trimEnd()),
  });
  const common = (command: Command) =>
    command
      .option("--config <path>", "Runtime YAML")
      .option("--markets-file <path>", "Market YAML");
  common(program.command("run").description("Run the bot"))
    .addOption(
      new Option("--mode <mode>", "Trading mode")
        .choices(["paper", "dry", "live"])
        .default("paper"),
    )
    .option("--markets <symbols>", "Comma-separated symbols")
    .option("--confirm-live", "Authorize live order submission")
    .action((options: CliOptions) => execute("run", undefined, options, deps));
  common(
    program
      .command("status")
      .description("Positions, intents, breaker and margin"),
  ).action((options: CliOptions) =>
    execute("status", undefined, options, deps),
  );
  common(
    program
      .command("cancel-all")
      .description("Stop quoting and cancel AF orders"),
  ).action((options: CliOptions) =>
    execute("cancel-all", undefined, options, deps),
  );
  common(
    program
      .command("flatten <symbol>")
      .description("Close both legs with bounded reduce-only orders"),
  )
    .option("--confirm", "Confirm flattening")
    .action((symbol: string, options: CliOptions) =>
      execute(
        "flatten",
        symbol.toUpperCase() === "ALL" ? "all" : symbol.toUpperCase(),
        options,
        deps,
      ),
    );
  const breaker = program.command("breaker").description("Persistent breaker");
  common(
    breaker.command("reset").description("Acknowledge and clear the breaker"),
  )
    .requiredOption("--note <text>", "Reset reason")
    .action((options: CliOptions) =>
      execute("breaker-reset", undefined, options, deps),
    );
  common(
    program
      .command("pnl")
      .description("Spread, rebates, hedge costs, funding and gas"),
  )
    .option("--by-market", "Group by market")
    .action((options: CliOptions) => execute("pnl", undefined, options, deps));
  registerDoctor(program, () => deps);
  registerMarkets(program, () => deps);
  registerMeasure(program, () => deps);
  registerFunding(program, () => deps);
  registerSetup(program, () => deps);
  return program;
}
export async function main(
  argv = process.argv,
  deps: CliDependencies = {},
): Promise<number> {
  try {
    await createCli(deps).parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError)
      return error.code === "commander.helpDisplayed" ||
        error.code === "commander.help"
        ? 0
        : 1;
    const debug =
      argv.includes("--debug") ||
      (deps.env ?? process.env).HEDGER_DEBUG === "1";
    const fields = errorFields(error, debug);
    const modeIndex = argv.indexOf("--mode");
    const mode = modeIndex >= 0 ? (argv[modeIndex + 1] ?? "paper") : "paper";
    modeLogger(
      mode,
      { write: (line) => (deps.error ?? console.error)(line.trimEnd()) },
      deps.env ?? process.env,
    ).error(`${fields.name}: ${fields.message}`, {
      type: "command_error",
      ...fields,
    });
    return error instanceof SafetyRefusal ? 2 : 1;
  }
}
if (import.meta.main) process.exitCode = await main();
