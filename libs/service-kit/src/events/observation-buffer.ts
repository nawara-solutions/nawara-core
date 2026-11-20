/**
 * Core V2 DO-43b (the Owner's D43-1; DEVELOPMENT AND SIMULATION DIAGNOSTICS ONLY): a bounded, non-blocking buffer between a hot path
 * that must never wait (the bus's dead-letter branch) and a slow sink (a database). TECHNICAL ONLY: it knows nothing of what it carries.
 *
 * - `offer` is synchronous and O(1): it appends, or, when the buffer holds `capacity` items, refuses and counts `droppedOverflow`. It never
 *   throws, awaits, retries or blocks.
 * - A background timer (unref'd: it never keeps a process alive) flushes at most `batchMax` items every `flushIntervalMs`, one flush at a
 *   time, to `sink`. A flush that throws (the database unavailable) loses that batch and counts it in `droppedSink`: nothing is requeued,
 *   so an outage can never grow the buffer or slow the hot path. A sink may report rows it `rejected` (a schema refusal): counted apart.
 * - `stats()` is the cumulative counters of this buffer's life. They only grow; a new process starts a new buffer at zero, which a reader
 *   must treat as a new instance (never as a decrease).
 * - `stop()` stops the timer, then flushes what is left once, batch by batch; whatever it cannot write is counted as lost.
 */
export interface ObservationSinkResult { stored: number; duplicate?: number; rejected?: number }
export type ObservationSink<T> = (batch: readonly T[]) => Promise<ObservationSinkResult>;

export interface ObservationBufferOptions<T> {
  capacity: number;
  flushIntervalMs: number;
  /** Items per flush (default: `capacity`). */
  batchMax?: number;
  sink: ObservationSink<T>;
  /** Told once per failed flush (no value of the error, only that it failed): for a log line or a counter. Its own errors are ignored. */
  onSinkFailure?: (lost: number, error: unknown) => void;
}

export interface ObservationBufferStats {
  /** Offered and accepted into the buffer. */
  observedTotal: number;
  /** Written by the sink (new rows plus already-present duplicates: both are durable). */
  persistedTotal: number;
  /** Refused at `offer`: the buffer was full. */
  droppedOverflow: number;
  /** Lost in a flush that failed. */
  droppedSink: number;
  /** Refused by the sink's schema (never stored). */
  rejectedTotal: number;
  /** Waiting in the buffer now. */
  buffered: number;
}

export class BoundedObservationBuffer<T> {
  private readonly items: T[] = [];
  private readonly counters = { observedTotal: 0, persistedTotal: 0, droppedOverflow: 0, droppedSink: 0, rejectedTotal: 0 };
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private stopped = false;
  private readonly batchMax: number;

  constructor(private readonly opts: ObservationBufferOptions<T>) {
    if (!Number.isInteger(opts.capacity) || opts.capacity < 1 || opts.capacity > 1_000_000) throw new Error('observation buffer capacity must be an integer from 1 to 1000000');
    if (!Number.isInteger(opts.flushIntervalMs) || opts.flushIntervalMs < 10 || opts.flushIntervalMs > 3_600_000) throw new Error('observation buffer flushIntervalMs must be an integer from 10 to 3600000');
    this.batchMax = opts.batchMax ?? opts.capacity;
    if (!Number.isInteger(this.batchMax) || this.batchMax < 1) throw new Error('observation buffer batchMax must be a positive integer');
  }

  /** Synchronous, never throws: accepted (true) or dropped and counted (false). After `stop()`, everything is dropped and counted. */
  offer(item: T): boolean {
    if (this.stopped || this.items.length >= this.opts.capacity) {
      this.counters.droppedOverflow++;
      return false;
    }
    this.items.push(item);
    this.counters.observedTotal++;
    return true;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);
    this.timer.unref();
  }

  stats(): ObservationBufferStats {
    return { ...this.counters, buffered: this.items.length };
  }

  /** One flush at a time; a call while one runs waits for it (and does not start another). Never rejects. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.items.length === 0) return Promise.resolve();
    const batch = this.items.splice(0, this.batchMax);
    this.flushing = (async () => {
      try {
        const r = await this.opts.sink(batch);
        const rejected = Math.max(0, Math.min(batch.length, r.rejected ?? 0));
        this.counters.rejectedTotal += rejected;
        this.counters.persistedTotal += batch.length - rejected;
      } catch (e) {
        this.counters.droppedSink += batch.length;
        try {
          this.opts.onSinkFailure?.(batch.length, e);
        } catch {
          // a failing reporter changes nothing
        }
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  /** Stops accepting, stops the timer, waits for a running flush, then flushes what is left once, batch by batch (best effort). */
  async stop(): Promise<ObservationBufferStats> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.flushing) await this.flushing;
    while (this.items.length > 0) {
      const before = this.items.length;
      await this.flush();
      if (this.items.length >= before) break;
    }
    return this.stats();
  }
}
