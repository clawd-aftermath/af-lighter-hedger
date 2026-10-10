import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  LighterRest,
  profiles,
  TokenBucket,
} from "../../../src/venues/lighter/rest";
import {
  parseJsonLossless,
  parseTransaction,
} from "../../../src/venues/lighter/types";
import { FakeClock, flush } from "./helpers";

const fixture = (name: string) =>
  readFile(
    new URL(`../../fixtures/lighter/${name}.json`, import.meta.url),
    "utf8",
  );
function restWith(
  body: string,
  capture?: (url: string, init: RequestInit) => void,
): LighterRest {
  return new LighterRest({
    fetch: async (url, init) => {
      capture?.(url, init);
      return new Response(body);
    },
  });
}
describe("Lighter REST", () => {
  test("network profiles bind the correct chain IDs", () => {
    expect(profiles.mainnet.chainId).toBe(304);
    expect(profiles.testnet.chainId).toBe(300);
    expect(new LighterRest().profile.baseUrl).toContain("testnet");
  });
  test("recorded metadata parses BTC/ETH/SOL/SUI", async () => {
    const markets = await restWith(await fixture("markets")).orderBookDetails();
    for (const symbol of ["BTC", "ETH", "SOL", "SUI"])
      expect(
        markets.find((m) => m.symbol === symbol)?.sizeDecimals,
      ).toBeGreaterThanOrEqual(0);
    expect(
      markets.find((m) => m.symbol === "BTC")?.baseInterestRate,
    ).toBeDefined();
  });
  test("recorded public book preserves IDs", async () => {
    const book = await restWith(await fixture("book")).orderBookOrders(1);
    expect(typeof book.asks[0]?.orderIndex).toBe("bigint");
    expect(book.bids).toHaveLength(5);
  });
  test("bare integers beyond 2^53 survive parsing", () => {
    const p = parseJsonLossless(
      '{"id":9007199254740993123,"text":"9007199254740993123","nested":"{\\"id\\":9007199254740993123}"}',
    ) as Record<string, unknown>;
    expect(p.id).toBe("9007199254740993123");
    expect(p.nested).toBe('{"id":9007199254740993123}');
  });
  test("synthetic actual account envelope parses positions and balances", async () => {
    const account = await restWith(await fixture("account-synthetic")).account(
      281474976710600n,
    );
    expect(account.availableBalance).toBe("1234.567890");
    expect(account.positions?.[0]?.sign).toBe(-1);
    expect(account.positions?.[0]?.totalFundingPaidOut).toBe("-0.012300");
  });
  test("missing account fails closed without leaking identity", async () => {
    await expect(
      restWith('{"code":200,"accounts":[]}').account(123456789n),
    ).rejects.toThrow("snapshot unavailable");
  });
  test("authenticated endpoints refuse without a token", async () => {
    await expect(restWith('{"code":200}').accountLimits(1n)).rejects.toThrow(
      "authentication",
    );
  });
  test("private reads carry auth and client indexes, not exchange IDs", async () => {
    let url = "";
    let auth = "";
    const rest = new LighterRest({
      auth: () => "secret-token",
      fetch: async (u, i) => {
        url = u;
        auth = (i.headers as Record<string, string>).Authorization ?? "";
        return new Response(
          '{"code":200,"orders":[{"order_id":"9007199254740993999","client_order_id":"123","market_index":1,"status":"filled","filled_base_amount":"1","filled_quote_amount":"2"}]}',
        );
      },
    });
    const result = await rest.accountOrders(99n, [123n]);
    expect(auth).toBe("secret-token");
    expect(url).toContain("client_order_indexes=123");
    expect(result.items[0]?.orderIndex).toBe(9007199254740993999n);
  });
  test("nextNonce returns bigint", async () => {
    expect(
      await restWith('{"code":200,"nonce":9007199254740993999}').nextNonce(
        1n,
        4,
      ),
    ).toBe(9007199254740993999n);
  });
  test("recorded funding history direction and rates", async () => {
    expect(
      (await restWith(await fixture("fundings")).fundings(1, 1, 2)).length,
    ).toBeGreaterThan(0);
  });
  test("cross-venue funding rates parse finite decimals", async () => {
    expect(
      (await restWith(await fixture("funding-rates")).fundingRates()).some(
        (r) => r.exchange === "lighter",
      ),
    ).toBe(true);
  });
  test.each([429, 405])("read backoff on HTTP %i", async (status) => {
    let calls = 0;
    const delays: number[] = [];
    const rest = new LighterRest({
      tier: "plus",
      random: () => 0.5,
      now: () => 1000,
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetch: async () =>
        ++calls === 1
          ? new Response("{}", { status })
          : new Response('{"code":200,"nonce":1}'),
    });
    expect(await rest.nextNonce(1n, 4)).toBe(1n);
    expect(delays).toEqual([1000]);
  });
  test("sendTx is form encoded and accepted only, never retried", async () => {
    let body = "";
    let calls = 0;
    const rest = new LighterRest({
      fetch: async (_, init) => {
        calls++;
        body = String(init.body);
        return new Response(
          '{"code":200,"tx_hash":"h","predicted_execution_time_ms":140,"volume_quota_remaining":9007199254740993999}',
        );
      },
    });
    const result = await rest.sendTx({
      txType: 14,
      txInfo: '{"a":"x&y"}',
      txHash: "h",
    });
    expect(new URLSearchParams(body).get("tx_info")).toBe('{"a":"x&y"}');
    expect(result.volumeQuotaRemaining).toBe(9007199254740993999n);
    expect(calls).toBe(1);
  });
  test("API send rejection remains a known rejection", async () => {
    expect(
      (
        await restWith('{"code":21733,"message":"no"}').sendTx({
          txType: 14,
          txInfo: "{}",
          txHash: "h",
        })
      ).code,
    ).toBe(21733);
  });
  test("non JSON send failure is unknown, not safely rejected", async () => {
    await expect(
      restWith("oops").sendTx({ txType: 14, txInfo: "{}", txHash: "h" }),
    ).rejects.toThrow("Invalid Lighter response");
  });
  test("transaction statuses include pending final state", () => {
    for (const [status, state] of [
      [0, "failed"],
      [1, "pending"],
      [2, "executed"],
      [3, "pending"],
      [9, "unknown"],
    ] as const)
      expect(
        parseTransaction({
          hash: "h",
          status,
          nonce: 1,
          info: "{}",
          event_info: "{}",
        }).state,
      ).toBe(state);
  });
  test("token bucket queues without overdraw", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(
      1,
      60,
      clock.now,
      (ms) => new Promise((r) => clock.setTimeout(r, ms)),
    );
    await bucket.take();
    let done = false;
    const p = bucket.take().then(() => {
      done = true;
    });
    await flush();
    clock.advance(999);
    await flush();
    expect(done).toBe(false);
    clock.advance(1);
    await p;
    expect(done).toBe(true);
  });
});

