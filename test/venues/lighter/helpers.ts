import type { Clock, Market, Order } from "../../../src/venues/lighter/types";
import type { Socket } from "../../../src/venues/lighter/ws";
export class FakeClock implements Clock {
  time = 1000000;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  }
  clearTimeout(id: unknown): void {
    this.timers.delete(id as number);
  }
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
    }
    this.time = end;
  }
}
export class FakeSocket implements Socket {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(s: string): void {
    this.sent.push(JSON.parse(s));
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}
export const market: Market = {
  marketId: 1,
  symbol: "BTC",
  marketType: "perp",
  status: "active",
  sizeDecimals: 5,
  priceDecimals: 1,
  minBaseAmount: "0.00020",
  minQuoteAmount: "10",
  makerFee: "0",
  takerFee: "0",
  baseInterestRate: "0.0100",
};
export const order = (
  status = "filled",
  filledBase = "0.00123",
  filledQuote = "100.86",
  clientOrderIndex = 123n,
): Order => ({
  marketId: 1,
  clientOrderIndex,
  status,
  filledBase,
  filledQuote,
  fee: "0.02",
});
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
