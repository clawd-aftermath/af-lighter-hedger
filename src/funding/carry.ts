import type { Side } from "../domain/types";
import { fundingIntegral } from "./model";

export interface CarryInput {
  af: { hourlyFraction: number; mean: number; kappa: number };
  lighter: { hourlyFraction: number; mean: number; kappa: number };
}

export function carryBp(side: Side, hours: number, input: CarryInput): number {
  const af = fundingIntegral(
    input.af.hourlyFraction,
    input.af.mean,
    input.af.kappa,
    hours,
  );
  const lighter = fundingIntegral(
    input.lighter.hourlyFraction,
    input.lighter.mean,
    input.lighter.kappa,
    hours,
  );
  return (side === "ASK" ? 1 : -1) * 10000 * (af - lighter);
}

export function effectiveCarryBp(
  carry: number,
  eta: number,
  kPhi: number,
  sigmaPhi: number,
  hours: number,
): number {
  if (
    ![carry, eta, kPhi, sigmaPhi, hours].every(Number.isFinite) ||
    eta < 0 ||
    eta > 1 ||
    kPhi < 0 ||
    sigmaPhi < 0 ||
    hours < 0
  )
    throw new Error("effectiveCarryBp: invalid carry/eta/kPhi/sigmaPhi/hours");
  return carry > 0
    ? (1 - eta) * carry - kPhi * sigmaPhi * Math.sqrt(hours) * 10000
    : carry;
}
