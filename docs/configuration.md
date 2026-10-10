# Configuration

Use `config/config.yaml` for runtime settings and `config/markets.yaml` for the market array. Copy the corresponding `.example.yaml` files and pass both CLI flags explicitly. The CLI otherwise uses built-in settings and BTC/ETH/SOL/SUI entries. YAML is strict: unknown fields, duplicate keys, aliases and embedded secrets are rejected. Private keys belong only in the process environment.

The tables give schema defaults and accepted bounds. Accepted bounds are not a declaration of safety. Set your own strategy values, start with one quote level and the smallest clip that passes market minimums; set position/global/loss limits to amounts you can afford. Do not widen freshness, hedge or margin thresholds simply to silence a pause.

## Runtime and venue identity

| Field | Default | Unit and accepted values | Operator guidance |
| --- | --- | --- | --- |
| `profile` | `mainnet` | `mainnet`, `testnet` | Select the network of both accounts. |
| `mode` | `paper` | `paper`, `dry`, `live` | Control commands use this mode; `run --mode` overrides it and defaults to paper. |
| `aftermath` | Required object | Object | Supply `gas`, even when empty. |
| `aftermath.baseUrl` | Mainnet `https://aftermath.finance`; testnet `https://testnet.aftermath.finance` | HTTP(S) URL | Omit for normal operation. |
| `aftermath.grpcUrl` | `https://fullnode.<profile>.sui.io:443` | HTTP(S) gRPC URL | Must support Sui gRPC; `SUI_GRPC_URL` overrides it. |
| `aftermath.agentAddress` | Omitted | `0x` plus 1–64 hexadecimal digits | Optional public address check against the key; never use the owner key. |
| `aftermath.accountId` | Omitted | Unsigned integer string | Required for dry/live. Quote the string to preserve precision. |
| `lighter` | Required object | Object | Configure real account/key indices before dry/live. |
| `lighter.baseUrl` | Mainnet `https://mainnet.zklighter.elliot.ai`; testnet `https://testnet.zklighter.elliot.ai` | HTTP(S) URL | Must correspond to the chain ID. |
| `lighter.chainId` | Mainnet 304; testnet 300 | Positive integer | Omit for the selected profile unless deliberately using another compatible deployment. |
| `lighter.accountIndex` | Required in YAML; built-in 0 | Integer 0 through the JavaScript safe-integer maximum | Private operator identifier; account data is public by index. |
| `lighter.apiKeyIndex` | Required in YAML; built-in 4 | Integer 4–254 | Dedicated registered API trading-key slot. |
| `lighter.tier` | `standard` | `standard`, `plus`, `premium` | Must match `accountLimits`; live startup refuses mismatch. |
| `lighter.maxSlippageBps` | 50 | 0–400 bp | Initial hedge limit. 100 bp = 1%. Smaller values can leave more leg risk. |
| `lighter.emergencySlippageBps` | 100 | Initial limit through 400 bp | Bounded emergency hedge retry limit. Keep losses tolerable at this bound. |

Positive IDs and timestamps passed to the signer must also fit its supported integer ranges. The schema accepts HTTP URLs for local/test deployments; use trusted HTTPS endpoints for public trading.

## Gas

| Field | Default | Unit and accepted values | Operator guidance |
| --- | --- | --- | --- |
| `aftermath.gas` | Required object | Object | See [gas setup](gas.md). |
| `aftermath.gas.mode` | `sui` | `sui`, `gas-pool`, `dynamic-gas` | Self-paid SUI is the normal starting choice. |
| `aftermath.gas.maxGasBudgetMist` | `'100000000'` | Positive integer string, MIST | Maximum per-transaction SUI budget, 0.1 SUI by default. Not an expected fee. |
| `aftermath.gas.gasPoolPackageId` | Mainnet `0x1defae9e3c13f8598c1a7012f1be6ae29ebbbaf1a61ee33291e4d97c8cd53016`; testnet omitted | Sui hex address | Required at execution for GasPool; use the deployment's package. |
| `aftermath.gas.gasPool` | Omitted | Object; required for `gas-pool` | Owner grants and funds the pool manually. |
| `aftermath.gas.gasPool.ownerAddress` | Required in the object | Sui hex address | Public pool-owner address, not a key. |
| `aftermath.gas.gasPool.termsBytesB64` | Required in the object | Nonempty base64 | Exact UTF-8 terms bytes from the signature helper. |
| `aftermath.gas.gasPool.termsSignature` | Required in the object | Nonempty serialized signature | Produced on the owner's machine; keep the owner key off the bot host. |
| `aftermath.gas.gasPool.gasBudgetMist` | Omitted; sponsor determines budget | Positive MIST integer string, no greater than maximum budget | Optional exact sponsor budget. |
| `aftermath.gas.dynamicGas` | Omitted | Object; required for `dynamic-gas` | Live per-transaction reimbursement. |
| `aftermath.gas.dynamicGas.coinType` | Required in the object | Nonempty fully qualified Sui coin type | Use the network's USDC type; doctor checks USDC for this mode. |
| `aftermath.gas.dynamicGas.maxFeeAtomic` | Omitted in schema; execution requires it | Unsigned integer string, coin atomic units | Set an explicit fee cap. USDC has six decimals; `'60000'` = 0.06 USDC. A zero cap rejects positive fees. |

