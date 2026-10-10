import { z } from "zod";

const positive = z.number().finite().positive();
const nonnegative = z.number().finite().nonnegative();
const ms = positive.int().max(Number.MAX_SAFE_INTEGER);
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}$/, "expected 0x hex address");
const integerString = z
  .string()
  .regex(/^\d+$/, "expected unsigned integer string");
const url = z.url({ protocol: /^https?$/ });

export const STRATEGY_TUNABLES = [
  "holdHours",
  "eta",
  "kPhi",
  "kBasis",
  "epsInBp",
  "exitTakerShare",
  "skew.s1",
  "skew.s3",
] as const;

const runtimeConfigBaseSchema = z.strictObject({
  profile: z.enum(["mainnet", "testnet"]).default("mainnet"),
  mode: z.enum(["paper", "dry", "live"]).default("paper"),
  aftermath: z.strictObject({
    baseUrl: url.optional(),
    grpcUrl: url.optional(),
    gas: z
      .strictObject({
        mode: z.enum(["sui", "gas-pool", "dynamic-gas"]).default("sui"),
        gasPoolPackageId: address.optional(),
        gasPool: z
          .strictObject({
            ownerAddress: address,
            termsBytesB64: z
              .string()
              .min(1)
              .regex(
                /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
                "expected base64",
              ),
            termsSignature: z.string().min(1),
            gasBudgetMist: integerString.optional(),
          })
          .optional(),
        dynamicGas: z
          .strictObject({
            coinType: z.string().min(1),
            maxFeeAtomic: integerString.optional(),
          })
          .optional(),
        maxGasBudgetMist: integerString.default("100000000"),
      })
      .superRefine((gas, ctx) => {
        if (gas.mode === "gas-pool" && !gas.gasPool)
          ctx.addIssue({
            code: "custom",
            path: ["gasPool"],
            message: "required for gas-pool mode",
          });
        if (gas.mode === "dynamic-gas" && !gas.dynamicGas)
          ctx.addIssue({
            code: "custom",
            path: ["dynamicGas"],
            message: "required for dynamic-gas mode",
          });
        if (BigInt(gas.maxGasBudgetMist) <= 0n)
          ctx.addIssue({
            code: "custom",
            path: ["maxGasBudgetMist"],
            message: "must be positive",
          });
        if (
          gas.gasPool?.gasBudgetMist &&
          (BigInt(gas.gasPool.gasBudgetMist) <= 0n ||
            BigInt(gas.gasPool.gasBudgetMist) > BigInt(gas.maxGasBudgetMist))
        )
          ctx.addIssue({
            code: "custom",
            path: ["gasPool", "gasBudgetMist"],
            message: "must be positive and <= maxGasBudgetMist",
          });
      }),
    agentAddress: address.optional(),
    accountId: integerString.optional(),
    quoteTtlMs: ms.default(600000),
    minQuoteIntervalMs: ms.default(1000),
    heartbeatMs: ms.default(10000),
    afResnapshotMs: ms.default(15000),
    oraclePollMs: ms.max(5000).default(3000),
    minRequoteTicks: uint.default(1),
    maxRequotesPerMinute: positive.int().default(6),
  }),
  lighter: z
    .strictObject({
      baseUrl: url.optional(),
      chainId: positive.int().optional(),
      accountIndex: uint,
      apiKeyIndex: z.number().int().min(4).max(254),
      tier: z.enum(["standard", "plus", "premium"]).default("standard"),
      maxSlippageBps: nonnegative.max(400).default(50),
      emergencySlippageBps: nonnegative.max(400).default(100),
    })
    .refine((l) => l.emergencySlippageBps >= l.maxSlippageBps, {
      path: ["emergencySlippageBps"],
      message: "must be >= maxSlippageBps",
    }),
  strategy: z
    .strictObject({
      holdHours: positive.optional(),
      eta: nonnegative.max(1).optional(),
      kPhi: nonnegative.optional(),
      kBasis: nonnegative.optional(),
      epsInBp: nonnegative.optional(),
      exitTakerShare: nonnegative.max(1).optional(),
      skew: z
        .strictObject({
          s1: nonnegative.optional(),
          s3: nonnegative.optional(),
        })
        .optional(),
      compressionBudgetBp: nonnegative.default(0),
      allowAfTaking: z.boolean().default(false),
    })
    .prefault({})
    .transform((strategy) => {
      const missingTunables = STRATEGY_TUNABLES.filter((field) => {
        if (field === "skew.s1") return strategy.skew?.s1 === undefined;
        if (field === "skew.s3") return strategy.skew?.s3 === undefined;
        return strategy[field] === undefined;
      });
      return {
        ...strategy,
        holdHours: strategy.holdHours ?? 1,
        eta: strategy.eta ?? 0,
        kPhi: strategy.kPhi ?? 0,
        kBasis: strategy.kBasis ?? 0,
        epsInBp: strategy.epsInBp ?? 0,
        exitTakerShare: strategy.exitTakerShare ?? 0,
        skew: { s1: strategy.skew?.s1 ?? 0, s3: strategy.skew?.s3 ?? 0 },
        placeholders: missingTunables.length > 0,
        missingTunables,
      };
    }),
  risk: z
    .strictObject({
      maxUnhedgedUsd: positive.default(100),
      maxUnhedgedAgeMs: ms.default(10000),
      reconcileQuiescenceMs: ms.default(3000),
      maxReconcileDeferralMs: ms.default(15000),
      maxTotalNotionalUsd: positive.default(2000),
      dailyLossLimitUsd: positive.default(100),
      stalenessMs: z
        .strictObject({
          afBook: ms.default(30000),
          afOracle: ms.max(14999).default(10000),
          lighterBook: ms.default(10000),
          afMarket: ms.default(30000),
          lighterStats: ms.default(30000),
          liveness: ms.default(15000),
        })
        .default({
          afBook: 30000,
          afOracle: 10000,
          lighterBook: 10000,
          afMarket: 30000,
          lighterStats: 30000,
          liveness: 15000,
        }),
      basisBandBp: positive.default(50),
      minMarginHeadroomPct: nonnegative.max(100).default(20),
      pauseWhenSessionClosed: z.boolean().default(true),
    })
    .default({
      maxUnhedgedUsd: 100,
      maxUnhedgedAgeMs: 10000,
      reconcileQuiescenceMs: 3000,
      maxReconcileDeferralMs: 15000,
      maxTotalNotionalUsd: 2000,
      dailyLossLimitUsd: 100,
      stalenessMs: {
        afBook: 30000,
        afOracle: 10000,
        lighterBook: 10000,
        afMarket: 30000,
        lighterStats: 30000,
        liveness: 15000,
      },
      basisBandBp: 50,
      minMarginHeadroomPct: 20,
      pauseWhenSessionClosed: true,
    }),
});

