import { describe, expect, test } from "bun:test";
import { consumesNonce, NonceManager } from "../../../src/venues/lighter/nonce";
import type { Transaction } from "../../../src/venues/lighter/types";
import { flush } from "./helpers";

let namespace = 0;
function setup() {
  let next = 10n;
  let tx: Transaction | undefined;
  const reads: string[] = [];
  const rest = {
    nextNonce: async () => {
      reads.push("nonce");
      return next;
    },
    tx: async () => {
      reads.push("tx");
      return tx;
    },
  };
  const nonce = new NonceManager(rest, 42n, 4, `test-${namespace++}`);
  return {
    nonce,
    rest,
    reads,
    setNext: (n: bigint) => {
      next = n;
    },
    setTx: (t: Transaction | undefined) => {
      tx = t;
    },
  };
}
const sign = (n: bigint) => ({ txType: 14, txInfo: "{}", txHash: `h${n}` });
describe("Lighter nonces", () => {
  test("seeds from nextNonce", async () => {
    const { nonce } = setup();
    const result = await nonce.submit(sign, async () => ({ code: 400 }));
    expect(result.nonce).toBe(10n);
  });
  test("strictly serializes concurrent sends for one key", async () => {
    const { nonce } = setup();
    let release: () => void = () => {};
    let inflight = 0;
    let max = 0;
    const sent: bigint[] = [];
    const send = async () => {
      inflight++;
      max = Math.max(max, inflight);
      await new Promise<void>((r) => {
        release = r;
      });
      inflight--;
      return { code: 400 };
    };
    const p1 = nonce.submit((n) => {
      sent.push(n);
      return sign(n);
    }, send);
    const p2 = nonce.submit((n) => {
      sent.push(n);
      return sign(n);
    }, send);
    await flush();
    expect(sent).toEqual([10n]);
    release();
    await p1;
    await flush();
    expect(sent).toEqual([10n, 10n]);
    release();
    await p2;
    expect(max).toBe(1);
  });
  test("separate instances of a key share serialization", async () => {
    const ns = `shared-${namespace++}`;
    const rest = { nextNonce: async () => 10n, tx: async () => undefined };
    const a = new NonceManager(rest, 42n, 4, ns);
    const b = new NonceManager(rest, 42n, 4, ns);
    await a.submit(sign, async () => ({ code: 200 }));
    await expect(b.submit(sign, async () => ({ code: 200 }))).rejects.toThrow(
      "unresolved",
    );
  });
  test("API rejection reuses nonce", async () => {
    const { nonce } = setup();
    await nonce.submit(sign, async () => ({ code: 21733 }));
    expect((await nonce.submit(sign, async () => ({ code: 400 }))).nonce).toBe(
      10n,
    );
  });
  test.each([
    ["api", false],
    ["sequencer-before-apply", false],
    ["sequencer-apply", true],
    ["matching", true],
  ] as const)("recovery table %s consumes=%s", (stage, consumed) => {
    expect(consumesNonce(stage)).toBe(consumed);
  });
  test("pre-apply rejection resyncs to unconsumed nonce", async () => {
    const { nonce } = setup();
    expect(await nonce.recover("sequencer-before-apply", 10n)).toBe(10n);
  });
  test("apply rejection resyncs to consumed nonce", async () => {
    const { nonce, setNext } = setup();
    setNext(11n);
    expect(await nonce.recover("sequencer-apply", 10n)).toBe(11n);
  });
  test("unknown transport outcome blocks new signing", async () => {
    const { nonce, reads } = setup();
    await expect(
      nonce.submit(sign, async () => {
        throw new Error("timeout");
      }),
    ).rejects.toThrow("timeout");
    let signed = false;
    await expect(
      nonce.submit(
        (n) => {
          signed = true;
          return sign(n);
        },
        async () => ({ code: 200 }),
      ),
    ).rejects.toThrow("unresolved");
    expect(signed).toBe(false);
    expect(reads).toContain("tx");
    expect(reads.filter((x) => x === "nonce")).toHaveLength(2);
  });
  test.each([
    "executed",
    "failed",
    "pending",
    "unknown",
  ] as const)("resolveUnknown returns %s after both checks", async (state) => {
    const { nonce, setNext, setTx, reads } = setup();
    await nonce.submit(sign, async () => ({ code: 200 }));
    setNext(state === "executed" ? 11n : 10n);
    setTx(state === "unknown" ? undefined : { hash: "h10", state, nonce: 10n });
    const r = await nonce.resolveUnknown("h10");
    expect(r.status).toBe(state);
    expect(reads.slice(-2).sort()).toEqual(["nonce", "tx"]);
  });
  test("nonce advancement alone does not prove execution", async () => {
    const { nonce, setNext } = setup();
    await nonce.submit(sign, async () => ({ code: 200 }));
    setNext(11n);
    expect((await nonce.resolveUnknown("h10")).status).toBe("unknown");
  });
  test("failed consumed tx allows next nonce", async () => {
    const { nonce, setNext, setTx } = setup();
    await nonce.submit(sign, async () => ({ code: 200 }));
    setNext(11n);
    setTx({ hash: "h10", state: "failed", nonce: 10n });
    expect((await nonce.resolveUnknown("h10")).consumed).toBe(true);
    expect((await nonce.submit(sign, async () => ({ code: 400 }))).nonce).toBe(
      11n,
    );
  });
  test("executed status with unchanged nonce remains unknown", async () => {
    const { nonce, setTx } = setup();
    await nonce.submit(sign, async () => ({ code: 200 }));
    setTx({ hash: "h10", state: "executed", nonce: 10n });
    expect((await nonce.resolveUnknown("h10")).status).toBe("unknown");
  });
  test("resync cannot clear unresolved transaction", async () => {
    const { nonce } = setup();
    await nonce.submit(sign, async () => ({ code: 200 }));
    await expect(nonce.resync()).rejects.toThrow("unresolved");
  });
});