Never paste the owner's private key into either YAML. One SUI is 1e9 MIST; one USDC is 1e6 atomic units. Integer strings are unsigned ordinary decimal notation, with no suffix or exponent. Execution additionally rejects incompatible gas settings or transactions outside the configured cap.

## Quote and feed timing

All millisecond fields are positive safe integers. These defaults reflect the recorded feed cadence and should be retained until you have measured the deployment.

| Field | Default | Unit and bound | Purpose |
| --- | --- | --- | --- |
| `aftermath.quoteTtlMs` | 600000 | ms, positive | Aftermath order lifetime, 10 minutes. |
| `aftermath.minQuoteIntervalMs` | 1000 | ms, positive | Minimum quote-update interval. |
| `aftermath.heartbeatMs` | 10000 | ms, positive | Engine heartbeat/check period. |
| `aftermath.afResnapshotMs` | 15000 | ms, positive | Aftermath REST book/market refresh. |
| `aftermath.oraclePollMs` | 3000 | ms, 1–5000 | Authoritative Sui oracle timestamp verification. |
| `aftermath.minRequoteTicks` | 1 | Nonnegative safe integer ticks | Price-change tolerance before replacement. |
| `aftermath.maxRequotesPerMinute` | 6 | Positive integer batches/minute | Limits replacement frequency and gas use. |

## Strategy

The bot ships no tuned strategy defaults. Tunables are optional in YAML for paper mode, which fills omitted values with neutral placeholders and prints one warning listing the missing fields. Dry/live runs refuse to start (exit 2) unless all eight tunables, including both skew coefficients, are explicitly set in the runner's YAML. Explicit zero values count as configured where the range permits them. `doctor` reports WARN for unset tunables in paper and FAIL in dry/live. The derived `strategy.placeholders` flag and `strategy.missingTunables` list are output metadata, not YAML fields.

Keep budget 0 and liquidity taking disabled for the default profitable-only maker/hedger; these two safe defaults do not count as tunables.

| Field | Default | Unit and bound | Meaning |
| --- | --- | --- | --- |
| `strategy.holdHours` | unset (neutral placeholder 1 in paper) | Positive finite hours | Planning horizon for estimated carry. |
| `strategy.eta` | unset (neutral placeholder 0 in paper) | Fraction 0–1 | Haircut on positive estimated carry; larger is more conservative. |
| `strategy.kPhi` | unset (neutral placeholder 0 in paper) | Nonnegative finite multiplier | Funding-uncertainty penalty weight. |
| `strategy.kBasis` | unset (neutral placeholder 0 in paper) | Nonnegative finite multiplier | Reserved basis-uncertainty weight; not consumed by the current runtime. |
| `strategy.epsInBp` | unset (neutral placeholder 0 in paper) | Nonnegative finite bp | Entry profitability allowance required by the estimate. |
| `strategy.exitTakerShare` | unset (neutral placeholder 0 in paper) | Fraction 0–1 | Reserved exit-cost share; not consumed by the current runtime. |
| `strategy.skew` | unset (neutral placeholder `{s1: 0, s3: 0}` in paper) | Object | Inventory adjustments. |
| `strategy.skew.s1` | unset (neutral placeholder 0 in paper) | Nonnegative finite bp coefficient | Linear inventory adjustment. |
| `strategy.skew.s3` | unset (neutral placeholder 0 in paper) | Nonnegative finite bp coefficient | Cubic inventory adjustment. |
| `strategy.compressionBudgetBp` | 0 | Nonnegative finite bp | Estimated profitability allowance; 0 is profitable-only. Positive values permit estimated losses within the allowance. |
| `strategy.allowAfTaking` | `false` | Boolean | Reserved permission flag; the current runtime still posts opening quotes post-only. Keep false. |

Estimated profitability can differ from realized P&L. These settings do not guarantee funding receipts or execution prices. Per-market budget overrides are documented below.

## Risk

`risk` can be omitted. Defaults are a starting configuration, not a safe amount for every operator or market.

