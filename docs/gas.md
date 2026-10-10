# Aftermath gas

Trading collateral and gas are separate balances. Lighter collateral cannot pay Sui gas. Monitor the gas source alongside the margin on both venues.

## Choose a mode

| Mode | Payment | Setup | Operating cost |
| --- | --- | --- | --- |
| `sui` | Agent wallet pays SUI directly | Give the dedicated agent SUI | Default and normally the cheapest path: native network gas, without a stablecoin conversion. |
| `gas-pool` | Aftermath sponsors from a prepaid GasPool | Owner creates/funds a pool and grants the agent access | Network gas comes from the pool; USDC top-ups incur conversion costs. Agent needs no SUI for live sponsored transactions. |
| `dynamic-gas` | Per-transaction sponsorship reimbursed in agent USDC | Configure the USDC coin type and a maximum atomic fee | Budget roughly $0.05 per transaction as a planning estimate, not a fixed tariff. Not recommended for continuous quoting. |

No mode has a guaranteed dollar cost. For dynamic gas, the recorded service quote was 53,066 USDC atomic units ($0.053066); use a fee cap and verify current costs before use. At a $0.05 assumption, 360 transactions per hour would cost $18/hour in gas alone. The same number of transactions may occur without useful fills. Cost depends on network gas, transaction composition, sponsorship and conversions.

[Aftermath Dynamic Gas](https://docs.aftermath.finance/getting-started/dynamic-gas) describes the per-transaction reimbursement mechanism. The bot validates the reimbursement coin, recipient and configured fee cap before signing.

## SUI setup

1. Create the perpetuals account, deposit USDC and grant a dedicated agent from the owner wallet in the Aftermath app.
2. Transfer a small SUI gas reserve to the agent using the owner wallet. Protect the agent's own balances even though its account capability cannot withdraw account collateral.
3. Keep the default settings:

```yaml
aftermath:
  gas:
    mode: sui
    maxGasBudgetMist: '100000000'
```

One SUI is 1,000,000,000 MIST. The default budget cap is 0.1 SUI per transaction, not the expected fee. Doctor checks the balance can cover this cap. Track real receipts and replenish before a reserve runs low. A balance check does not establish that coin selection or a transaction simulation will succeed.

## GasPool setup

Use the pool owner's wallet in the Aftermath app or its owner-wallet GasPool flow to create/share a pool, fund it with SUI or USDC, and grant the agent's address. A USDC deposit is converted into SUI. These actions are manual, separate from the account's agent grant. [Official GasPool guide](https://docs.aftermath.finance/perpetuals/architecture/account/gasless-trading).

On the POOL OWNER's machine only, export `AF_OWNER_PRIVATE_KEY` in the process environment and run:

```sh
bun --no-env-file src/cli/main.ts setup aftermath terms-signature
```

The helper signs the exact personal message `Aftermath Terms and Conditions`. Paste its public output under `aftermath.gas.gasPool`:

```yaml
aftermath:
  gas:
    mode: gas-pool
    maxGasBudgetMist: '100000000'
    gasPool:
      ownerAddress: '<public pool owner address>'
      termsBytesB64: '<printed base64>'
      termsSignature: '<printed signature>'
      # gasBudgetMist: '50000000'
```

Remove `AF_OWNER_PRIVATE_KEY` from that environment afterwards. It must never be installed on the bot host or copied to a config file. The terms signature authorizes reusable sponsorship; protect the config and grant only the intended agent. The bot needs its agent key and the public terms, not the owner's key.

Mainnet supplies the GasPool package ID by default; a testnet pool needs the correct `gasPoolPackageId` for that deployment. Doctor checks that the pool exists, is funded and lists the agent in its whitelist. Confirm sharing and sponsorship in the owner interface as well. Revoke agent access from the owner wallet if needed, and top up from that wallet before gas runs low.

## Dynamic gas setup

Use USDC held by the agent wallet, separately from USDC deposited into its perpetuals account:

```yaml
aftermath:
  gas:
    mode: dynamic-gas
    maxGasBudgetMist: '100000000'
    dynamicGas:
      coinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
      maxFeeAtomic: '60000'
```

This example caps reimbursement at 0.06 mainnet USDC; it is not a recommended standing fee tolerance. A lower cap may reject sponsorship; a higher cap increases the amount a transaction may spend. Use the correct USDC deployment on testnet. The cap is required by the executor even though the YAML field is optional. Doctor rejects a missing cap and checks the agent's USDC balance.

## Reference gas price and dry mode

The bot always submits order transactions at Sui's reference gas price. The executor reads RGP through gRPC; the pre-sign gate rejects order transactions at another gas price, including sponsored transactions. The bot will fail instead of silently paying a different order gas price.

Dry mode does not submit. Its Aftermath simulation uses an unsigned self-paid SUI transaction, regardless of the selected live gas mode. Retain enough agent SUI for simulation if needed. Successful dry mode does not establish that GasPool or dynamic sponsorship will work live.
