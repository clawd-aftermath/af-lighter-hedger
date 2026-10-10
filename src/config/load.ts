import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import {
  marketsSchema,
  parseConfig,
  type RuntimeConfig,
  runtimeConfigSchema,
} from "./schema";

export interface Secrets {
  afAgentPrivateKey?: string;
  lighterApiPrivateKey?: string;
}

export function parseYaml(text: string): unknown {
  const document = parseDocument(text, {
    uniqueKeys: true,
    prettyErrors: false,
  });
  if (document.errors.length)
    throw new Error(
      `YAML: ${document.errors.map((e) => e.message).join("; ")}`,
    );
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  function inspect(node: unknown, path: string): void {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      const next = path ? `${path}.${key}` : key;
      const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (
        /privatekey|secret|password|mnemonic|seed(?:phrase)?$|signingkey|credential|apikey$|accesstoken|authtoken/.test(
          normalized,
        )
      )
        throw new Error(
          `${next}: secrets are allowed only in environment variables AF_AGENT_PRIVATE_KEY and LIGHTER_API_PRIVATE_KEY`,
        );
      inspect(child, next);
    }
  }
  inspect(value, "");
  return value;
}

export function loadConfig(
  configPath: string,
  marketsPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const config = parseConfig(
    runtimeConfigSchema,
    parseYaml(readFileSync(configPath, "utf8")),
  );
  const markets = parseConfig(
    marketsSchema,
    parseYaml(readFileSync(marketsPath, "utf8")),
  );
  return { config, markets, secrets: loadSecrets(config, env) };
}

export function loadSecrets(
  config: RuntimeConfig,
  env: Readonly<Record<string, string | undefined>>,
): Secrets {
  const secrets: Secrets = {
    afAgentPrivateKey: env.AF_AGENT_PRIVATE_KEY,
    lighterApiPrivateKey: env.LIGHTER_API_PRIVATE_KEY,
  };
  if (config.mode === "live" || config.mode === "dry") {
    for (const name of [
      "AF_AGENT_PRIVATE_KEY",
      "LIGHTER_API_PRIVATE_KEY",
    ] as const) {
      if (!env[name]?.trim())
        throw new Error(`${name}: required in ${config.mode} mode`);
    }
  }
  return secrets;
}