| Field | Default | Unit and bound | Meaning |
| --- | --- | --- | --- |
| `risk.maxUnhedgedUsd` | 100 | Positive finite USD | Maximum unmatched exposure before breaker handling. Keep within tolerable loss capacity. |
| `risk.maxUnhedgedAgeMs` | 10000 | Positive safe integer ms | Maximum age of unmatched exposure. |
| `risk.reconcileQuiescenceMs` | 3000 | Positive safe integer ms | How long a market's Aftermath position must stay unchanged before the reconciler may correct a mismatch. New exposure is hedged from fill events immediately; this only delays corrections. |
| `risk.maxReconcileDeferralMs` | 15000 | Positive safe integer ms | If a mismatch cannot be reconciled for this long, quotes for that market are pulled and a `reconcile_starved` alert is raised until it reconciles. |
| `risk.maxTotalNotionalUsd` | 2000 | Positive finite USD | Global Aftermath-leg notional limit across positions and pending increases; it does not sum both legs. |
| `risk.dailyLossLimitUsd` | 100 | Positive finite USD | Daily loss gate using recorded trade, funding and gas accounting; it is not a mark-to-market loss stop. |
| `risk.basisBandBp` | 50 | Positive finite bp | Allowed deviation from the basis EMA. |
| `risk.minMarginHeadroomPct` | 20 | 0–100 percent | Minimum free-margin headroom. A 100% requirement leaves no opening margin capacity. |
| `risk.pauseWhenSessionClosed` | `true` | Boolean | Pause/cancel quoting outside venue sessions. Keep true. |
| `risk.stalenessMs` | Object below | Object | Freshness gates for required feeds. |
| `risk.stalenessMs.afBook` | 30000 | Positive safe integer ms | Aftermath book age ceiling. Default supports 15-second REST refreshes. |
| `risk.stalenessMs.afOracle` | 10000 | ms, 1–14999 | Authoritative oracle age ceiling; schema keeps it below 15 seconds. |
| `risk.stalenessMs.lighterBook` | 10000 | Positive safe integer ms | Lighter book age ceiling. |
| `risk.stalenessMs.afMarket` | 30000 | Positive safe integer ms | Aftermath market-state age ceiling. |
| `risk.stalenessMs.lighterStats` | 30000 | Positive safe integer ms | Lighter stats age ceiling. |
| `risk.stalenessMs.liveness` | 15000 | Positive safe integer ms | Socket-frame liveness ceiling. |

Timing thresholds must fit the actual feed cadence and refresh intervals. Very small values can prevent all quoting; larger values allow decisions from older data. Keep the defaults unless measurement justifies a change, and never relax oracle checks past the schema ceiling.

## Markets

The file is a nonempty array of strict entries. Symbols must be unique. Disabled entries remain valid configuration but are excluded from runs. `--markets BTC,ETH` on `run` selects only enabled entries; unknown or disabled symbols are refused.

| Field | Default | Unit and accepted values | Guidance |
| --- | --- | --- | --- |
| `symbol` | Required | Uppercase letters/digits, `_` or `-`; first character alphanumeric | Exact shared market symbol. |
| `enabled` | `true` | Boolean | Stop/cancel and handle positions before disabling. |
| `aftermath.marketId` | Required | `auto` or Sui hex address | Explicit ID overrides automatic discovery. |
| `lighter.marketId` | Required | `auto` or nonnegative safe integer ID | Explicit ID overrides automatic discovery. |
| `clipUsd` | 50 | Positive finite USD, no greater than position cap | Per quote level; must satisfy joint minimum after rounding. |
| `maxPositionUsd` | 500 | Positive finite USD | Market absolute position cap. Start small. |
| `levels` | 1 | Integer 1–3 | All levels share exposure and OI capacities. |
| `compressionBudgetBp` | Omitted, inherits global | Nonnegative finite bp | Set explicitly to 0 to preserve profitable-only on this market regardless of the global budget. |

Built-in entries use `auto`, $50 clips, $500 caps, one level and no budget override. Follow [Adding a market](adding-markets.md) before changing the list.

## Environment

| Variable | Default | Use |
| --- | --- | --- |
| `AF_AGENT_PRIVATE_KEY` | Unset | Supported Sui `suiprivkey` encoding. Required for dry/live, absent for paper. |
| `LIGHTER_API_PRIVATE_KEY` | Unset | Registered Lighter trading key, required for dry/live. |
| `AF_OWNER_PRIVATE_KEY` | Unset | Terms-signature helper only, on the owner's machine. Doctor fails if it is present on the bot host. |
| `TELEGRAM_BOT_TOKEN` | Unset | Optional alerts; requires chat ID too. |
| `TELEGRAM_CHAT_ID` | Unset | Optional destination; requires bot token too. |
| `SUI_GRPC_URL` | YAML gRPC URL | Override the Sui gRPC endpoint. |
| `HEDGER_DEBUG` | Unset | `1` enables detailed errors/debug logging. |
| `BOT_STATE_PATH` | `.state/bot.sqlite` | Persistent SQLite path; use the same value for controls. |
| `BOT_HEALTH_HOST` | `127.0.0.1` | Health bind address; keep private. |
| `BOT_HEALTH_PORT` | 9090 | Available TCP port for the health server. |

Bun may load `.env` in the working directory. For the owner-key helper, invoke Bun with `--no-env-file` and use an exported process environment value on the owner's machine; the helper never reads a key file. Do not place an owner key in `.env` on the bot host. See `.env.example` for bot-host variable names without values.
