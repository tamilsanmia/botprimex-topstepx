import { EventEmitter } from 'node:events';

import { MAX_BARS_PER_REQUEST } from './projectx.js';
import { PRIORITY } from './limiter.js';
import { ALIGN_SOURCE, aggregate, bucketStart, timeframe } from './timeframes.js';

const RECENT_TICK_MS = 15 * 60 * 1000;
const RECENT_TICK_MAX = 500_000;
const FLUSH_MS = 250;
const WIDEN_ATTEMPTS = 2;
const WIDEN_FACTOR = 4;

function applyTick(bars, ms, ts, price, size, maxCandles) {
  const start = bucketStart(ts, ms);
  const last = bars[bars.length - 1];
  if (last && last[0] === start) {
    if (price > last[2]) last[2] = price;
    if (price < last[3]) last[3] = price;
    last[4] = price;
    last[5] += size;
    return last;
  }
  if (!last || start > last[0]) {
    const bar = [start, price, price, price, price, size];
    bars.push(bar);
    if (bars.length > maxCandles) bars.splice(0, bars.length - maxCandles);
    return bar;
  }
  // Out-of-order tick for an older bucket: update it in place if still held.
  for (let i = bars.length - 2; i >= 0 && bars[i][0] >= start; i -= 1) {
    if (bars[i][0] === start) {
      bars[i][2] = Math.max(bars[i][2], price);
      bars[i][3] = Math.min(bars[i][3], price);
      bars[i][5] += size;
      return bars[i];
    }
  }
  return null;
}

/**
 * Candles for every (root, timeframe) Freqtrade asks for, built from the live
 * tick stream so steady-state candle reads cost zero gateway requests.
 *
 * A series is backfilled from retrieveBars once, on first use. Ticks that arrive
 * while that request is in flight are kept in a short ring and replayed onto the
 * REST bars when they land, so the live candle is not lost to the backfill.
 */
export class CandleStore extends EventEmitter {
  constructor({ fetchBars, maxCandles = 5000, backfillCandles = 1500 }) {
    super();
    this.fetchBars = fetchBars;
    this.maxCandles = maxCandles;
    this.backfillCandles = backfillCandles;
    this.series = new Map();
    this.recentTicks = new Map();
    this.lastTickTs = new Map();
    this.dirty = new Map();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.flushTimer.unref?.();
  }

  key(root, tf) {
    return `${root}|${tf}`;
  }

  getSeries(root, tf) {
    const key = this.key(root, tf);
    let s = this.series.get(key);
    if (!s) {
      s = { root, tf, ms: timeframe(tf).ms, bars: [], ready: false, loading: null, loadedCount: 0 };
      this.series.set(key, s);
    }
    return s;
  }

  onTick(root, ts, price, size) {
    if (!(price > 0) || !Number.isFinite(ts)) return;
    const amount = Number(size) > 0 ? Number(size) : 0;

    let ring = this.recentTicks.get(root);
    if (!ring) {
      ring = [];
      this.recentTicks.set(root, ring);
    }
    ring.push([ts, price, amount]);
    if (ring.length > RECENT_TICK_MAX || (ring.length > 1000 && ts - ring[0][0] > RECENT_TICK_MS)) {
      const cutoff = ts - RECENT_TICK_MS;
      let drop = 0;
      while (drop < ring.length && (ring[drop][0] < cutoff || ring.length - drop > RECENT_TICK_MAX)) drop += 1;
      ring.splice(0, drop);
    }
    this.lastTickTs.set(root, Math.max(this.lastTickTs.get(root) || 0, ts));

    for (const s of this.series.values()) {
      if (s.root !== root) continue;
      const bar = applyTick(s.bars, s.ms, ts, price, amount, this.maxCandles);
      if (bar) this.markDirty(s, bar);
    }
  }

