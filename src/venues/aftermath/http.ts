import { VenueError } from "../../core/errors";
import { parseBigIntN, toBigIntN } from "../../core/units";

export const MAINNET_URL = "https://aftermath.finance";
export const TESTNET_URL = "https://testnet.aftermath.finance";
export const stringifyAf = (value: unknown): string =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? toBigIntN(v) : v));
export const parseAf = (text: string): unknown =>
  JSON.parse(text, (_, v) =>
    typeof v === "string" && /^-?\d+n$/.test(v) ? parseBigIntN(v) : v,
  );

// Stable service codes override HTTP status (e.g. auth errors on a 500).
const retryableCodes = new Map<number, boolean>([
  [2030, false],
  [2031, true],
  [2032, false],
  [2033, false],
  [2034, false],
  [2035, false],
  [2037, false],
]);
export function apiError(response: Response, body: unknown): VenueError {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message = String(
    record.error ??
      record.message ??
      (typeof body === "string"
        ? body
        : (response.headers.get("X-Error-Message") ??
          `HTTP ${response.status}`)),
  );
  const rawCode =
    response.headers.get("X-Error-Code") ??
    record.error_code ??
    message.match(/Error\s+(\d+):/)?.[1];
  const code = rawCode === undefined ? response.status : Number(rawCode);
  return new VenueError(
    message,
    "aftermath",
    Number.isFinite(code) ? code : String(rawCode),
    retryableCodes.get(code) ??
      (response.status === 429 || response.status >= 500),
  );
}
export interface HttpOptions {
  baseUrl?: string;
  userAgent?: string;
  timeoutMs?: number;
  readRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}
export class AfHttp {
  readonly baseUrl: string;
  private readonly options: Required<Omit<HttpOptions, "baseUrl">>;
  constructor(options: HttpOptions = {}) {
    this.baseUrl = (options.baseUrl ?? MAINNET_URL).replace(/\/$/, "");
    this.options = {
      userAgent: options.userAgent || "af-lighter-hedger/1.0",
      timeoutMs: options.timeoutMs ?? 10_000,
      readRetries: options.readRetries ?? 2,
      fetch: options.fetch ?? fetch,
      sleep:
        options.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: options.random ?? Math.random,
    };
    if (
      this.options.readRetries < 0 ||
      this.options.readRetries > 5 ||
      !Number.isInteger(this.options.readRetries) ||
      this.options.timeoutMs <= 0
    )
      throw new Error("Invalid HTTP bounds");
  }
  read<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (/transactions|dynamic-gas|\/build|\/submit/.test(path))
      throw new Error("Transaction routes are never retryable reads");
    return this.request<T>(path, body, true, signal);
  }
  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, body, false, signal);
  }
  private async request<T>(
    path: string,
    body: unknown,
    read: boolean,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!path.startsWith("/api/")) throw new Error("Expected /api/ path");
    const serialized = body === undefined ? undefined : stringifyAf(body);
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error("HTTP timeout")),
        this.options.timeoutMs,
      );
      let failure: VenueError;
      try {
        const response = await this.options.fetch(`${this.baseUrl}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "User-Agent": this.options.userAgent,
            "Content-Type": "application/json",
          },
          body: serialized,
          signal: controller.signal,
        });
        const raw = await response.text();
        let parsed: unknown;
        try {
          parsed = raw ? parseAf(raw) : null;
        } catch {
          if (response.ok && response.headers.get("X-Error-Message") !== "true")
            throw new VenueError(
              "Invalid JSON response",
              "aftermath",
              "decode",
              false,
            );
          parsed = raw;
        }
        if (
          !response.ok ||
          response.headers.get("X-Error-Message") === "true" ||
          (parsed &&
            typeof parsed === "object" &&
            ("error" in parsed || "error_code" in parsed))
        )
          throw apiError(response, parsed);
        return parsed as T;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        failure =
          error instanceof VenueError
            ? error
            : new VenueError(
                controller.signal.aborted
                  ? "HTTP timeout"
                  : "HTTP network error",
                "aftermath",
                controller.signal.aborted ? "timeout" : "network",
                true,
                { cause: error },
              );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
      if (!read || !failure.retryable || attempt >= this.options.readRetries)
        throw failure;
      await this.options.sleep(
        Math.min(2000, 200 * 2 ** attempt) * (0.5 + this.options.random()),
      );
    }
  }
}
