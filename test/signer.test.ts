import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { ConfigError, VenueError } from "../src/core/errors";
import {
  type LighterSigner,
  loadLighterSigner,
  MAX_CLIENT_ORDER_INDEX,
  orderType,
  timeInForce,
  txType,
} from "../src/venues/lighter/signer";

const forbidNetwork = () => {
  throw new Error("Network access forbidden in offline signer tests");
};
const fetchGuard = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(forbidNetwork, { preconnect: forbidNetwork }),
);
let signer: LighterSigner;
const order: Parameters<LighterSigner["SignCreateOrder"]> = [
  0,
  123456789n,
  1000n,
  800000n,
  1,
  orderType.MARKET,
  timeInForce.IOC,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1n,
  4,
  1,
];

beforeAll(async () => {
  const a = loadLighterSigner();
  const b = loadLighterSigner();
  expect(a).toBe(b);
  const [first, second] = await Promise.all([a, b]);
  expect(first).toBe(second);
  signer = first;
  const key = signer.GenerateAPIKey();
  signer.CreateClient("", key.privateKey, 300, 4, 1);
});
afterAll(() => {
  fetchGuard.mockRestore();
});

describe("offline Bun WASM signer", () => {
  test("concurrent initialization is one promise and one instance", async () => {
    const a = loadLighterSigner();
    const b = loadLighterSigner();
    expect(a).toBe(b);
    expect(await a).toBe(signer);
  });

  test("generates ephemeral API key pairs", () => {
    const a = signer.GenerateAPIKey();
    const b = signer.GenerateAPIKey();
    expect(a.privateKey).toMatch(/^(0x)?[0-9a-f]+$/i);
    expect(a.publicKey).toMatch(/^(0x)?[0-9a-f]+$/i);
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  test("creates empty-URL testnet clients and a default-deadline auth token", () => {
    const key = signer.GenerateAPIKey();
    expect(signer.CreateClient("", key.privateKey, 300n, 5n, 1n)).toEqual({});
    const { authToken } = signer.CreateAuthToken(0, 5, 1);
    expect(authToken).toBeString();
    expect(authToken.length).toBeGreaterThan(32);
  });

  test("MARKET/IOC signed JSON preserves every supplied order field", () => {
    const tx = signer.SignCreateOrder(...order);
    expect(tx.txType).toBe(txType.CREATE_ORDER);
    expect(tx.txHash).toBeString();
    const info = JSON.parse(tx.txInfo);
    expect(info).toMatchObject({
      MarketIndex: 0,
      ClientOrderIndex: 123456789,
      BaseAmount: 1000,
      Price: 800000,
      IsAsk: 1,
      Type: 1,
      TimeInForce: 0,
      ReduceOnly: 0,
      TriggerPrice: 0,
      OrderExpiry: 0,
      Nonce: 1,
      ApiKeyIndex: 4,
      AccountIndex: 1,
    });
    expect(info.Sig).toBeString();
    expect(info.Sig.length).toBeGreaterThan(32);
  });

  test("signs cancellation by client order index", () => {
    const tx = signer.SignCancelOrder(0, 123456789n, 0, 2n, 4, 1);
    expect(tx.txType).toBe(txType.CANCEL_ORDER);
    expect(JSON.parse(tx.txInfo)).toMatchObject({
      MarketIndex: 0,
      Index: 123456789,
      Nonce: 2,
    });
  });

  test("signs immediate cancel-all with every positional argument", () => {
    const tx = signer.SignCancelAllOrders(0, 0, 255, 0, 3, 4, 1);
    expect(tx.txType).toBe(txType.CANCEL_ALL_ORDERS);
    expect(JSON.parse(tx.txInfo)).toMatchObject({
      TimeInForce: 0,
      Time: 0,
      Nonce: 3,
    });
  });

  test("signs modify with explicit orderVersion and leverage update", () => {
    const modify = signer.SignModifyOrder(
      0,
      123456789,
      2000,
      800001,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      4,
      0,
      4,
      1,
    );
    expect(modify.txType).toBe(txType.MODIFY_ORDER);
    expect(JSON.parse(modify.txInfo)).toMatchObject({
      Index: 123456789,
      BaseAmount: 2000,
      Price: 800001,
      Nonce: 4,
    });
    const leverage = signer.SignUpdateLeverage(0, 1000, 0, 0, 5, 4, 1);
    expect(leverage.txType).toBe(txType.UPDATE_LEVERAGE);
    expect(JSON.parse(leverage.txInfo)).toMatchObject({
      MarketIndex: 0,
      Nonce: 5,
    });
  });

  test("rejects out-of-range clientOrderIndex before WASM", () => {
    const args = [...order] as typeof order;
    args[1] = MAX_CLIENT_ORDER_INDEX + 1n;
    args[17] = 254; // No client: WASM would return a VenueError if reached.
    expect(() => signer.SignCreateOrder(...args)).toThrow(ConfigError);
    expect(() =>
      signer.SignCancelOrder(0, MAX_CLIENT_ORDER_INDEX + 1n, 0, 1, 4, 1),
    ).toThrow(ConfigError);
  });

  test("signs the maximum uint48 client index exactly", () => {
    const args = [...order] as typeof order;
    args[1] = MAX_CLIENT_ORDER_INDEX;
    expect(
      JSON.parse(signer.SignCreateOrder(...args).txInfo).ClientOrderIndex,
    ).toBe(Number(MAX_CLIENT_ORDER_INDEX));
  });

  test("guards every numeric argument against unsafe conversion", () => {
    for (let i = 0; i < order.length; i++) {
      for (const invalid of [
        Number.MAX_SAFE_INTEGER + 1,
        9007199254740992n,
        1.5,
        NaN,
        Infinity,
      ]) {
        const args = [...order] as typeof order;
        args[i] = invalid;
        expect(() => signer.SignCreateOrder(...args)).toThrow(ConfigError);
      }
    }
  });

  test("rejects auto-fetch nonce, undefined args and nonempty client URLs", () => {
    expect(() => signer.SignCancelOrder(0, 1, 0, -1, 4, 1)).toThrow(
      ConfigError,
    );
    const args = [...order] as unknown[];
    args[8] = undefined;
    expect(() => signer.SignCreateOrder(...(args as typeof order))).toThrow(
      ConfigError,
    );
    expect(() =>
      signer.CreateClient(
        "https://invalid.example" as "",
        "synthetic",
        300,
        4,
        1,
      ),
    ).toThrow(ConfigError);
  });

  test("rejects truncation of uint32 price and int16 market index", () => {
    const args = [...order] as typeof order;
    args[3] = 0x100000000;
    expect(() => signer.SignCreateOrder(...args)).toThrow(ConfigError);
    expect(() => signer.SignCancelOrder(32768, 1, 0, 1, 4, 1)).toThrow(
      ConfigError,
    );
  });

  test("returns typed upstream errors and forbids mixed-chain clients", () => {
    expect(() => signer.CreateAuthToken(0, 254, 1)).toThrow(VenueError);
    expect(() =>
      signer.CreateClient("", signer.GenerateAPIKey().privateKey, 304, 4, 1),
    ).toThrow(ConfigError);
  });

  test("exposes only permitted wrappers and removes raw funds-moving globals", () => {
    expect(Object.keys(signer).sort()).toEqual([
      "CreateAuthToken",
      "CreateClient",
      "GenerateAPIKey",
      "SignCancelAllOrders",
      "SignCancelOrder",
      "SignCreateOrder",
      "SignModifyOrder",
      "SignUpdateLeverage",
    ]);
    const globals = globalThis as unknown as Record<string, unknown>;
    for (const name of [
      "CheckClient",
      "SignWithdraw",
      "SignTransfer",
      "SignChangePubKey",
      "SignStakeAssets",
      "SignApproveIntegrator",
    ])
      expect(globals[name]).toBeUndefined();
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  test("a separate Bun process loads and signs then exits without forced exit", async () => {
    const module = new URL("../src/venues/lighter/signer.ts", import.meta.url)
      .href;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      globalThis.fetch = () => { throw new Error("Network forbidden"); };
      const { loadLighterSigner } = await import(${JSON.stringify(module)});
      const signer = await loadLighterSigner();
      const key = signer.GenerateAPIKey();
      signer.CreateClient("", key.privateKey, 300, 4, 1);
      const tx = signer.SignCancelOrder(0, 123, 0, 1, 4, 1);
      if (tx.txType !== 15) throw new Error("Bad cancel");
      console.log("offline-ok");
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const watchdog = setTimeout(() => child.kill(), 5000);
    try {
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("offline-ok\n");
      expect(await new Response(child.stderr).text()).toBe("");
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) child.kill();
    }
  }, 10000);
});