  markDirty(s, bar) {
    const key = this.key(s.root, s.tf);
    let pending = this.dirty.get(key);
    if (!pending) {
      pending = new Map();
      this.dirty.set(key, pending);
    }
    pending.set(bar[0], bar);
  }

  flush() {
    if (!this.dirty.size) return;
    const batch = this.dirty;
    this.dirty = new Map();
    for (const [key, bars] of batch) {
      const [root, tf] = key.split('|');
      this.emit('candles', root, tf, [...bars.values()].sort((a, b) => a[0] - b[0]).map((b) => [...b]));
    }
  }

  /** Ensures a series is loaded with at least `minCandles` of history. */
  async ensure(root, tf, minCandles = 0) {
    const s = this.getSeries(root, tf);
    const want = Math.min(Math.max(minCandles, this.backfillCandles), MAX_BARS_PER_REQUEST);
    if (s.ready && s.loadedCount >= want) return s;
    if (s.loading) return s.loading;

    s.loading = (async () => {
      try {
        const requestedAt = Date.now();
        const bars = await this.backfill(root, tf, want, requestedAt);
        this.replace(s, bars, requestedAt, bars.length ? bars[0][0] : requestedAt);
        s.ready = true;
        s.loadedCount = Math.max(s.loadedCount, want);
        return s;
      } finally {
        s.loading = null;
      }
    })();
    return s.loading;
  }

  /**
   * Replaces bars from `fromTs` on with REST data, then replays the live ticks
   * received since the request went out.
   */
  replace(s, restBars, requestedAt, fromTs) {
    const kept = s.bars.filter((b) => b[0] < fromTs);
    const merged = kept.concat(restBars.map((b) => [...b]));
    const ring = this.recentTicks.get(s.root) || [];
    for (const [ts, price, size] of ring) {
      if (ts >= requestedAt) applyTick(merged, s.ms, ts, price, size, Number.MAX_SAFE_INTEGER);
    }
    if (merged.length > this.maxCandles) merged.splice(0, merged.length - this.maxCandles);
    s.bars = merged;
  }

  async backfill(root, tf, count, endTime = Date.now(), priority = PRIORITY.READ) {
    const spec = timeframe(tf);
    const intraday = spec.ms < 24 * 60 * 60 * 1000;
    let span = spec.ms * count * (intraday ? 10 : 2);
    let bars = [];

    for (let attempt = 0; attempt <= WIDEN_ATTEMPTS; attempt += 1) {
      const startTime = endTime - span;
      bars = await this.fetchAligned(root, tf, startTime, endTime, count, priority);
      const windowBound = bars.length < count && (!bars.length || bars[0][0] - startTime <= spec.ms * 3);
      if (!windowBound) break;
      span *= WIDEN_FACTOR;
    }
    return bars.slice(-count);
  }

  /**
   * Freqtrade expects candles aligned to UTC epoch multiples. If the gateway's
   * native bars for a timeframe are not, they are rebuilt from a finer timeframe.
   */
  async fetchAligned(root, tf, startTime, endTime, limit, priority) {
    const spec = timeframe(tf);
    const native = await this.fetchBars({ root, tf, startTime, endTime, limit, priority });
    const aligned = native.every((b) => b[0] % spec.ms === 0);
    const source = ALIGN_SOURCE[tf];
    if (aligned || !source) return native;

    const srcMs = timeframe(source).ms;
    const srcLimit = Math.min(MAX_BARS_PER_REQUEST, Math.ceil(limit * (spec.ms / srcMs)) + 1);
    const fine = await this.fetchBars({ root, tf: source, startTime, endTime, limit: srcLimit, priority });
    return aggregate(fine, spec.ms);
  }

