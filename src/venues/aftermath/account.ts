import type { AfHttp } from "./http";
import type {
  AccountCap,
  AccountState,
  DetailedTrade,
  Position,
} from "./types";

export function hasPosition(
  positions: readonly Position[],
  marketId: string,
): boolean {
  return positions.some((p) => p.marketId === marketId);
}
export class AfAccountView {
  constructor(readonly state: AccountState) {}
  get accountId(): bigint {
    return this.state.accountId;
  }
  get positions(): readonly Position[] {
    return this.state.positions;
  }
  hasPosition(marketId: string): boolean {
    return hasPosition(this.state.positions, marketId);
  }
}
export class AfAccount {
  constructor(readonly http: AfHttp) {}
  async owned(
    walletAddress: string,
    collateralCoinType?: string,
  ): Promise<AccountCap[]> {
    return (
      await this.http.read<{ accountCaps: AccountCap[] }>(
        "/api/perpetuals/accounts/owned",
        { walletAddress, collateralCoinType },
      )
    ).accountCaps;
  }
  async agentCap(
    walletAddress: string,
    accountId?: bigint,
  ): Promise<AccountCap | undefined> {
    const caps = (await this.owned(walletAddress)).filter(
      (c) =>
        c.isAgent && (accountId === undefined || c.accountId === accountId),
    );
    if (caps.length > 1)
      throw new Error("Multiple agent caps; select accountId explicitly");
    return caps[0];
  }
  async positions(
    accountIds: bigint[],
    marketIds?: string[],
  ): Promise<AccountState[]> {
    return (
      await this.http.read<{ accounts: AccountState[] }>(
        "/api/perpetuals/accounts/positions",
        { accountIds, marketIds },
      )
    ).accounts;
  }
  async snapshot(accountId: bigint): Promise<AfAccountView> {
    const state = (await this.positions([accountId])).find(
      (a) => a.accountId === accountId,
    );
    if (!state) throw new Error("Account snapshot missing requested account");
    return new AfAccountView(state);
  }
  orderHistoryDetailed(
    accountId: bigint,
    options: {
      limit?: number;
      beforeTimestampCursor?: number | null;
      afterTimestampCursor?: number | null;
    } = {},
  ): Promise<{
    trades: DetailedTrade[];
    nextBeforeTimestampCursor: number | null;
  }> {
    return this.http.read("/api/perpetuals/account/order-history-detailed", {
      accountId,
      limit: 100,
      ...options,
    });
  }
}
