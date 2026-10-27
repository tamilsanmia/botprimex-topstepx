import { bucketStart, timeframe } from './timeframes.js';

const EMA_ALPHA = 0.005;
const BLOCK_WARMUP = 200;
const MAX_FEATURE_CANDLES = 5000;

/**
 * Value area around the point of control: grow from the POC toward whichever
 * neighbour has more volume until `pct` of the session's volume is inside.
 */
export function valueArea(profile, pct = 70) {
  if (!profile.size) return { poc: null, vah: null, val: null };
  const levels = [...profile.entries()].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let pocIdx = 0;
  for (let i = 0; i < levels.length; i += 1) {
    total += levels[i][1];
    if (levels[i][1] > levels[pocIdx][1]) pocIdx = i;
  }
  const target = total * (pct / 100);
  let lo = pocIdx;
  let hi = pocIdx;
  let inside = levels[pocIdx][1];
  while (inside < target && (lo > 0 || hi < levels.length - 1)) {
    const down = lo > 0 ? levels[lo - 1][1] : -1;
    const up = hi < levels.length - 1 ? levels[hi + 1][1] : -1;
    if (up >= down) {
      hi += 1;
      inside += up;
    } else {
      lo -= 1;
      inside += down;
    }
  }
  return { poc: levels[pocIdx][0], vah: levels[hi][0], val: levels[lo][0] };
}

/**
 * Per-candle order flow features Freqtrade's own orderflow does not compute:
 *   cvd_session    cumulative (buy - sell) volume, reset at each session start
 *   delta          buy - sell volume in the candle
 *   block_count    prints >= block_multiple x the running average print size
 *   block_volume   volume of those prints, signed (+buy / -sell) in block_delta
 *   poc/vah/val    session volume profile from recorded ticks, as of candle close
 *   bid/ask/spread best bid/ask at candle close (1 Hz snapshots)
 *
 * O(session ticks) per call; production uses FeatureEngine, and this stays as the reference its parity tests compare against.
 */
export function computeFeatures({ ticks, tfMs, since, clock, blockMultiple = 25, valueAreaPct = 70, quoteAt = null }) {
  const rows = [];
  const byTs = new Map();
  let sessionStart = null;
  let cvd = 0;
  let profile = new Map();
  let avgSize = 0;
  let seen = 0;
  const profileStepMs = Math.max(tfMs, 60_000);
  let lastProfileAt = -Infinity;
  let lastVA = { poc: null, vah: null, val: null };

  const close = (row) => {
    if (row.ts + tfMs - lastProfileAt >= profileStepMs) {
      lastVA = valueArea(profile, valueAreaPct);
      lastProfileAt = row.ts + tfMs;
    }
    Object.assign(row, lastVA, { cvd_session: cvd });
    if (quoteAt) {
      const q = quoteAt(row.ts + tfMs - 1);
      if (q) Object.assign(row, { bid: q.bid, ask: q.ask, spread: q.ask - q.bid });
    }
  };

  let current = null;
  for (const [ts, price, size, side] of ticks) {
    const bucket = bucketStart(ts, tfMs);
    const newCandle = !current || current.ts !== bucket;
    // Close the previous candle before a session reset clears the running totals.
    if (newCandle && current) close(current);

    const start = clock.sessionStart(ts);
    if (start !== sessionStart) {
      sessionStart = start;
      cvd = 0;
      profile = new Map();
      lastProfileAt = -Infinity;
    }

    if (newCandle) {
      current = byTs.get(bucket);
      if (!current) {
        current = { ts: bucket, delta: 0, buy_volume: 0, sell_volume: 0, block_count: 0, block_volume: 0, block_delta: 0 };
        byTs.set(bucket, current);
        rows.push(current);
      }
    }

    const signed = side === 0 ? size : -size;
    cvd += signed;
    current.delta += signed;
    if (side === 0) current.buy_volume += size;
    else current.sell_volume += size;
    profile.set(price, (profile.get(price) || 0) + size);

    seen += 1;
    if (seen > BLOCK_WARMUP && size >= avgSize * blockMultiple) {
      current.block_count += 1;
      current.block_volume += size;
      current.block_delta += signed;
    }
    avgSize = avgSize > 0 ? avgSize + EMA_ALPHA * (size - avgSize) : size;
  }
  if (current) close(current);

  return rows.filter((r) => r.ts >= since).slice(-MAX_FEATURE_CANDLES);
}

