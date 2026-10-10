function finite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`${name}: must be finite`);
}

function positive(name: string, value: number): void {
  finite(name, value);
  if (value <= 0) throw new Error(`${name}: must be positive`);
}

export function afHourly(
  premiumTwap: number,
  index: number,
  f: number,
  rhoHours: number,
): number {
  finite("premiumTwap", premiumTwap);
  positive("index", index);
  positive("f", f);
  positive("rhoHours", rhoHours);
  return ((premiumTwap / index) * f) / rhoHours;
}

// deltaHours and omegaHours use the same time unit; premiums use price units.
export function relaxedTwa(
  twaNow: number,
  outsidePremium: number,
  deltaHours: number,
  omegaHours: number,
): number {
  finite("twaNow", twaNow);
  finite("outsidePremium", outsidePremium);
  finite("deltaHours", deltaHours);
  if (deltaHours < 0) throw new Error("deltaHours: must be nonnegative");
  positive("omegaHours", omegaHours);
  return (
    outsidePremium +
    (twaNow - outsidePremium) * Math.exp(-deltaHours / omegaHours)
  );
}

export function predictAfHourly(input: {
  twaNow: number;
  outsidePremium: number;
  deltaHours: number;
  omegaHours: number;
  index: number;
  f: number;
  rhoHours: number;
}): number {
  return afHourly(
    relaxedTwa(
      input.twaNow,
      input.outsidePremium,
      input.deltaHours,
      input.omegaHours,
    ),
    input.index,
    input.f,
    input.rhoHours,
  );
}

// Values are hourly funding fractions, ordered oldest to newest.
export function ema(history: readonly number[], alpha: number): number {
  finite("alpha", alpha);
  if (alpha <= 0 || alpha > 1) throw new Error("alpha: expected (0, 1]");
  if (history.length === 0) throw new Error("history: must not be empty");
  for (const value of history) finite("history", value);
  const first = history[0];
  if (first === undefined) throw new Error("history: must not be empty");
  return history
    .slice(1)
    .reduce((mean, value) => alpha * value + (1 - alpha) * mean, first);
}

// The published signed percent/hour already includes interest; use this for carry.
export function lighterHourlyFromPublished(ratePercentPerHour: number): number {
  finite("ratePercentPerHour", ratePercentPerHour);
  return ratePercentPerHour / 100;
}

// Diagnostics only: converts the eight-hour base interest percent to an hourly fraction.
export function lighterInterestBaselineHourly(
  baseInterestRatePercent: number,
): number {
  finite("baseInterestRatePercent", baseInterestRatePercent);
  return baseInterestRatePercent / 8 / 100;
}

// Integrates an hourly fraction over H hours; kappa is inverse hours.
export function fundingIntegral(
  phi0: number,
  mean: number,
  kappa: number,
  hours: number,
): number {
  for (const [name, value] of Object.entries({ phi0, mean, kappa, hours }))
    finite(name, value);
  if (kappa < 0 || hours < 0)
    throw new Error("kappa and hours: must be nonnegative");
  if (kappa === 0) return phi0 * hours;
  return mean * hours + ((phi0 - mean) * -Math.expm1(-kappa * hours)) / kappa;
}

export function integrateHistory(input: {
  hourlyFraction: number;
  history: readonly number[];
  alpha: number;
  kappa: number;
  holdHours: number;
}): number {
  return fundingIntegral(
    input.hourlyFraction,
    ema(input.history, input.alpha),
    input.kappa,
    input.holdHours,
  );
}
