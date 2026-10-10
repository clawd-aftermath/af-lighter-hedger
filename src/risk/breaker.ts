export interface BreakerState {
  latched: boolean;
  reasons: readonly string[];
  trippedAt: number | null;
}

export interface BreakerStore {
  load(): BreakerState | null;
  save(state: BreakerState): void;
}

export class Breaker {
  private current: BreakerState;

  constructor(
    private readonly store: BreakerStore,
    private readonly clock: () => number,
  ) {
    const stored = store.load();
    this.current = stored
      ? { ...stored, reasons: [...stored.reasons] }
      : { latched: false, reasons: [], trippedAt: null };
  }

  get state(): BreakerState {
    return { ...this.current, reasons: [...this.current.reasons] };
  }

  trip(reason: string): BreakerState {
    if (!reason.trim()) throw new Error("breaker reason: required");
    const next: BreakerState = {
      latched: true,
      reasons: [...new Set([...this.current.reasons, reason])],
      trippedAt: this.current.trippedAt ?? this.clock(),
    };
    // Latch locally even if persistence fails; callers must treat store errors as fatal.
    this.current = next;
    this.store.save(this.state);
    return this.state;
  }

  reset(ack: { acknowledged: true; note: string }): BreakerState {
    if (ack.acknowledged !== true || !ack.note.trim())
      throw new Error(
        "breaker reset: explicit acknowledgement and note required",
      );
    const next: BreakerState = { latched: false, reasons: [], trippedAt: null };
    this.store.save(next);
    this.current = next;
    return this.state;
  }
}
