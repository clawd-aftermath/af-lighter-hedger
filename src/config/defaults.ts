import { marketsSchema, runtimeConfigSchema } from "./schema";

export const DEFAULT_CONFIG = runtimeConfigSchema.parse({
  aftermath: { gas: {} },
  lighter: { accountIndex: 0, apiKeyIndex: 4 },
});

export const DEFAULT_MARKETS = marketsSchema.parse(
  ["BTC", "ETH", "SOL", "SUI"].map((symbol) => ({
    symbol,
    aftermath: { marketId: "auto" },
    lighter: { marketId: "auto" },
  })),
);
