/** Fixed-window counter per key (an IP address, a socket). */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Counts one hit for `key`. Returns false once `key` is over the limit in this window. */
  take(key: string, nowMs = Date.now()): boolean {
    const window = this.windows.get(key);
    if (!window || window.resetAt <= nowMs) {
      this.windows.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      return true;
    }
    window.count += 1;
    return window.count <= this.limit;
  }

  /** Forgets finished windows so the map does not grow forever. */
  prune(nowMs = Date.now()): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= nowMs) this.windows.delete(key);
    }
  }
}
