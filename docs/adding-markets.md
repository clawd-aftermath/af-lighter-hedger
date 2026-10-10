# Adding a market

Markets belong in `config/markets.yaml`, one YAML entry per symbol. Always pass `--markets-file config/markets.yaml`; the CLI otherwise uses its built-in four-market list. Runtime settings belong in `config/config.yaml` and require `--config config/config.yaml`.

## Discover candidates

```sh
bun src/cli/main.ts markets list --config config/config.yaml --markets-file config/markets.yaml
bun src/cli/main.ts markets list --all --json --config config/config.yaml --markets-file config/markets.yaml
```

The command lists shared active perpetuals using the same resolver as the engine. Automatic Aftermath resolution uses its base symbol with the trailing USD removed; Lighter uses its exact symbol. Explicit IDs override symbol discovery. Ambiguous matches cannot resolve.

The output includes both hourly funding rates and simple APR, the two direction differentials, Aftermath rho in hours, spreads, Aftermath bid/ask depth within 1% of mid, Lighter depth within the configured hedge bound and the impact of a $500 clip, Aftermath OI headroom, minimum sizes, session and configured/enabled status. It sorts by absolute differential. BYD is excluded normally and shown with a warning under `--all`; do not enable it.

Aftermath rates are estimates and Lighter rates are the last settled hourly rates with a timestamp. A high differential is not an approval to trade. Depth includes only the levels returned by the venues and can change before an order arrives. A full discovery sweep makes many public requests; run it sparingly on a Standard account or shared IP.

## Add one entry

For example, add ETH only if discovery shows that both contracts resolve:

```yaml
- symbol: ETH
  enabled: true
  aftermath:
    marketId: auto
  lighter:
    marketId: auto
  clipUsd: 50
  maxPositionUsd: 100
  levels: 1
  compressionBudgetBp: 0
```

| Field | Meaning |
| --- | --- |
| `symbol` | Unique uppercase identifier. Use the exact shared symbol; aliases are not inferred. |
| `enabled` | `true` by default. `false` excludes this entry from a run. |
| `aftermath.marketId` | Required: `auto` or the quoted Sui market object address. |
| `lighter.marketId` | Required: `auto` or a numeric Lighter market ID. |
| `clipUsd` | USD notional per quote level; positive, default 50. Must fit venue minimums after rounding. |
| `maxPositionUsd` | Maximum absolute position notional on this market; positive, default 500, at least `clipUsd`. |
| `levels` | Quote levels, 1–3; default 1. All levels share capacity limits. |
| `compressionBudgetBp` | Optional per-market budget in basis points, nonnegative. Omission inherits `strategy.compressionBudgetBp`, whose default is 0. |

Keep the compression budget at 0 for profitable-only quoting. A positive value permits that many basis points of allowance against the estimated profitability requirement; it can accept estimated losses. For a deliberate 0.5 bp allowance on one market, set `compressionBudgetBp: 0.5` on that entry. Leave other entries at 0 or omit them with a global budget of 0. This setting does not change hedge slippage or exposure limits.

## Validate

```sh
bun src/cli/main.ts markets check ETH --config config/config.yaml --markets-file config/markets.yaml
```

Resolve all FAIL lines. Check listing identity, decimals, ticks/lots and the joint size step; minimum order sizes against the rounded clip; both directions of Lighter hedge depth within `lighter.maxSlippageBps`; Aftermath OI capacity against the position cap; session/rho and margin estimates.

An underlying WARN requires manual comparison of the contract specification, index currency, share class, corporate-action handling, multiplier and oracle sources. Similar names can represent different assets. The tool cannot prove the indices are equivalent. Check the index basis when available and exclude suspicious pairs. BYD fails explicitly.

Margin estimates use Aftermath initial margin and Lighter's catalog default initial margin, with the configured headroom reserve. Actual account leverage, existing orders, positions, fees and losses can require more collateral. Check available collateral in both apps and doctor; fund each independently.

## Roll out

1. Start with one level, budget 0, a $50 clip and a $100 cap if the minimum-size check permits them. Keep global and unhedged limits small too.
2. Run `doctor`, then `run --mode paper --markets ETH` with both YAML flags. Inspect simulated fills, hedges and P&L over more than one funding settlement and through session transitions where relevant.
3. Configure the agent and API key, rerun doctor with `mode: dry` in YAML, and run `run --mode dry --markets ETH`. Dry submits no orders and cannot establish live liquidity or sponsorship reliability.
4. Stop dry. Set `mode: live` in YAML, rerun checks, verify margin/gas in the apps, and run `run --mode live --confirm-live --markets ETH` with both YAML flags. Monitor the first live fills and residual exposure.
5. Increase limits only after inspecting actual execution and costs. Revalidate when venues change contract parameters.

## Disable

Stop quoting with `cancel-all`, verify cancellation and handle any open positions. Stop the process before editing the market list. Set `enabled: false`, restart with the intended remaining markets, and rerun doctor. Disabling a market does not close either leg. Flatten or manage those positions before removing the entry; control commands need the entry to resolve its market.
