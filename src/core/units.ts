import { ConfigError } from "./errors";

export const AF_SCALE = 1_000_000_000n;
export const USDC_SCALE = 1_000_000n;
export type Rounding = "down" | "up" | "nearest";

function scale(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ConfigError("Decimals must be an integer from 0 to 255");
  }
  return 10n ** BigInt(decimals);
}

// Unsigned ordinary decimals only: no exponent, whitespace, or coercion.
function decimalRatio(value: string): [bigint, bigint] {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new ConfigError("Expected a nonnegative decimal string");
  }
  const [whole = "", fraction = ""] = value.split(".");
  return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)];
}

function divide(n: bigint, d: bigint, round: Rounding): bigint {
  const q = n / d;
  const r = n % d;
  if (round === "down") return q;
  if (round === "up") return q + (r > 0n ? 1n : 0n);
  // Nearest ties round up; all input amounts are nonnegative.
  if (round === "nearest") return q + (r * 2n >= d ? 1n : 0n);
  throw new ConfigError("Invalid rounding mode");
}

function afQuantize(value: string, step: bigint, round: Rounding): bigint {
  if (typeof step !== "bigint" || step <= 0n) {
    throw new ConfigError("Tick/lot must be a positive bigint");
  }
  const [n, d] = decimalRatio(value);
  return divide(n * AF_SCALE, d * step, round) * step;
}

export function afPriceToInt(
  price: string,
  tickInt: bigint,
  round: "down" | "up",
): bigint {
  return afQuantize(price, tickInt, round);
}

export function afSizeToInt(size: string, lotInt: bigint): bigint {
  return afQuantize(size, lotInt, "down");
}

export function lighterToInt(
  value: string,
  decimals: number,
  round: Rounding,
): bigint {
  const s = scale(decimals);
  const [n, d] = decimalRatio(value);
  return divide(n * s, d, round);
}

// Canonical decimal output trims trailing zeros and supports signed balances.
export function lighterFromInt(x: bigint, decimals: number): string {
  const s = scale(decimals);
  if (typeof x !== "bigint") throw new ConfigError("Expected a bigint");
  const absolute = x < 0n ? -x : x;
  const whole = absolute / s;
  const fraction = (absolute % s)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${x < 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function afIntToDecimal(x: bigint): string {
  return lighterFromInt(x, 9);
}

export function toBigIntN(x: bigint): string {
  if (typeof x !== "bigint") throw new ConfigError("Expected a bigint");
  return `${x}n`;
}

export function parseBigIntN(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+n?$/.test(v)) {
    return BigInt(v.endsWith("n") ? v.slice(0, -1) : v);
  }
  throw new ConfigError(
    "Expected an integer string, safe integer number, or bigint",
  );
}

export function parseIdString(v: unknown): bigint {
  if (typeof v === "string" && !/^\d+$/.test(v)) {
    throw new ConfigError("Expected an unsigned ID string");
  }
  const id = parseBigIntN(v);
  if (id < 0n) throw new ConfigError("ID must be nonnegative");
  return id;
}

export function usdcToInt(value: string, round: Rounding = "down"): bigint {
  return lighterToInt(value, 6, round);
}

export function usdcFromInt(x: bigint): string {
  return lighterFromInt(x, 6);
}
