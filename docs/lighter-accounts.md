# Lighter accounts

Create the account and deposit USDC through the [Lighter app](https://app.lighter.xyz). Register a dedicated API trading key with the owning L1 wallet. The bot does not create accounts, register keys, deposit, transfer or withdraw funds.

## Choose a tier

The official [account-types page](https://apidocs.lighter.xyz/docs/account-types) was checked on 2026-10-09. Values can change; check the page and `setup lighter check` before live operation.

| Tier | Maker / taker fee | Added taker latency | Maker / cancel latency | REST reads / sends per minute |
| --- | --- | --- | --- | --- |
| Standard | 0% / 0% | 300 ms | 0 / 300 ms | 60 total, including sends |
| Plus | 0.005% / 0.005% | 300 ms | 0 / 300 ms | 24,000 weighted reads / 4,000 sends |
| Premium, no stake | 0.0040% / 0.0280% | 140 ms | 0 / 0 ms | 24,000 weighted reads / 4,000 sends |

Premium staking tiers reduce fees and raise send limits; at 500,000 staked LIT the published fees are 0.0028% / 0.0196% and the send limit is 57,600/minute. These figures describe ordinary orders; this bot uses IOC hedges rather than advanced scheduled orders. Sub-accounts share their owner's tier. [Official account types](https://apidocs.lighter.xyz/docs/account-types).

Standard is a reasonable small-scale starting point when its delay and request budget fit your hedge-risk tolerance. Plus gives more API capacity at a fee while retaining Standard taker latency. Premium trades higher taker fees for lower added latency. Added latency is not an end-to-end fill guarantee. Measure actual hedge execution before raising exposure.

The adapter conservatively budgets 60 shared requests/minute for Standard, and 24,000 weighted reads plus 4,000 sends/minute for Plus/Premium. It does not automatically use the higher Premium staking limit. Account activity from other processes shares venue limits. The venue also enforces order caps and a volume-quota program; a healthy request bucket does not guarantee order acceptance. The adapter backs off retryable read failures, and the hedge path reconciles submission outcomes. [Official rate limits](https://apidocs.lighter.xyz/docs/rate-limits).

## Account and key indices

Configure:

```yaml
lighter:
  accountIndex: 0 # Replace with your own account index.
  apiKeyIndex: 4 # Dedicated registered trading key slot.
  tier: standard # Match the actual account tier.
```

`accountIndex` is a nonnegative safe integer, not a wallet address. Keep it private: public API reads by account index can expose positions and balances. Avoid sharing unredacted config files, logs or support output.

Use API key slots 4–254. Slots 0–3 are reserved for the official interfaces; 255 means all keys only for queries. Each key has its own nonce and applies to one account index. Registering the public key requires the L1 wallet. Store only the API private key as `LIGHTER_API_PRIVATE_KEY`; never give the bot the L1 private key. Do not share one API key across concurrent trading processes. A maker-only key cannot perform the bot's IOC hedge. [Official API-key documentation](https://apidocs.lighter.xyz/docs/api-keys).

## Validate

```sh
bun src/cli/main.ts setup lighter check --config config/config.yaml --markets-file config/markets.yaml
bun src/cli/main.ts doctor --config config/config.yaml --markets-file config/markets.yaml
```

The setup helper verifies the public account identity, initializes the signer for the configured indices/network, and checks that an auth token is accepted by `accountLimits`. It prints the actual tier and fails if it differs from `lighter.tier`. Registration and account creation remain manual.

API keys are sensitive: they can trade, change margin and request secure withdrawals back to the owning L1 address. This bot's wrapper exposes no withdrawal or transfer methods. That restriction does not limit what another program could do with a stolen key. Revoke or replace a compromised key through the owner wallet, and inspect both open positions and outstanding transactions.
