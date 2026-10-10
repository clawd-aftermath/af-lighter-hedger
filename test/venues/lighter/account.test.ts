import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { LighterAccount } from "../../../src/venues/lighter/account";
import { parseAccount } from "../../../src/venues/lighter/types";
import { LighterWs } from "../../../src/venues/lighter/ws";
import { FakeClock, market } from "./helpers";

const fixture = JSON.parse(
  await readFile(
    new URL("../../fixtures/lighter/account-synthetic.json", import.meta.url),
    "utf8",
  ),
);
const account = parseAccount(fixture.accounts[0]);
function setup() {
  const clock = new FakeClock();
  return {
    clock,
    service: new LighterAccount(
      account.accountIndex,
      new Map([[1, market]]),
      clock,
      2000,
    ),
  };
}
test("account starts unknown with no fabricated zero", () => {
  const { service } = setup();
  expect(service.snapshot()).toEqual({
    status: "unknown",
    availableCollateral: null,
    positions: null,
  });
});
test("REST account yields signed bigint position and collateral", async () => {
  const { service } = setup();
  await service.refresh({ account: async () => account });
  expect(service.position(1)?.signedBaseInt).toBe(-1234n);
  expect(service.position(1)?.signedBase).toBe("-0.01234");
  expect(service.position(1)?.liquidationPrice).toBe("95000.0");
  expect(service.snapshot().availableCollateral).toBe("1234.567890");
  service.stop();
});
test("missing positions or balance fail closed", () => {
  for (const a of [
    { ...account, positions: undefined },
    { ...account, availableBalance: undefined },
  ]) {
    const { service } = setup();
    service.apply(a, true);
    expect(service.snapshot().status).toBe("unknown");
    service.stop();
  }
});
test("account state ages to stale and emits change", () => {
  const { service, clock } = setup();
  let status = "";
  service.on("change", (s) => {
    status = s.status;
  });
  service.apply(account, true);
  clock.advance(2000);
  expect(status).toBe("stale");
  expect(service.position(1)).toBeUndefined();
  service.stop();
});
test("stream snapshot replaces positions and deltas merge", () => {
  const { service } = setup();
  service.apply(account, true);
  service.apply(
    {
      ...account,
      positions: [
        { marketId: 1, position: "0.5", sign: 1, avgEntryPrice: "80000" },
      ],
    },
    false,
  );
  expect(service.position(1)?.signedBase).toBe("0.5");
  service.apply({ ...account, positions: [] }, true);
  expect(service.position(1)).toBeUndefined();
  service.stop();
});
test("stream disconnect invalidates snapshot", () => {
  const { service } = setup();
  const ws = new LighterWs({
    auth: { get: () => ({ token: "t", expiresAt: 1e15 }) },
  });
  service.attach(ws);
  service.apply(account, true);
  ws.emit("stale", {
    channel: `account_all/${account.accountIndex}`,
    reason: "disconnect",
  });
  expect(service.snapshot().status).toBe("stale");
  service.stop();
});
test("account_all lacking collateral never carries old balance as fresh", () => {
  const { service } = setup();
  service.apply(account, true);
  service.apply(
    { ...account, availableBalance: undefined, collateral: undefined },
    false,
  );
  expect(service.snapshot().status).toBe("unknown");
  service.stop();
});
test("unknown market decimals and excess precision fail closed", () => {
  const { service } = setup();
  service.apply(
    {
      ...account,
      positions: [
        { marketId: 999, position: "1", sign: 1, avgEntryPrice: "1" },
      ],
    },
    true,
  );
  expect(service.snapshot().status).toBe("unknown");
  service.apply(
    {
      ...account,
      positions: [
        { marketId: 1, position: "0.000001", sign: 1, avgEntryPrice: "1" },
      ],
    },
    true,
  );
  expect(service.snapshot().status).toBe("unknown");
  service.stop();
});
test("failed REST refresh invalidates previously fresh state", async () => {
  const { service } = setup();
  service.apply(account, true);
  await expect(
    service.refresh({
      account: async () => {
        throw new Error("failure");
      },
    }),
  ).rejects.toThrow("failure");
  expect(service.snapshot().status).toBe("stale");
  service.stop();
});

test("REST result racing a newer stream update does not overwrite it", async () => {
  const { service } = setup();
  let release: (a: typeof account) => void = () => {};
  const pending = service.refresh({
    account: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  service.apply(
    {
      ...account,
      positions: [
        { marketId: 1, position: "0.5", sign: 1, avgEntryPrice: "80000" },
      ],
    },
    true,
  );
  release(account);
  await pending;
  expect(service.position(1)?.signedBase).toBe("0.5");
  service.stop();
});
