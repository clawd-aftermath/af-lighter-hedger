# af-lighter-hedger

A Bun and TypeScript delta-neutral maker/hedger: post-only quotes on Aftermath on the funding-receiving side, each fill hedged on Lighter, profitable-only by default. It runs against public feeds in paper mode and uses dedicated trading credentials for dry and live modes.

Experimental software. Positions can lose money or be liquidated even when the combined exposure is neutral. Paper results do not establish live profitability. This is not financial advice.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Account setup](#account-setup)
- [CLI reference](#cli-reference)
- [How hedging works](#how-hedging-works)
- [Safety features](#safety-features)
- [Adding a market](#adding-a-market)
- [Operator guides](#operator-guides)
- [Development](#development)
- [License and third-party notices](#license-and-third-party-notices)

## Requirements

- Bun 1.3.x (1.3.14 is pinned; this release supports `>=1.3.0 <1.4.0`).
- Network access to Aftermath HTTP/WebSocket, Sui gRPC and Lighter HTTP/WebSocket.
- For dry/live: an Aftermath perpetuals account and a dedicated Sui agent wallet; a Lighter account and a registered API key at index 4–254; USDC collateral on both venues.
- Gas funding for Aftermath: SUI on the agent wallet by default, or a funded GasPool. See [gas setup](docs/gas.md).

Paper mode uses live public data and needs no keys or deposits. Keep the host clock synchronized.

## Quick start

Clone this repository, enter it, then:

```sh
bun install --frozen-lockfile
cp config/config.example.yaml config/config.yaml
cp config/markets.example.yaml config/markets.yaml
cp .env.example .env
chmod 600 .env
```

Bun loads `.env` from the working directory. Leave the key values blank for paper. Never commit credentials; use a private environment file or your supervisor's secret mechanism. Edit the YAML before using your accounts: set `aftermath.accountId`, `lighter.accountIndex`, `lighter.apiKeyIndex` and the actual `lighter.tier`. Use your agent key, never an owner/admin key, for `AF_AGENT_PRIVATE_KEY`.

Dry/live require explicit values for every [strategy tunable](docs/configuration.md#strategy) in your YAML; the bot ships no tuned defaults.

Keep one enabled market initially. Start with a $50 clip and a $100 position cap, provided `markets check` confirms the market minimum allows it. These are exposure limits, not required deposit amounts. Check margin separately, and retain reserves on each venue.

```sh
bun src/cli/main.ts doctor --config config/config.yaml --markets-file config/markets.yaml
bun src/cli/main.ts markets list --config config/config.yaml --markets-file config/markets.yaml
bun src/cli/main.ts markets check BTC --config config/config.yaml --markets-file config/markets.yaml
bun src/cli/main.ts run --mode paper --markets BTC --config config/config.yaml --markets-file config/markets.yaml
```

`doctor` prints PASS/WARN/FAIL with fixes. Missing keys are WARN in paper mode; account checks are skipped. Before dry/live, configure the accounts and both secrets, change `mode` in the YAML to `dry`, and rerun `doctor`. Resolve every FAIL and investigate each WARN. A successful doctor result is a readiness check, not permission to leave a bot unattended.

Stop paper with Ctrl-C. Observe fills, hedges, feed freshness, breaker state and P&L. Then run dry with both keys:

```sh
bun src/cli/main.ts run --mode dry --markets BTC --config config/config.yaml --markets-file config/markets.yaml
```

Dry mode exercises transaction construction and Aftermath simulation without submitting orders; it still uses simulated trading state. It does not prove live execution, account collateral adequacy, or sponsored-gas success. Aftermath dry simulation uses self-paid SUI gas, including when live gas is configured as GasPool or dynamic gas. It may need agent SUI for simulation.

When ready, stop dry, select `mode: live` in the YAML, rerun doctor and market checks, verify both apps and use small limits:

```sh
bun src/cli/main.ts run --mode live --confirm-live --markets BTC --config config/config.yaml --markets-file config/markets.yaml
```

Live mode can submit orders only with `--confirm-live`. Monitor the first fills and hedge results in both apps. Ctrl-C/SIGTERM cancels Aftermath quotes and verifies cancellation; it leaves positions open. Closing positions requires `flatten` or manual action. Do not start multiple writers using the same agent or Lighter API key.

Testnet: `profile: testnet` selects both venues' testnets, but as of 2026-10-09 the only symbol listed on both is BTC, and the Aftermath testnet BTC market had an empty order book and stale funding, so a meaningful testnet run was not possible. Plan the first live run on mainnet with one market at the smallest clip both venues accept (Lighter's minimum order is $10), small `risk.maxUnhedgedUsd` and `risk.maxTotalNotionalUsd`, and `cancel-all`/`flatten` ready. Confirm in `status` that every fill has a matching hedge.

Always pass both file flags: without them the CLI uses built-in defaults, not `config/config.yaml` or `config/markets.yaml`. `run` defaults to paper regardless of the YAML `mode`; the other existing control commands use the YAML mode. Use the same configuration, working directory and state path for a running bot and its controls.

## Account setup

1. In the [Aftermath app](https://aftermath.finance), use the owner wallet to create a perpetuals account and deposit USDC. Record the account ID.
2. Create a separate Sui agent wallet. From the owner wallet, grant it trading access to that account. Account creation, deposits and agent grants are manual owner-wallet actions. [Aftermath agent documentation](https://docs.aftermath.finance/perpetuals/architecture/account/agent-wallets).
3. Fund the agent with SUI, or create/fund a GasPool and grant the agent access from the pool owner's wallet. See [gas.md](docs/gas.md). Owner keys stay off the bot host.
4. In the [Lighter app](https://app.lighter.xyz), create an account, deposit USDC and register a dedicated API trading key at index 4–254. Configure the account index and tier. See [Lighter accounts](docs/lighter-accounts.md).
5. Set only the agent and API private keys in the bot environment, then run `setup lighter check` and doctor with your YAML files.

Aftermath collateral can be assigned to a market with the guarded helper:

```sh
# Preview only; refuses with exit 2 until explicitly confirmed.
bun src/cli/main.ts setup aftermath allocate BTC 10 --config config/config.yaml --markets-file config/markets.yaml
# Requires mode: live in the selected YAML and submits a real allocation.
bun src/cli/main.ts setup aftermath allocate BTC 10 --confirm --config config/config.yaml --markets-file config/markets.yaml
```

Allocation moves existing account USDC into a market. It neither deposits new money nor changes exposure limits. Stop the bot first and verify the result in the app. Amounts accept at most six decimal places. [Official allocation units](https://docs.aftermath.finance/for-developers/typescript-sdk/products/perpetuals/account).

## CLI reference

All commands support `--help`. `--config <path>` and `--markets-file <path>` select YAML files where shown in help. Add global `--debug` or set `HEDGER_DEBUG=1` for stacks and error causes.

| Command | Purpose |
| --- | --- |
| `doctor` | Read-only config, signer, endpoints, reference gas price, agent capability, gas, authenticated Lighter tier and collateral checks. Exit 0 with no FAIL, otherwise 1. |
| `markets list [--all] [--json]` | Shared active perpetuals, sorted by absolute hourly differential. `--all` includes known excluded candidates such as BYD. Shows configured/enabled status, funding, rho, spreads, depth, OI headroom and minimums. |
| `markets check <SYMBOL>` | Validate one configured entry, joint size grid, minimum clip, hedge depth, OI, session and margin estimates. Exit 0 with no FAIL, otherwise 1. |
| `funding [--watch] [--markets BTC,ETH]` | Both venues in %/hour and simple APR, next settlement times and Lighter rate timestamp. Defaults to enabled configured markets. Watch waits 30 seconds between refreshes. |
| `setup aftermath terms-signature` | On the pool owner's machine only, read `AF_OWNER_PRIVATE_KEY` from the environment and print reusable GasPool terms YAML. |
| `setup aftermath allocate <SYMBOL> <USDC> [--confirm]` | Preview/refuse without confirmation; agent-signed allocation with confirmation and live YAML mode. |
| `setup lighter check` | Validate account index, registered API key, actual tier and tier trade-offs. |
| `run --mode paper\|dry\|live [--markets BTC,ETH] [--confirm-live]` | Run the selected mode. Live needs the confirmation flag. |
| `status` | Positions, intents, breaker and margin. |
| `pnl [--by-market]` | Persisted spread, rebates, hedge costs, gas and funding accounting. |
| `cancel-all` | Stop quoting through the persistent breaker and cancel Aftermath orders; positions remain open. |
| `flatten <SYMBOL\|all> --confirm` | Attempt to close both legs using bounded reduce-only orders. Verify residual positions. |
| `breaker reset --note "reason"` | Record an acknowledgement and clear the breaker after the cause is resolved. |

Safety refusals exit 2; other command errors exit 1. Help exits 0.

Discovery uses the engine's exact symbol/explicit-ID resolver. Aftermath funding is estimated; Lighter funding is last settled. Positive funding means longs pay shorts. Short-AF/long-Lighter differential is AF minus Lighter; the opposite side reverses that sign. APR is the hourly fraction times 8,760, without compounding, not a return forecast. Rho is the Aftermath funding period in hours. Books are snapshots and displayed depth covers only returned levels. OI headroom assumes a new flat account, before existing positions and pending orders. Inspect underlying contracts and oracle definitions manually: matching tickers are insufficient.

## How hedging works

The bot posts post-only Aftermath quotes on the funding-receiving side and sends an opposite Lighter hedge after each confirmed fill. Order sizing respects both venues' minimums and a shared base-size increment. It reconciles venue state, bounds hedge slippage, and stops opening exposure when required data or risk checks fail. Profitable-only is the default estimate; it does not guarantee realized profit.

## Safety features

- A pre-sign transaction gate checks decoded Aftermath transactions, allowed packages, sender, gas policy and transfer recipients. Order transactions must use Sui's reference gas price.
- The Aftermath agent capability cannot withdraw account collateral. The owner can revoke it. This does not protect the agent wallet's own gas or coin balances. [Agent permissions](https://docs.aftermath.finance/perpetuals/architecture/account/agent-wallets).
- The bot's Lighter signer wrapper exposes no withdrawal or transfer methods. A Lighter API key itself can request secure withdrawals to its owner's L1 address; protect it accordingly. [API-key permissions](https://apidocs.lighter.xyz/docs/api-keys).
- Exposure, daily loss, stale feeds, session closure, basis divergence and margin checks gate opening quotes. Hedge retries are bounded; unresolved hedge risk trips a persistent breaker.
- Persistent SQLite intents and reconciliation support restart recovery. Ambiguous submissions must be reconciled before retrying; keep the state database.
- Cancellation and flattening verify results. A failed cancellation or partial flatten needs operator attention.

Read the [risks](docs/risks.md) before enabling live mode.

## Adding a market

Use `markets list` to discover a shared contract, add one entry to `config/markets.yaml`, and run `markets check <SYMBOL>` with that file. Compare the underlying and index sources in both apps, then progress through paper, dry and live with small limits. BYD is a known exclusion. Keep `compressionBudgetBp: 0` for profitable-only operation. The complete [Adding a market walkthrough](docs/adding-markets.md) covers fields, overrides and disabling a market.

## Operator guides

- [Configuration](docs/configuration.md): every field, unit, default and validation range.
- [Adding markets](docs/adding-markets.md): discovery, validation and staged rollout.
- [Gas](docs/gas.md): self-paid SUI, GasPool and dynamic gas.
- [Lighter accounts](docs/lighter-accounts.md): tiers, registration and index privacy.
- [Operations](docs/operations.md): supervisors, health, alerts, controls, upgrades and top-ups.
- [Risks](docs/risks.md): failure modes and implemented mitigations.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun test test/cli
```

Operator tests use recorded public fixtures and injected fake clients. Signature tests use a throwaway key; tests submit no transactions.

## License and third-party notices

Project code is [MIT](LICENSE). The signer is built from unmodified [lighter-go](https://github.com/elliottech/lighter-go) `v1.0.10`, commit `9d38261d1a4cc5c7211b383ba07a4d6e41604708`, under Apache-2.0. The compiled WASM also includes go-ethereum code under LGPL-3.0. The Go runtime glue uses Go's BSD-style license. Preserve [NOTICE](NOTICE), [signer license](vendor/lighter-signer/LICENSE) and [third-party notices](vendor/lighter-signer/THIRD-PARTY-NOTICES.txt) when redistributing.

Rebuild with `scripts/build-lighter-signer.sh` from the pinned tag. [BUILD-INFO.json](vendor/lighter-signer/BUILD-INFO.json) records Go 1.27.2 on darwin/arm64 and the artifact hashes. An independent rebuild with that toolchain produced the identical WASM SHA-256: `7fd4741c1930bff9fcbb974ee667ef81fdb6005f51f069c512efc1a4ab1b716b`. See [signer upgrades](docs/operations.md#upgrading-the-signer); the matching runtime file must travel with the WASM.
