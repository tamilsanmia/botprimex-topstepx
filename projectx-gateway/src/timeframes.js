import { BAR_UNIT } from './projectx.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Freqtrade timeframe -> { ms, unit, unitNumber } for retrieveBars.
 * Seconds timeframes are included because the 1s mode streams them live.
 */
export const TIMEFRAMES = Object.freeze({
  '1s': { ms: SEC, unit: BAR_UNIT.SECOND, unitNumber: 1 },
  '5s': { ms: 5 * SEC, unit: BAR_UNIT.SECOND, unitNumber: 5 },
  '10s': { ms: 10 * SEC, unit: BAR_UNIT.SECOND, unitNumber: 10 },
  '15s': { ms: 15 * SEC, unit: BAR_UNIT.SECOND, unitNumber: 15 },
  '30s': { ms: 30 * SEC, unit: BAR_UNIT.SECOND, unitNumber: 30 },
  '1m': { ms: MIN, unit: BAR_UNIT.MINUTE, unitNumber: 1 },
  '3m': { ms: 3 * MIN, unit: BAR_UNIT.MINUTE, unitNumber: 3 },
  '5m': { ms: 5 * MIN, unit: BAR_UNIT.MINUTE, unitNumber: 5 },
  '15m': { ms: 15 * MIN, unit: BAR_UNIT.MINUTE, unitNumber: 15 },
  '30m': { ms: 30 * MIN, unit: BAR_UNIT.MINUTE, unitNumber: 30 },
  '1h': { ms: HOUR, unit: BAR_UNIT.HOUR, unitNumber: 1 },
  '2h': { ms: 2 * HOUR, unit: BAR_UNIT.HOUR, unitNumber: 2 },
  '4h': { ms: 4 * HOUR, unit: BAR_UNIT.HOUR, unitNumber: 4 },
  '6h': { ms: 6 * HOUR, unit: BAR_UNIT.HOUR, unitNumber: 6 },
  '8h': { ms: 8 * HOUR, unit: BAR_UNIT.HOUR, unitNumber: 8 },
  '12h': { ms: 12 * HOUR, unit: BAR_UNIT.HOUR, unitNumber: 12 },
  '1d': { ms: DAY, unit: BAR_UNIT.DAY, unitNumber: 1 },
});

/**
 * Finer native timeframe to aggregate from when the gateway's own bars for `tf`
 * are not aligned to epoch multiples (Freqtrade requires UTC-aligned candles).
 */
export const ALIGN_SOURCE = Object.freeze({
  '2h': '1h', '4h': '1h', '6h': '1h', '8h': '1h', '12h': '1h', '1d': '1h',
});

export function timeframe(tf) {
  const spec = TIMEFRAMES[tf];
  if (!spec) throw new Error(`Unsupported timeframe ${tf}`);
  return spec;
}

export const bucketStart = (ts, ms) => Math.floor(ts / ms) * ms;

/** Aggregates oldest-first [ts,o,h,l,c,v] bars into `ms` buckets. */
export function aggregate(bars, ms) {
  const out = [];
  for (const bar of bars) {
    const start = bucketStart(bar[0], ms);
    const last = out[out.length - 1];
    if (last && last[0] === start) {
      last[2] = Math.max(last[2], bar[2]);
      last[3] = Math.min(last[3], bar[3]);
      last[4] = bar[4];
      last[5] += bar[5];
    } else {
      out.push([start, bar[1], bar[2], bar[3], bar[4], bar[5]]);
    }
  }
  return out;
}
