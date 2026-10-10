# Risks

Delta-neutral exposure is not a guarantee against loss. Margin, fees, execution and operational failure are separate on each venue. Use funds you can afford to lose and monitor live operation.

| Risk | Implemented mitigation | Operator responsibility |
| --- | --- | --- |
| Leg risk after an Aftermath fill | Opposite Lighter IOC hedge, shared size grid, bounded slippage, bounded retry, unhedged amount/age limits and persistent breaker | Monitor hedge receipts and residuals. A hedge can partially fill or fail; reduce limits when depth is thin. |
| Liquidation on either venue | Per-market/global notional caps and available margin/headroom gates | Maintain reserves on both venues, verify leverage and top up manually. Gains on one chain do not automatically protect the other. |
| Oracle or basis divergence | Authoritative Aftermath oracle-age checks, stale-data cancellation and a basis-deviation gate | Compare underlying/index definitions before adding a pair; matching names do not prove equivalence. BYD is a known exclusion in operator checks. |
| Funding sign or rate changes | Quotes require current venue inputs and estimated profitability; funding and status are observable | Recheck rates and actual settlements. Default profitable-only is an estimate, not a promise of realized returns. |
| Venue or feed downtime | Required-feed freshness and liveness checks, resnapshots/reconnection, cancellation on unsafe data, heartbeat breaker | Cancellation and hedging require reachable venues. Check the apps and manage positions manually if automated controls fail. |
| Key compromise | Separate Aftermath agent capability, pre-sign transaction gate and a restricted Lighter signer wrapper | Protect both keys, restrict host access and revoke from owner wallets. Agent-wallet gas funds remain exposed; a stolen trading key can still cause losses. |
| Rate limits and quotas | Tier-based token buckets, bounded/backoff reads, nonce management, outcome reconciliation | Match the actual tier, use one writer per API key, avoid excessive discovery sweeps and monitor order/volume quotas. |
| Restart or uncertain submission | SQLite intents, process lease and venue reconciliation | Keep state and WAL files, resolve unresolved intents and avoid blind retries. A different mode/account namespace is not the same trading session. |
| Session closure | Default session-closed pause/cancellation and quote expiry | Session-aware markets can reopen with gaps; examine session status and leave the pause enabled. |
| Gas depletion or sponsorship failure | Budget/fee caps, RGP gate, doctor balance checks | Replenish the selected gas source before it is depleted. Sponsored gas is not proven by dry simulation. |

Quote exposure limits include pending increases rather than only confirmed positions. The global notional limit measures Aftermath-leg positions across markets; it does not sum the two legs. The daily loss gate uses recorded trading, funding and gas accounting and is not a mark-to-market stop-loss. Feed and risk gates stop new quoting when their conditions fail; they cannot guarantee a hedge, cancellation or liquidation prevention during a venue outage. Shutdown cancels quotes but leaves positions open. Flatten can be partial; verify the remaining legs independently.

Use dedicated trading accounts with limited collateral. Keep owner/admin keys off the bot host, including the GasPool owner's key. Aftermath agents cannot withdraw account collateral, but can trade and lose it. Lighter API keys can request secure withdrawals to the owning L1 address; this bot never invokes Lighter withdrawal or transfer methods. See [official key permissions](https://apidocs.lighter.xyz/docs/api-keys) and [Aftermath agent permissions](https://docs.aftermath.finance/perpetuals/architecture/account/agent-wallets).

Paper mode simulates fills against public data and does not model every queue, delay or market response. Dry mode constructs/simulates without submission. Neither establishes live profitability or safety. Run at small limits, inspect real costs and avoid scaling from projected APR alone.
