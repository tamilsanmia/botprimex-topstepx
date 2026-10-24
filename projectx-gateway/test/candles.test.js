import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CandleStore } from '../src/candles.js';
import { aggregate } from '../src/timeframes.js';

const MIN = 60_000;

function storeWith(restBars) {
  return new CandleStore({
    backfillCandles: 10,
    fetchBars: async ({ tf }) => (restBars[tf] || []).map((b) => [...b]),
  });
}

test('ticks build 1s bars that aggregate to the same 1m bar as direct 1m building', async () => {
  const store = storeWith({});
  const s1 = store.getSeries('MES', '1s');
  const m1 = store.getSeries('MES', '1m');
  s1.ready = true;
  m1.ready = true;
  const t0 = 10 * MIN;
  const ticks = [[t0 + 100, 100, 1], [t0 + 900, 101, 2], [t0 + 1500, 99, 1], [t0 + 30_000, 102, 3], [t0 + 59_999, 100.5, 1], [t0 + MIN, 103, 1]];
  for (const [ts, p, v] of ticks) store.onTick('MES', ts, p, v);

  const fromSeconds = aggregate(s1.bars, MIN);
  assert.deepEqual(fromSeconds, m1.bars);
  assert.deepEqual(m1.bars[0], [t0, 100, 102, 99, 100.5, 8]);
  assert.deepEqual(m1.bars[1], [t0 + MIN, 103, 103, 103, 103, 1]);
  store.close();
});

test('backfill keeps REST history and replays ticks that arrived during the request', async () => {
  const t0 = 100 * MIN;
  const now = Date.now();
  const bucket = Math.floor(now / MIN) * MIN;
  const store = storeWith({ '1m': [[t0, 1, 2, 0.5, 1.5, 10], [bucket, 5, 5, 5, 5, 1]] });
  const pending = store.ensure('MES', '1m');
  store.onTick('MES', now + 10, 6, 2);
  const s = await pending;
  const last = s.bars.at(-1);
  assert.equal(s.bars[0][0], t0);
  assert.equal(last[0], bucket);
  assert.equal(last[4], 6, 'live tick replayed onto the REST partial bar');
  assert.equal(last[2], 6);
  assert.equal(last[5], 3);
  store.close();
});

test('misaligned 4h bars are rebuilt from 1h', async () => {
  const H = 60 * MIN;
  const base = 1_000 * 4 * H;
  const store = storeWith({
    '4h': [[base + H, 1, 1, 1, 1, 1]],
    '1h': [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [base + i * H, 10 + i, 11 + i, 9 + i, 10.5 + i, 1]),
  });
  const bars = await store.fetchAligned('MES', '4h', base, base + 8 * H, 2, 1);
  assert.equal(bars.length, 2);
  assert.equal(bars[0][0], base);
  assert.equal(bars[0][1], 10);
  assert.equal(bars[0][4], 13.5);
  assert.equal(bars[0][5], 4);
  store.close();
});

test('emits coalesced candle updates', async () => {
  const store = storeWith({});
  store.getSeries('MES', '1m').ready = true;
  const got = [];
  store.on('candles', (root, tf, bars) => got.push([root, tf, bars.length]));
  store.onTick('MES', 5 * MIN, 1, 1);
  store.onTick('MES', 5 * MIN + 1, 2, 1);
  store.flush();
  assert.deepEqual(got, [['MES', '1m', 1]]);
  store.close();
});
