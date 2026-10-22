export function pollingDelay(failures: number, interval: number, retryAfterMs = 0, random = Math.random()) {
  const base = failures ? [5000, 10000, 20000, 30000, 60000][Math.min(failures - 1, 4)]! : interval;
  return Math.max(retryAfterMs, Math.min(60_000, Math.round(base * (0.85 + random * 0.3))));
}

/** One read at a time; visibility and focus never bypass an outage cooldown. */
export class PagePolling {
  private stopped = false;
  private visible = true;
  private pending = false;
  private running = false;
  private failures = 0;
  private nextReadAt = 0;
  private deferred = false;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  constructor(
    private readonly read: (signal: AbortSignal) => Promise<void>,
    private readonly interval = 3000,
    private readonly shouldPoll: () => boolean = () => true,
  ) {}
  /**
   * Wait one interval before the first read, and read then only if polling is
   * still wanted: for a page that was handed what the first read would fetch.
   */
  deferFirst() {
    this.deferred = true;
    this.nextReadAt = Date.now() + this.interval;
  }
  refresh = () => {
    clearTimeout(this.timer);
    if (this.stopped || !this.visible) return;
    const remaining = this.nextReadAt - Date.now();
    if (remaining > 0) { this.timer = setTimeout(this.refresh, remaining); return; }
    if (this.deferred) {
      this.deferred = false;
      if (!this.shouldPoll()) return;
    }
    if (this.running) { this.pending = true; return; }
    void this.run();
  };
  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible) this.refresh();
    else { clearTimeout(this.timer); this.pending = false; this.controller?.abort(); }
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.controller?.abort(); }
  private async run() {
    this.running = true;
    this.controller = new AbortController();
    let delay = this.interval;
    try {
      await this.read(this.controller.signal);
      this.failures = 0; this.nextReadAt = 0;
      delay = pollingDelay(0, this.interval);
    } catch (error) {
      if (!this.controller.signal.aborted) {
        const retryAfter = error && typeof error === "object" && "retryAfterMs" in error ? Number(error.retryAfterMs) || 0 : 0;
        delay = pollingDelay(++this.failures, this.interval, retryAfter);
        this.nextReadAt = Date.now() + delay;
        this.pending = false;
      }
    } finally {
      this.running = false;
      if (!this.stopped && this.visible) {
        if (this.pending) { this.pending = false; this.refresh(); }
        else this.timer = setTimeout(() => { if (this.shouldPoll()) this.refresh(); }, delay);
      }
    }
  }
}
