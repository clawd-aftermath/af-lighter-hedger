import type { RuntimeConfig } from "../../src/config/schema";

// Test coefficients are explicit inputs, never production defaults.
export const configuredStrategy: RuntimeConfig["strategy"] = {
  holdHours: 8,
  eta: 0.25,
  kPhi: 1,
  kBasis: 1,
  epsInBp: 1,
  exitTakerShare: 1,
  skew: { s1: 0, s3: 0 },
  compressionBudgetBp: 0,
  allowAfTaking: false,
  placeholders: false,
  missingTunables: [],
};

// Convert parsed output back to YAML input without turning omissions explicit.
export function configInput(config: RuntimeConfig) {
  const {
    placeholders: _placeholders,
    missingTunables,
    ...strategy
  } = config.strategy;
  const input = { ...strategy, skew: { ...strategy.skew } };
  for (const field of missingTunables) {
    if (field === "skew.s1") delete (input.skew as { s1?: number }).s1;
    else if (field === "skew.s3") delete (input.skew as { s3?: number }).s3;
    else delete (input as Partial<typeof input>)[field];
  }
  return { ...config, strategy: input };
}