  /** After a hub outage: refetch everything since the last tick seen. */
  async repair(root) {
    const lastTs = this.lastTickTs.get(root);
    if (!lastTs) return;
    const jobs = [];
    for (const s of this.series.values()) {
      if (s.root !== root || !s.ready) continue;
      const fromTs = bucketStart(lastTs, s.ms);
      const requestedAt = Date.now();
      const count = Math.min(MAX_BARS_PER_REQUEST, Math.ceil((requestedAt - fromTs) / s.ms) + 2);
      jobs.push(
        this.fetchAligned(root, s.tf, fromTs, requestedAt, count, PRIORITY.BACKGROUND)
          .then((bars) => this.replace(s, bars.filter((b) => b[0] >= fromTs), requestedAt, fromTs))
          .catch((err) => console.warn(`[candles] repair ${root} ${s.tf} failed: ${err.message}`)),
      );
    }
    await Promise.all(jobs);
    if (jobs.length) console.log(`[candles] repaired ${jobs.length} series for ${root}`);
  }

  /**
   * After a contract roll: refetches every ready series of the root over the span
   * it holds. Back-adjusted history shifts at each roll, so the bars held from
   * before it would otherwise keep the old prices and show a gap at the splice.
   * The new bars replace the old ones in one assignment, with the live ticks
   * received during the request replayed on top. A series whose refetch fails or
   * comes back empty keeps what it has.
   */
  async rebuild(root) {
    const jobs = [];
    for (const s of this.series.values()) {
      if (s.root !== root || !s.ready) continue;
      jobs.push(
        this.rebuildSeries(s).catch((err) => {
          console.warn(`[candles] rebuild ${root} ${s.tf} failed: ${err.message}`);
          return false;
        }),
      );
    }
    const done = await Promise.all(jobs);
    const rebuilt = done.filter(Boolean).length;
    if (jobs.length) console.log(`[candles] rebuilt ${rebuilt}/${jobs.length} series for ${root}`);
    return rebuilt;
  }

  async rebuildSeries(s) {
    const requestedAt = Date.now();
    const count = Math.min(MAX_BARS_PER_REQUEST, Math.max(s.loadedCount, s.bars.length));
    const bars = await this.backfill(s.root, s.tf, count, requestedAt, PRIORITY.BACKGROUND);
    if (!bars.length) return false;
    this.replace(s, bars, requestedAt, -Infinity);
    s.loadedCount = Math.max(s.loadedCount, count);
    return true;
  }

  /**
   * Candles from the store. `since` asks for history from a point; anything older
   * than what is held is fetched straight from REST (download-data paginates this way).
   */
  async get(root, tf, { since = null, limit = 1000 } = {}) {
    const cap = Math.min(Math.max(1, limit), MAX_BARS_PER_REQUEST);
    const s = this.getSeries(root, tf);
    const needed = since ? Math.ceil((Date.now() - since) / s.ms) : cap;
    await this.ensure(root, tf, Math.min(needed, MAX_BARS_PER_REQUEST));

    if (since && (!s.bars.length || since < s.bars[0][0])) {
      const end = Math.min(since + cap * s.ms, s.bars.length ? s.bars[0][0] : Date.now());
      const older = await this.fetchAligned(root, tf, since, end, cap, PRIORITY.BACKGROUND);
      const held = s.bars.filter((b) => b[0] >= since);
      const merged = older.filter((b) => !s.bars.length || b[0] < s.bars[0][0]).concat(held);
      return merged.slice(0, cap).map((b) => [...b]);
    }

    const rows = since ? s.bars.filter((b) => b[0] >= since).slice(0, cap) : s.bars.slice(-cap);
    return rows.map((b) => [...b]);
  }

  lastPrice(root) {
    const ring = this.recentTicks.get(root);
    return ring?.length ? ring[ring.length - 1][1] : null;
  }

  ticksSince(root, since) {
    const ring = this.recentTicks.get(root) || [];
    return ring.filter((t) => t[0] >= since);
  }

  status() {
    return [...this.series.values()].map((s) => ({
      root: s.root, tf: s.tf, ready: s.ready, candles: s.bars.length, last: s.bars.at(-1)?.[0] ?? null,
    }));
  }

  close() {
    clearInterval(this.flushTimer);
  }
}