const NO_VALUE_AREA = Object.freeze({ poc: null, vah: null, val: null });

/**
 * computeFeatures as a stream: push() is the reference loop body, step for step
 * and in the same order, so view() returns exactly what computeFeatures returns
 * for the ticks pushed so far. Ticks must arrive in (ts, seq) order.
 *
 * Differences that do not change the output:
 * - the session start is looked up only when a tick leaves the cached trading day;
 * - a candle is closed for good when the next candle opens; view() closes a copy
 *   of the open candle without touching the running state;
 * - the value area is memoised per profile version, so repeated views between
 *   ticks sort the price levels once;
 * - only the newest MAX_FEATURE_CANDLES closed candles are kept, which is all the
 *   reference can ever return.
 */
export class FeatureEngine {
  constructor({ tfMs, clock, blockMultiple = 25, valueAreaPct = 70, quoteAt = null, coverStart = null }) {
    this.tfMs = tfMs;
    this.clock = clock;
    this.blockMultiple = blockMultiple;
    this.valueAreaPct = valueAreaPct;
    this.quoteAt = quoteAt;
    this.profileStepMs = Math.max(tfMs, 60_000);
    // First tick time this engine has seen everything from, and the (ts, seq) of the last tick pushed.
    this.coverStart = coverStart;
    this.cursorTs = coverStart ?? -Infinity;
    this.cursorSeq = -1;

    this.rows = [];
    this.current = null;
    this.sessionStart = null;
    this.dayStart = null;
    this.dayEnd = null;
    this.cvd = 0;
    this.profile = new Map();
    this.profileVersion = 0;
    this.memo = { version: -1, va: NO_VALUE_AREA };
    this.avgSize = 0;
    this.seen = 0;
    this.lastProfileAt = -Infinity;
    this.lastVA = NO_VALUE_AREA;
  }

  get committedCount() {
    return this.rows.length;
  }

  /** clock.sessionStart(ts), recomputed only when ts leaves the cached trading day. */
  sessionOf(ts) {
    if (this.dayStart === null || ts < this.dayStart || ts >= this.dayEnd) {
      const day = this.clock.tradingDay(ts);
      this.dayStart = day.start;
      this.dayEnd = day.end;
    }
    return this.dayStart;
  }

  valueArea() {
    if (this.memo.version !== this.profileVersion) {
      this.memo = { version: this.profileVersion, va: valueArea(this.profile, this.valueAreaPct) };
    }
    return this.memo.va;
  }

  /** The reference's close(); with `commit` false the running VA step is left as it was. */
  close(row, commit) {
    let va = this.lastVA;
    if (row.ts + this.tfMs - this.lastProfileAt >= this.profileStepMs) {
      va = this.valueArea();
      if (commit) {
        this.lastVA = va;
        this.lastProfileAt = row.ts + this.tfMs;
      }
    }
    Object.assign(row, va, { cvd_session: this.cvd });
    if (this.quoteAt) {
      const q = this.quoteAt(row.ts + this.tfMs - 1);
      if (q) Object.assign(row, { bid: q.bid, ask: q.ask, spread: q.ask - q.bid });
    }
  }

