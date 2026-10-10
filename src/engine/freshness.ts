import type { RuntimeConfig } from "../config/schema";
import type { MarketView } from "./types";
// Floors cover 3x measured p99 plus REST recovery; oracle uses source time.
export function staleReason(
  view: MarketView,
  now: number,
  config: RuntimeConfig,
): string | null {
  const limits = config.risk.stalenessMs;
  if (!view.afConnected || !view.lighterConnected) return "socket_disconnected";
  if (
    now - (view.afFrameTs ?? now) > limits.liveness ||
    now - (view.lighterFrameTs ?? now) > limits.liveness
  )
    return "socket_dead";
  if (now - view.oracleTs > limits.afOracle || view.oracleTs > now + 1000)
    return "stale_af_oracle";
  if (now - view.afBook.ts > limits.afBook) return "stale_af_book";
  if (now - view.marketTs > limits.afMarket) return "stale_af_market";
  if (now - view.lighterBook.ts > limits.lighterBook)
    return "stale_lighter_book";
  if (now - view.statsTs > limits.lighterStats || !view.fundingObserved)
    return "stale_lighter_stats";
  return null;
}
