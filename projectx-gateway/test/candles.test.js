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

/* --------------------------------------------------------- rebuild at a roll -- */

const bar = (ts, close) => [ts, close, close + 1, close - 1, close, 10];

/** A 1m series of 10 bars where the contract rolled after bar 5 and the old bars sit 10 points lower. */
function rolledSeries(base) {
  const gap = Array.from({ length: 10 }, (_, i) => bar(base + i * MIN, i < 5 ? 100 + i : 120 + i));
  const adjusted = Array.from({ length: 10 }, (_, i) => bar(base + i * MIN, 120 + i));
  return { gap, adjusted };
}

test('rebuild refetches the held span so the pre-roll gap is gone', async (t) => {
  t.mock.method(console, 'log', () => {});
  const base = Math.floor((Date.now() - 20 * MIN) / MIN) * MIN;
  const { gap, adjusted } = rolledSeries(base);
  let served = gap;
  const store = new CandleStore({ backfillCandles: 10, fetchBars: async () => served.map((b) => [...b]) });
  const s = await store.ensure('MES', '1m');
  const jump = (bars) => Math.max(...bars.slice(1).map((b, i) => Math.abs(b[1] - bars[i][4])));
  assert.ok(jump(s.bars) > 10, 'the spliced series jumps at the roll');

  served = adjusted;
  assert.equal(await store.rebuild('MES'), 1);
  assert.deepEqual(s.bars, adjusted);
  assert.ok(jump(s.bars) <= 1, 'no jump after the rebuild');
  store.close();
});

test('rebuild replays ticks that arrive while the refetch is in flight', async (t) => {
  t.mock.method(console, 'log', () => {});
  const base = Math.floor((Date.now() - 20 * MIN) / MIN) * MIN;
  const { gap, adjusted } = rolledSeries(base);
  const bucket = Math.floor(Date.now() / MIN) * MIN;
  let served = gap;
  let gate = null;
  const store = new CandleStore({
    backfillCandles: 10,
    fetchBars: async () => {
      const rows = served.map((b) => [...b]);
      if (gate) await gate;
      return rows;
    },
  });
  const s = await store.ensure('MES', '1m');

  served = adjusted;
  let open;
  gate = new Promise((resolve) => { open = resolve; });
  const pending = store.rebuild('MES');
  store.onTick('MES', Date.now() + 5, 131, 2);
  assert.deepEqual(s.bars.slice(0, 10), gap, 'the old bars stay in place until the swap');
  open();
  await pending;

  assert.deepEqual(s.bars.slice(0, 10), adjusted);
  const last = s.bars.at(-1);
  assert.deepEqual(last, [bucket, 131, 131, 131, 131, 2], 'the live tick survived the swap');
  store.close();
});

test('rebuild keeps the old bars when the refetch fails or comes back empty', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const base = Math.floor((Date.now() - 20 * MIN) / MIN) * MIN;
  const { gap } = rolledSeries(base);
  let mode = 'ok';
  const store = new CandleStore({
    backfillCandles: 10,
    fetchBars: async () => {
      if (mode === 'fail') throw new Error('rate limited');
      return mode === 'empty' ? [] : gap.map((b) => [...b]);
    },
  });
  const s = await store.ensure('MES', '1m');
  const before = JSON.stringify(s.bars);

  mode = 'fail';
  assert.equal(await store.rebuild('MES'), 0);
  assert.equal(JSON.stringify(s.bars), before);
  assert.match(warn.mock.calls.at(-1).arguments[0], /rebuild MES 1m failed: rate limited/);

  mode = 'empty';
  assert.equal(await store.rebuild('MES'), 0);
  assert.equal(JSON.stringify(s.bars), before);
  store.close();
});

test('rebuild only touches ready series of the rolled root', async (t) => {
  t.mock.method(console, 'log', () => {});
  const calls = [];
  const store = new CandleStore({
    backfillCandles: 10,
    fetchBars: async ({ root, tf }) => {
      calls.push(`${root}|${tf}`);
      return [bar(Math.floor(Date.now() / MIN) * MIN, 100)];
    },
  });
  await store.ensure('MES', '1m');
  await store.ensure('MES', '5m');
  await store.ensure('MNQ', '1m');
  store.getSeries('MES', '15m'); // created but never loaded
  calls.length = 0;

  assert.equal(await store.rebuild('MES'), 2);
  assert.deepEqual(calls.sort(), ['MES|1m', 'MES|5m']);
  assert.equal(await store.rebuild('ZZ'), 0, 'an unknown root is a no-op');
  store.close();
});

test('rebuild asks for at least as many bars as the series holds', async (t) => {
  t.mock.method(console, 'log', () => {});
  const limits = [];
  const store = new CandleStore({ backfillCandles: 10, fetchBars: async ({ limit }) => { limits.push(limit); return []; } });
  const s = store.getSeries('MES', '1m');
  s.ready = true;
  s.loadedCount = 10;
  for (let i = 0; i < 300; i += 1) s.bars.push(bar(i * MIN, 100));
  await store.rebuild('MES');
  assert.ok(limits.length > 0 && limits.every((l) => l >= 300), `limits ${limits}`);
  store.close();
});