  push(ts, price, size, side) {
    const bucket = bucketStart(ts, this.tfMs);
    const newCandle = !this.current || this.current.ts !== bucket;
    // Close the previous candle before a session reset clears the running totals.
    if (newCandle && this.current) {
      this.close(this.current, true);
      this.rows.push(this.current);
      if (this.rows.length > 2 * MAX_FEATURE_CANDLES) this.rows.splice(0, this.rows.length - MAX_FEATURE_CANDLES);
    }

    const start = this.sessionOf(ts);
    if (start !== this.sessionStart) {
      this.sessionStart = start;
      this.cvd = 0;
      this.profile = new Map();
      this.profileVersion += 1;
      this.lastProfileAt = -Infinity;
    }

    if (newCandle) {
      this.current = { ts: bucket, delta: 0, buy_volume: 0, sell_volume: 0, block_count: 0, block_volume: 0, block_delta: 0 };
    }
    const current = this.current;

    const signed = side === 0 ? size : -size;
    this.cvd += signed;
    current.delta += signed;
    if (side === 0) current.buy_volume += size;
    else current.sell_volume += size;
    this.profile.set(price, (this.profile.get(price) || 0) + size);
    this.profileVersion += 1;

    this.seen += 1;
    if (this.seen > BLOCK_WARMUP && size >= this.avgSize * this.blockMultiple) {
      current.block_count += 1;
      current.block_volume += size;
      current.block_delta += signed;
    }
    this.avgSize = this.avgSize > 0 ? this.avgSize + EMA_ALPHA * (size - this.avgSize) : size;
  }

  /** What computeFeatures returns for `since` over the ticks pushed so far. Closed rows are shared, not copied. */
  view(since) {
    const rows = this.rows;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (rows[mid].ts < since) lo = mid + 1;
      else hi = mid;
    }
    const out = rows.slice(Math.max(lo, rows.length - MAX_FEATURE_CANDLES));
    if (this.current && this.current.ts >= since) {
      const open = { ...this.current };
      this.close(open, false);
      out.push(open);
    }
    return out.length > MAX_FEATURE_CANDLES ? out.slice(-MAX_FEATURE_CANDLES) : out;
  }
}

/**
 * Order flow features per (root, timeframe, from). Freqtrade asks for the same
 * window on every bot loop and for every pair, and each answer replays a session of
 * ticks, which blocks the event loop for as long as the session is big. Answers are
 * therefore kept for `ttlMs`, keyed by the candle the request falls in: within one
 * candle and the TTL a repeated request costs a map lookup, and a new candle or an
 * expired entry recomputes. A cached answer can lag the live candle by up to ttlMs.
 *
 * The computation is synchronous, so two requests can never be in flight at once;
 * there is nothing to coalesce beyond the cache itself.
 */
export class OrderflowService {
  constructor({ tickStore, clock, blockMultiple = 25, valueAreaPct = 70, ttlMs = 5000, maxEntries = 64, now = () => Date.now() }) {
    this.tickStore = tickStore;
    this.clock = clock;
    this.blockMultiple = blockMultiple;
    this.valueAreaPct = valueAreaPct;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.cache = new Map();
    this.stats = { hits: 0, misses: 0 };
  }

  features(root, tf, since, until) {
    // A caller that names `until` asks about a fixed moment, which a cache keyed on "now" must not answer.
    if (until !== undefined) return this.compute(root, tf, since, until);

    const now = this.now();
    const tfMs = timeframe(tf).ms;
    // `since` is part of the key as given: rows before it are cut off, so a mid-candle value must not share an answer.
    const key = `${root}|${tf}|${since ?? 'default'}|${bucketStart(now, tfMs)}`;
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.ttlMs) {
      this.stats.hits += 1;
      return hit.rows;
    }
    this.stats.misses += 1;
    const rows = this.compute(root, tf, since, now);
    this.cache.delete(key);
    this.cache.set(key, { at: now, rows });
    this.evict(now);
    return rows;
  }

  evict(now) {
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= this.maxEntries && now - entry.at < this.ttlMs) break;
      this.cache.delete(key);
    }
  }

  compute(root, tf, since, until = Date.now()) {
    const tfMs = timeframe(tf).ms;
    const from = since ?? until - 500 * tfMs;
    const ticks = this.tickStore.ticks(root, this.clock.sessionStart(from), until);
    return computeFeatures({
      ticks,
      tfMs,
      since: from,
      clock: this.clock,
      blockMultiple: this.blockMultiple,
      valueAreaPct: this.valueAreaPct,
      quoteAt: (ts) => this.tickStore.quoteAt(root, ts),
    });
  }
}
