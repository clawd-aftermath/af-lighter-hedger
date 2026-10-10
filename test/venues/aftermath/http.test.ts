import { expect, test } from "bun:test";
import { VenueError } from "../../../src/core/errors";
import {
  AfHttp,
  apiError,
  parseAf,
  stringifyAf,
} from "../../../src/venues/aftermath/http";

function transport(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return handler as typeof fetch;
}
test("bigint body roundtrip preserves signed integers and ordinary strings", async () => {
  const value = {
    accountId: 1234567890123456789n,
    nested: [-8n, "123", "symboln"],
    timestamp: 4,
  };
  expect(parseAf(stringifyAf(value))).toEqual(value);
  const http = new AfHttp({
    fetch: transport((_url, init) => {
      expect(init?.headers).toMatchObject({
        "User-Agent": "af-lighter-hedger/1.0",
      });
      expect(JSON.parse(String(init?.body)).accountId).toBe(
        "1234567890123456789n",
      );
      return new Response(String(init?.body));
    }),
  });
  expect(
    await http.post<typeof value>(
      "/api/perpetuals/account/transactions/cancel-orders",
      value,
    ),
  ).toEqual(value);
});
for (const [code, retryable] of [
  [2030, false],
  [2031, true],
  [2032, false],
  [2033, false],
  [2034, false],
  [2035, false],
  [2037, false],
] as const) {
  test(`service code ${code} retryable=${retryable}`, () => {
    const e = apiError(
      new Response("", {
        status: 500,
        headers: { "X-Error-Code": String(code) },
      }),
      { message: "failed" },
    );
    expect(e).toBeInstanceOf(VenueError);
    expect(e.code).toBe(code);
    expect(e.retryable).toBe(retryable);
  });
}
test("HTTP 200 body error and preview header are failures", async () => {
  for (const [body, headers] of [
    [{ error: "bad" }, {}],
    [{}, { "X-Error-Message": "true" }],
  ] as const) {
    const h = new AfHttp({
      fetch: transport(() => new Response(JSON.stringify(body), { headers })),
    });
    await expect(h.post("/api/test", {})).rejects.toBeInstanceOf(VenueError);
  }
});
test("parses code from JSON string and plain text", () => {
  expect(
    apiError(new Response("", { status: 400 }), "Error 2034: bad terms").code,
  ).toBe(2034);
  expect(
    apiError(new Response("", { status: 400 }), {
      error_code: 2032,
      message: "auth",
    }).code,
  ).toBe(2032);
});
test("only reads retry and retry count is bounded with jitter", async () => {
  let calls = 0;
  const delays: number[] = [];
  const h = new AfHttp({
    random: () => 0.5,
    sleep: async (ms) => {
      delays.push(ms);
    },
    fetch: transport(() => {
      calls++;
      return new Response("outage", { status: 503 });
    }),
  });
  await expect(h.read("/api/perpetuals/markets", {})).rejects.toBeInstanceOf(
    VenueError,
  );
  expect(calls).toBe(3);
  expect(delays).toEqual([200, 400]);
  calls = 0;
  await expect(
    h.post("/api/perpetuals/account/transactions/cancel-orders", {}),
  ).rejects.toBeInstanceOf(VenueError);
  expect(calls).toBe(1);
  expect(() => h.read("/api/dynamic-gas", {})).toThrow();
});
test("network timeout aborts and retries a read only", async () => {
  let calls = 0;
  const h = new AfHttp({
    timeoutMs: 2,
    readRetries: 1,
    sleep: async () => {},
    fetch: transport((_url, init) => {
      calls++;
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      );
    }),
  });
  await expect(h.read("/api/test", {})).rejects.toMatchObject({
    code: "timeout",
  });
  expect(calls).toBe(2);
});
test("caller cancellation never retries", async () => {
  let calls = 0;
  const c = new AbortController();
  const h = new AfHttp({
    fetch: transport(() => {
      calls++;
      c.abort(new Error("cancelled"));
      throw new Error("network");
    }),
  });
  await expect(h.read("/api/test", {}, c.signal)).rejects.toThrow("cancelled");
  expect(calls).toBe(1);
});
test("invalid success JSON is not retried", async () => {
  let calls = 0;
  const h = new AfHttp({
    fetch: transport(() => {
      calls++;
      return new Response("invalid");
    }),
  });
  await expect(h.read("/api/test")).rejects.toMatchObject({
    code: "decode",
    retryable: false,
  });
  expect(calls).toBe(1);
});
