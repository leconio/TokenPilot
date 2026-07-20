export interface SerialPollerOptions {
  readonly name: string;
  readonly intervalMs: number;
  readonly run: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

/** A non-overlapping poll loop whose close waits for the active iteration. */
export class SerialPoller {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private stopped = true;
  private paused = false;

  constructor(private readonly options: SerialPollerOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 10) {
      throw new RangeError(`${options.name} interval must be at least 10 milliseconds`);
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.paused = false;
    this.schedule(0);
  }

  async pause(): Promise<void> {
    if (this.stopped || this.paused) return;
    this.paused = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.active;
  }

  resume(): void {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    this.schedule(0);
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.paused = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.active;
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.paused) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.active = this.iterate();
    }, delayMs);
    this.timer.unref();
  }

  private async iterate(): Promise<void> {
    try {
      await this.options.run();
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.active = null;
      this.schedule(this.options.intervalMs);
    }
  }
}
