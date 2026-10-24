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

export class OrderflowService {
  constructor({ tickStore, clock, blockMultiple = 25, valueAreaPct = 70 }) {
    this.tickStore = tickStore;
    this.clock = clock;
    this.blockMultiple = blockMultiple;
    this.valueAreaPct = valueAreaPct;
  }

  features(root, tf, since, until = Date.now()) {
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
