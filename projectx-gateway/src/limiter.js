/**
 * Priority sliding-window limiter, one window per ProjectX rate-limit bucket.
 *
 * ProjectX publishes 50 req/30s for retrieveBars and 200 req/60s for everything
 * else, and answers 429 past either. The limits here are set a little below that
 * so a burst from Freqtrade can never trip the gateway's own limiter.
 *
 * Lower priority numbers run first, so an order never waits behind a backfill.
 */
export const PRIORITY = Object.freeze({ ORDER: 0, READ: 1, BACKGROUND: 2 });

class Bucket {
  constructor(name, limit, windowMs) {
    this.name = name;
    this.limit = limit;
    this.windowMs = windowMs;
    this.stamps = [];
    this.queue = [];
    this.pausedUntil = 0;
    this.timer = null;
    this.seq = 0;
    this.stats = { sent: 0, queuedPeak: 0, throttled429: 0 };
  }

  prune(now) {
    while (this.stamps.length && now - this.stamps[0] >= this.windowMs) this.stamps.shift();
  }

  schedule(priority, fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ priority, seq: this.seq += 1, fn, resolve, reject });
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.stats.queuedPeak = Math.max(this.stats.queuedPeak, this.queue.length);
      this.drain();
    });
  }

  drain() {
    if (this.timer) return;
    const now = Date.now();
    this.prune(now);

    while (this.queue.length && this.stamps.length < this.limit && now >= this.pausedUntil) {
      const job = this.queue.shift();
      this.stamps.push(now);
      this.stats.sent += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject);
    }

    if (!this.queue.length) return;

    const waitWindow = this.stamps.length >= this.limit ? this.stamps[0] + this.windowMs - now : 0;
    const waitPause = Math.max(0, this.pausedUntil - now);
    const delay = Math.max(waitWindow, waitPause, 5);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, delay);
    this.timer.unref?.();
  }

  /** Called on a 429: the server's view of the window disagrees with ours, so back off. */
  backoff(ms) {
    this.stats.throttled429 += 1;
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  status() {
    this.prune(Date.now());
    return {
      limit: this.limit,
      windowMs: this.windowMs,
      used: this.stamps.length,
      queued: this.queue.length,
      ...this.stats,
    };
  }
}

export class RateLimiter {
  constructor({ bars_per_30s = 40, other_per_60s = 180 } = {}) {
    this.buckets = {
      bars: new Bucket('bars', bars_per_30s, 30_000),
      other: new Bucket('other', other_per_60s, 60_000),
    };
  }

  bucketFor(path) {
    return path === '/api/History/retrieveBars' ? this.buckets.bars : this.buckets.other;
  }

  schedule(path, priority, fn) {
    return this.bucketFor(path).schedule(priority, fn);
  }

  backoff(path, ms) {
    this.bucketFor(path).backoff(ms);
  }

  status() {
    return { bars: this.buckets.bars.status(), other: this.buckets.other.status() };
  }
}