export const runtimeConfigSchema = runtimeConfigBaseSchema.transform(
  (config) => {
    if (config.profile === "mainnet")
      config.aftermath.gas.gasPoolPackageId ??=
        "0x1defae9e3c13f8598c1a7012f1be6ae29ebbbaf1a61ee33291e4d97c8cd53016";
    const mainnet = config.profile === "mainnet";
    return {
      ...config,
      aftermath: {
        ...config.aftermath,
        baseUrl:
          config.aftermath.baseUrl ??
          (mainnet
            ? "https://aftermath.finance"
            : "https://testnet.aftermath.finance"),
        grpcUrl:
          config.aftermath.grpcUrl ??
          `https://fullnode.${config.profile}.sui.io:443`,
      },
      lighter: {
        ...config.lighter,
        baseUrl:
          config.lighter.baseUrl ??
          (mainnet
            ? "https://mainnet.zklighter.elliot.ai"
            : "https://testnet.zklighter.elliot.ai"),
        chainId: config.lighter.chainId ?? (mainnet ? 304 : 300),
      },
    };
  },
);

export const marketSchema = z
  .strictObject({
    symbol: z.string().regex(/^[A-Z0-9][A-Z0-9_-]*$/),
    enabled: z.boolean().default(true),
    aftermath: z.strictObject({
      marketId: z.union([z.literal("auto"), address]),
    }),
    lighter: z.strictObject({ marketId: z.union([z.literal("auto"), uint]) }),
    clipUsd: positive.default(50),
    maxPositionUsd: positive.default(500),
    levels: z.number().int().min(1).max(3).default(1),
    compressionBudgetBp: nonnegative.optional(),
  })
  .refine((m) => m.clipUsd <= m.maxPositionUsd, {
    path: ["clipUsd"],
    message: "must be <= maxPositionUsd",
  });

export const marketsSchema = z
  .array(marketSchema)
  .min(1)
  .superRefine((markets, ctx) => {
    const seen = new Set<string>();
    markets.forEach((m, i) => {
      if (seen.has(m.symbol))
        ctx.addIssue({
          code: "custom",
          path: [i, "symbol"],
          message: "duplicate symbol",
        });
      seen.add(m.symbol);
    });
  });

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type MarketConfig = z.infer<typeof marketSchema>;

export function strategyTunableMessage(config: RuntimeConfig): string {
  const fields = config.strategy.missingTunables
    .map((field) => `strategy.${field}`)
    .join(", ");
  return `Unset strategy tunables: ${fields}; set your own values before dry/live; see docs/configuration.md#strategy`;
}

export function parseConfig<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new Error(
      result.error.issues
        .map(
          (i) =>
            `${i.path.join(".") || "config"}: ${i.message}${i.code === "unrecognized_keys" ? ` (${i.keys.join(", ")})` : ""}`,
        )
        .join("; "),
    );
  return result.data;
}
