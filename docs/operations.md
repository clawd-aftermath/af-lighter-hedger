# Operations

Use one process per account/key pair. Keep the working directory, runtime YAML, market YAML and state path stable across commands and restarts. The default database is `.state/bot.sqlite`; `BOT_STATE_PATH` overrides it. State namespaces separate paper/dry/live, profile and account identities. Keep the SQLite database and its WAL files; deleting them can destroy pending-intent and accounting evidence.

## Supervision

Run paper interactively first. A supervisor can restart the process after exit; the persistent breaker remains set until acknowledged. Do not use parallel rolling deployments with shared keys.

Example Linux systemd unit, using your own service account, install directory and Bun path:

```ini
[Unit]
Description=Aftermath Lighter hedger
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=hedger
WorkingDirectory=/srv/af-lighter-hedger
EnvironmentFile=/etc/af-lighter-hedger.env
ExecStart=/usr/local/bin/bun src/cli/main.ts run --mode live --confirm-live --config config/config.yaml --markets-file config/markets.yaml
Restart=on-failure
RestartSec=15
KillSignal=SIGTERM
TimeoutStopSec=120
UMask=0077

[Install]
WantedBy=multi-user.target
```

Install the environment file with mode 0600 and restrict access to its service account. Do not put secrets in `ExecStart`, command history or the unit text. Adjust Bun's path; it may differ from this example. Use `--mode paper` and omit the live confirmation during rehearsal. SIGTERM cancels Aftermath quotes and verifies cancellation, but leaves positions open. A forced timeout can interrupt this cleanup; inspect the apps before restarting.

## Health and alerts

The default endpoint is `http://127.0.0.1:9090/health`. `BOT_HEALTH_HOST` and `BOT_HEALTH_PORT` override the bind address and port. Keep it local or behind authenticated access. The endpoint returns JSON for mode, uptime, recovery, breaker, each market's feed ages/connections, pauses and unhedged base exposure. It returns HTTP 200 even if a breaker or stale-data condition is present; inspect the JSON, not just the status code.

```sh
curl --fail http://127.0.0.1:9090/health
bun src/cli/main.ts status --config config/config.yaml --markets-file config/markets.yaml
bun src/cli/main.ts pnl --by-market --config config/config.yaml --markets-file config/markets.yaml
```

Each log record includes its mode. Set `HEDGER_DEBUG=1` or use global `--debug` for detailed errors. Restrict logs: they can contain public account identifiers and positions. Funding accounting labels its source: paper, venue, or derived. Aftermath live funding is derived from account observations rather than independently verified payment records; compare P&L with venue statements.

Alerts always go to logs. Set both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to also receive Telegram messages. Treat delivery as best effort; failed delivery is logged. Alert handling should cover critical breaker events, stale feeds, hedge failures and cancellation failures.

## Measuring funding impact

Capture a paper run, stop it with SIGTERM or Ctrl-C, then summarize the projected book-mid premium with and without the bot's resting quotes and the implied hourly funding:

```sh
bun src/cli/main.ts run --mode paper --markets SOL,XRP,ETH,BTC --markets-file config/markets.yaml > run.ndjson
bun src/cli/main.ts measure impact --file run.ndjson
bun src/cli/main.ts measure impact --file run.ndjson --json
```

Use a markets YAML containing those enabled symbols. Means weight plans with resting orders by elapsed log time through the next plan or log end, excluding pauses and cancellations. Headlines show mean absolute premium and funding, with APR annualized from absolute hourly funding. A second line shows signed means and the positive, negative and zero shares of weighted time for the outside premium. Premium removed compares time-weighted absolute premiums (negative means an increase, zero baseline is unavailable). Improved, unchanged and worsened plan counts compare absolute premiums with a 1e-9 bp tolerance. JSON fields explicitly distinguish `absolute` and `signed` metrics. Fill counts are Aftermath fill events; hedge counts are sends. The profit-floor note identifies plans whose price constraint prevented reaching the zero-premium price. These are projections, not measured settlement rates or realized funding savings.

## Stop quoting and close positions

Use the same YAML files and state location as the running process. Set YAML `mode: live` for live control commands; they do not take `--mode`. The run command defaults to paper independently of this field.

```sh
bun src/cli/main.ts cancel-all --config config/config.yaml --markets-file config/markets.yaml
bun src/cli/main.ts status --config config/config.yaml --markets-file config/markets.yaml
bun src/cli/main.ts flatten BTC --confirm --config config/config.yaml --markets-file config/markets.yaml
# Or close every configured enabled market:
bun src/cli/main.ts flatten all --confirm --config config/config.yaml --markets-file config/markets.yaml
```

`cancel-all` trips the persistent breaker and cancels Aftermath orders; it does not close positions. `flatten` attempts bounded reduce-only closure of both legs and can fail or leave a residual if a venue is unavailable or liquidity is insufficient. Confirm balances, orders and positions in both apps. If the control request times out, inspect status before retrying: the running process may still complete it. Do not blindly resubmit an ambiguous transaction.

A flatten request sent to a running bot trips its breaker first. For offline maintenance, stop quoting before stopping the process, then inspect venue state. Closing one leg manually can increase risk on the other; manage both.

## Breaker recovery

Inspect the breaker reason, outstanding intents, feed freshness, both positions and margin. Resolve the cause, reconcile ambiguous submissions and verify cancellation. Record why it is safe to resume:

```sh
bun src/cli/main.ts breaker reset --note "Feeds recovered; both venue positions and cancellation verified" --config config/config.yaml --markets-file config/markets.yaml
```

Reset is an operator acknowledgement, not a repair or a flatten. A process-level reset does not clear an unrelated unresolved condition or make missing data fresh.

## Collateral top-ups

Top up USDC manually on each chain through the relevant owner wallet and venue app. Monitor available margin on both venues independently; combined P&L cannot pay one venue's liquidation requirement. Aftermath account deposits may need allocation to a market. Use the app or the guarded allocation helper after stopping the bot, then rerun doctor and verify balances. Separately replenish agent SUI, GasPool or agent USDC gas as described in [gas.md](gas.md). Do not wait for a liquidation warning to move collateral across chains.

## Upgrading the signer

Stop the bot, verify cancellations, preserve state and back up the pinned artifacts. Use the build script from the repository root:

```sh
GO_BIN="$(command -v go)" bash scripts/build-lighter-signer.sh
bun run check
```

The script fetches unmodified lighter-go `v1.0.10`, verifies the pinned commit prefix, builds WASM and copies its matching `wasm_exec.js`, licenses and build metadata. It writes into `vendor/lighter-signer`; inspect the resulting hashes and notices before restarting. Do not replace only one of the WASM/runtime files. Go 1.27.2 on darwin/arm64 is the recorded reference toolchain; use it when comparing SHA-256 with `BUILD-INFO.json`.

For a change to the upstream tag, review the positional signer API and transaction formats as a code upgrade, then rerun signer, CLI and full checks. The current wrapper deliberately excludes funds-moving methods. Re-run doctor, paper and dry validation after any upgrade, and start live with small limits.
