import { GatewayError } from './errors.js';

/**
 * Priority sliding-window limiter, one window per ProjectX rate-limit bucket.
 *
 * ProjectX publishes 50 req/30s for retrieveBars and 200 req/60s for everything
 * else, and answers 429 past either. The limits here are set a little below that
 * so a burst from Freqtrade can never trip the gateway's own limiter.
 *
 * Lower priority numbers run first, so an order never waits behind a backfill.
 *
 * Two guards keep orders possible under load:
 *   - `orderReserve`: reads and background jobs may fill at most `limit - orderReserve`
 *     stamps of a window, so the last stamps are always free for orders.
 *   - `maxQueue`: the queue of non-order jobs is bounded. When it is full the oldest
 *     BACKGROUND job is shed, otherwise the new job is rejected. Orders are never
 *     shed or counted against the bound.
 * A shed job fails with RateLimitExceeded (flagged `shed`, so callers do not retry it).
 */
export const PRIORITY = Object.freeze({ ORDER: 0, READ: 1, BACKGROUND: 2 });

class Bucket {
  constructor(name, limit, windowMs, { orderReserve = 0, maxQueue = Infinity } = {}) {
    this.name = name;
    this.limit = limit;
    this.windowMs = windowMs;
    this.orderReserve = orderReserve;
    this.maxQueue = maxQueue;
    this.stamps = [];
    this.queue = [];
    this.pausedUntil = 0;
    this.timer = null;
    this.seq = 0;
    this.stats = { sent: 0, queuedPeak: 0, throttled429: 0, shed: 0, rejected: 0 };
  }

  /** Stamps a job of this priority may bring the window up to. */
  capFor(priority) {
    if (priority === PRIORITY.ORDER) return this.limit;
    return Math.max(1, this.limit - this.orderReserve);
  }

  prune(now) {
    while (this.stamps.length && now - this.stamps[0] >= this.windowMs) this.stamps.shift();
  }

  schedule(priority, fn) {
    return new Promise((resolve, reject) => {
      if (priority !== PRIORITY.ORDER && this.backlog() >= this.maxQueue) {
        const victim = this.queue.find((j) => j.priority === PRIORITY.BACKGROUND);
        if (victim) {
          this.queue.splice(this.queue.indexOf(victim), 1);
          this.stats.shed += 1;
          victim.reject(this.overload(`${this.name} queue is full, background request dropped`));
        } else {
          this.stats.rejected += 1;
          reject(this.overload(`${this.name} queue is full (${this.maxQueue}), request rejected`));
          return;
        }
      }
      this.insert({ priority, seq: this.seq += 1, fn, resolve, reject });
      this.stats.queuedPeak = Math.max(this.stats.queuedPeak, this.queue.length);
      // A pending timer was computed for the previous head of the queue; an order
      // that arrives now may be allowed to run sooner, so recompute.
      clearTimeout(this.timer);
      this.timer = null;
      this.drain();
    });
  }

  /** Queued jobs that count against `maxQueue` (everything but orders). */
  backlog() {
    let n = 0;
    for (const j of this.queue) if (j.priority !== PRIORITY.ORDER) n += 1;
    return n;
  }

  overload(message) {
    return Object.assign(new GatewayError(`ProjectX gateway overloaded: ${message}`, { status: 429, kind: 'RateLimitExceeded' }), { shed: true });
  }

  /** Keeps the queue ordered by (priority, arrival) without re-sorting it. */
  insert(job) {
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.queue[mid].priority <= job.priority) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, job);
  }

  drain() {
    if (this.timer) return;
    const now = Date.now();
    this.prune(now);

    while (this.queue.length && this.stamps.length < this.capFor(this.queue[0].priority) && now >= this.pausedUntil) {
      const job = this.queue.shift();
      this.stamps.push(now);
      this.stats.sent += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject);
    }

    if (!this.queue.length) return;

    // The queue is ordered by priority, so the head decides when the next job can go:
    // it needs the window to drop below its cap, i.e. enough old stamps to expire.
    const cap = this.capFor(this.queue[0].priority);
    const waitWindow = this.stamps.length >= cap ? this.stamps[this.stamps.length - cap] + this.windowMs - now : 0;
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
      orderReserve: this.orderReserve,
      maxQueue: Number.isFinite(this.maxQueue) ? this.maxQueue : null,
      used: this.stamps.length,
      queued: this.queue.length,
      ...this.stats,
    };
  }
}

export class RateLimiter {
  constructor({ bars_per_30s = 40, other_per_60s = 180, order_reserve = 20, max_queue = 500 } = {}) {
    const maxQueue = Number(max_queue) > 0 ? Number(max_queue) : Infinity;
    this.buckets = {
      // Bars are only fetched by the gateway itself, never by an order, so no reserve there.
      bars: new Bucket('bars', bars_per_30s, 30_000, { maxQueue }),
      other: new Bucket('other', other_per_60s, 60_000, { orderReserve: Math.max(0, Number(order_reserve) || 0), maxQueue }),
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