test("account limits parses tier and fee ticks with auth", async () => {
  const rest = new LighterRest({
    auth: () => "t",
    fetch: async () =>
      new Response(
        '{"code":200,"user_tier":"prm","user_tier_name":"premium","effective_lit_stakes":"3000","current_maker_fee_tick":37,"current_taker_fee_tick":266}',
      ),
  });
  expect(await rest.accountLimits(1n)).toEqual({
    userTier: "prm",
    userTierName: "premium",
    effectiveLitStakes: "3000",
    makerFeeTick: 37,
    takerFeeTick: 266,
  });
});
test("active/inactive orders preserve pagination and expected query parameters", async () => {
  const urls: string[] = [];
  let now = 0;
  const rest = new LighterRest({
    auth: () => "t",
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    fetch: async (url) => {
      urls.push(url);
      return new Response('{"code":200,"orders":[],"next_cursor":"next"}');
    },
  });
  expect((await rest.accountActiveOrders(1n, 2)).items).toEqual([]);
  expect((await rest.accountInactiveOrders(1n, 2, 10, "prev")).nextCursor).toBe(
    "next",
  );
  expect(urls[0]).toContain("market_id=2");
  expect(urls[1]).toContain("limit=10&cursor=prev");
});
test("positionFunding preserves large funding IDs and signed change", async () => {
  const rest = new LighterRest({
    auth: () => "t",
    fetch: async () =>
      new Response(
        '{"code":200,"next_cursor":"next","position_fundings":[{"funding_id":9007199254740993999,"market_id":1,"timestamp":1,"change":"-1.2","discount":"0","rate":"0.0012","position_size":"0.2","position_side":"long"}]}',
      ),
  });
  const result = await rest.positionFunding(1n);
  expect(result.items[0]?.fundingId).toBe(9007199254740993999n);
  expect(result.items[0]?.change).toBe("-1.2");
  expect(result.nextCursor).toBe("next");
});
test("tx not found becomes unknown, without hiding other API errors", async () => {
  expect(await restWith('{"code":29404}').tx("h")).toBeUndefined();
  await expect(restWith('{"code":29500}').tx("h")).rejects.toThrow("rejected");
});
test("Retry-After is honored for reads", async () => {
  let count = 0;
  const delays: number[] = [];
  const rest = new LighterRest({
    tier: "plus",
    now: () => 1000,
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
    fetch: async () =>
      ++count === 1
        ? new Response("{}", { status: 429, headers: { "Retry-After": "60" } })
        : new Response('{"code":200,"nonce":1}'),
  });
  await rest.nextNonce(1n, 4);
  expect(delays).toEqual([60000]);
});
test("send errors preserve code and message without retrying", async () => {
  const response = await restWith(
    '{"code":23000,"message":"Too Many Requests"}',
  ).sendTx({ txType: 14, txInfo: "{}", txHash: "h" });
  expect(response.message).toBe("Too Many Requests");
  expect(response.code).toBe(23000);
});
test("premium staked send limit differs from plus baseline", async () => {
  let now = 0;
  const delays: number[] = [];
  const options = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      delays.push(ms);
    },
    fetch: async () => new Response('{"code":200}'),
  };
  const premium = new LighterRest({
    ...options,
    tier: "premium",
    stakedLit: 500000,
  });
  await premium.sendTx({ txType: 14, txInfo: "{}", txHash: "h" });
  await premium.sendTx({ txType: 14, txInfo: "{}", txHash: "h" });
  expect(delays).toEqual([2]);
  delays.length = 0;
  const plus = new LighterRest({ ...options, tier: "plus" });
  await plus.sendTx({ txType: 14, txInfo: "{}", txHash: "h" });
  await plus.sendTx({ txType: 14, txInfo: "{}", txHash: "h" });
  expect(delays).toEqual([15]);
});
