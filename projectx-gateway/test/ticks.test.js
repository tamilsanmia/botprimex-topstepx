import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { TickStore } from '../src/ticks.js';

const DAY = 24 * 60 * 60 * 1000;

test('records, paginates by time and keeps same-ms prints apart', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticks-'));
  const store = new TickStore({ dir });
  const t0 = Date.UTC(2026, 9, 20, 14);
  store.record('MES', { ts: t0, price: 6000, size: 1, side: 'buy' });
  store.record('MES', { ts: t0, price: 6000, size: 2, side: 'sell' });
  store.record('MES', { ts: t0 + 5, price: 6000.25, size: 3, side: 'buy' });
  store.record('MNQ', { ts: t0 + 1, price: 21000, size: 1, side: 'sell' });
  store.recordQuote('MES', t0 + 2, 5999.75, 6000.25);

  const page1 = store.publicTrades('MES', 'MES/USD:USD', t0, 2);
  assert.deepEqual(page1.map((t) => [t.id, t.side, t.amount]), [[`${t0}-0`, 'buy', 1], [`${t0}-1`, 'sell', 2]]);
  const page2 = store.publicTrades('MES', 'MES/USD:USD', t0 + 1, 10);
  assert.deepEqual(page2.map((t) => t.price), [6000.25]);
  assert.equal(store.ticks('MNQ', t0, t0 + 10).length, 1);
  assert.deepEqual(store.quoteAt('MES', t0 + 500), { ts: t0, bid: 5999.75, ask: 6000.25 });
  store.close();
});

test('old days are gzipped yet still readable, expired days are dropped', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticks-'));
  const store = new TickStore({ dir, retentionDays: 5 });
  const now = Date.UTC(2026, 9, 20, 12);
  const old = now - 3 * DAY;
  const expired = now - 10 * DAY;
  store.record('MES', { ts: old, price: 1, size: 1, side: 'buy' });
  store.record('MES', { ts: expired, price: 2, size: 1, side: 'sell' });
  store.flush();
  await store.maintain(now);

  const day = (ts) => new Date(ts).toISOString().slice(0, 10);
  assert.ok(existsSync(path.join(dir, `${day(old)}.sqlite.gz`)));
  assert.ok(!existsSync(path.join(dir, `${day(old)}.sqlite`)));
  assert.ok(!existsSync(path.join(dir, `${day(expired)}.sqlite`)));
  assert.equal(store.ticks('MES', old - 1000, old + 1000).length, 1);
  store.close();
});

const day = (ts) => new Date(ts).toISOString().slice(0, 10);

test('60k prints in one millisecond are all kept, in arrival order', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticks-'));
  const store = new TickStore({ dir });
  const t0 = Date.UTC(2026, 9, 20, 14);
  for (let i = 0; i < 60_000; i += 1) store.record('MES', { ts: t0, price: 6000 + (i % 10) / 4, size: 1 + (i % 3), side: i % 2 ? 'buy' : 'sell' });

  const rows = store.ticks('MES', t0, t0 + 1);
  assert.equal(rows.length, 60_000);
  assert.deepEqual(rows.slice(0, 3).map((r) => [r[1], r[2], r[3], r[4]]), [[6000, 1, 1, 0], [6000.25, 2, 0, 1], [6000.5, 3, 1, 2]]);
  assert.equal(rows.at(-1)[4], 59_999, 'sequence numbers run without gaps or repeats');
  store.close();
});

test('same-millisecond sequence numbers survive 100k distinct timestamps in between', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticks-'));
  const store = new TickStore({ dir });
  const t0 = Date.UTC(2026, 9, 20, 14);
  store.record('MES', { ts: t0, price: 1, size: 1, side: 'buy' });
  // The old global map was cleared after 50 000 distinct keys, so a print arriving in a
  // millisecond that had already been counted restarted at seq 0 and was dropped as a duplicate key.
  for (let i = 1; i <= 100_000; i += 1) store.record('MES', { ts: t0 + i, price: 2, size: 1, side: 'sell' });
  store.record('MES', { ts: t0 + 100_000, price: 3, size: 1, side: 'buy' });
  store.record('MES', { ts: t0 + 100_000, price: 4, size: 1, side: 'buy' });

  const rows = store.ticks('MES', t0, t0 + 100_001);
  assert.equal(rows.length, 100_003);
  assert.deepEqual(store.ticks('MES', t0 + 100_000, t0 + 100_001).map((r) => [r[1], r[4]]), [[2, 0], [3, 1], [4, 2]]);
  store.close();
});

test('sequence numbers are kept per root and tolerate slightly out-of-order prints', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticks-'));
  const store = new TickStore({ dir });
  const t0 = Date.UTC(2026, 9, 20, 14);
  store.record('MES', { ts: t0, price: 1, size: 1, side: 'buy' });
  store.record('MNQ', { ts: t0, price: 2, size: 1, side: 'buy' });
  store.record('MES', { ts: t0 + 1, price: 3, size: 1, side: 'buy' });
  store.record('MES', { ts: t0, price: 4, size: 1, side: 'sell' });
  assert.deepEqual(store.ticks('MES', t0, t0 + 2).map((r) => [r[0], r[4]]), [[t0, 0], [t0, 1], [t0 + 1, 0]]);
  assert.deepEqual(store.ticks('MNQ', t0, t0 + 2).map((r) => [r[0], r[4]]), [[t0, 0]]);
  assert.ok(store.seqByRoot.get('MES').size <= 1024, 'the counters are bounded');
  store.close();
});

test('the per-root counters stay bounded under many distinct timestamps', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticks-'));
  const store = new TickStore({ dir });
  for (let i = 0; i < 20_000; i += 1) store.nextSeq('MES', i);
  assert.ok(store.seqByRoot.get('MES').size <= 1024);
  assert.equal(store.nextSeq('MES', 19_999), 1, 'recent timestamps keep counting');
  store.close();
});

test('flushAsync writes in chunks of at most 2000 rows and yields to the event loop between them', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticks-'));
  const store = new TickStore({ dir });
  const t0 = Date.UTC(2026, 9, 20, 14);
  for (let i = 0; i < 5_000; i += 1) store.record('MES', { ts: t0 + i, price: 6000, size: 1, side: 'buy' });

  const chunks = [];
  const original = store.writeRows.bind(store);
  store.writeRows = (ticks, quotes) => { chunks.push(ticks.length); original(ticks, quotes); };
  const done = store.flushAsync();
  assert.equal(store.flushAsync(), done, 'a second call joins the running flush');
  await done;

  assert.deepEqual(chunks, [2000, 2000, 1000]);
  assert.equal(store.pending.length, 0);
  assert.equal(store.flushing, null);
  assert.equal(store.stats.written, 5_000);
  assert.equal(store.ticks('MES', t0, t0 + 5_000).length, 5_000);
  store.close();
});

test('a read during a chunked flush still sees the rows that were not written yet', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticks-'));
  const store = new TickStore({ dir });
  const t0 = Date.UTC(2026, 9, 20, 14);
  for (let i = 0; i < 4_500; i += 1) store.record('MES', { ts: t0 + i, price: 6000, size: 1, side: 'buy' });
  const flushing = store.flushAsync();
  // The first chunk is written synchronously; the rest wait for the next turn.
  assert.ok(store.pending.length > 0, 'part of the batch is still pending');
  assert.equal(store.ticks('MES', t0, t0 + 4_500).length, 4_500, 'the read flushes the remainder itself');
  await flushing;
  assert.equal(store.ticks('MES', t0, t0 + 4_500).length, 4_500, 'and nothing is written twice');
  store.close();
});

test('the interval timer flushes through flushAsync', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticks-'));
  const store = new TickStore({ dir });
  const t0 = Date.UTC(2026, 9, 20, 14);
  store.record('MES', { ts: t0, price: 6000, size: 1, side: 'buy' });
  // A ref'd timer keeps the event loop alive while the unref'd flush timer fires.
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(store.pending.length, 0);
  assert.equal(store.stats.written, 1);
  store.close();
});

test('close() flushes what is pending and stops a chunked flush that is in progress', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticks-'));
  const store = new TickStore({ dir });
  const t0 = Date.UTC(2026, 9, 20, 14);
  for (let i = 0; i < 4_500; i += 1) store.record('MES', { ts: t0 + i, price: 6000, size: 1, side: 'buy' });
  const flushing = store.flushAsync();
  store.close();
  await flushing;
  assert.equal(store.pending.length, 0);
  const reopened = new TickStore({ dir });
  assert.equal(reopened.ticks('MES', t0, t0 + 4_500).length, 4_500, 'every row reached disk');
  reopened.close();
});

test('maintain() gzips an old day through a stream and ticks() still reads it back', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticks-'));
  const store = new TickStore({ dir, retentionDays: 30 });
  const now = Date.UTC(2026, 9, 20, 12);
  const old = now - 4 * DAY;
  for (let i = 0; i < 3_000; i += 1) store.record('MES', { ts: old + i, price: 6000 + i / 100, size: 1, side: 'buy' });
  store.recordQuote('MES', old + 5, 5999.75, 6000.25);
  store.record('MES', { ts: now, price: 7000, size: 1, side: 'sell' });
  store.flush();

  const run = store.maintain(now);
  assert.equal(store.maintain(now), run, 'a second call joins the run in progress');
  await run;

  const files = readdirSync(dir).sort();
  assert.ok(files.includes(`${day(old)}.sqlite.gz`), files.join(','));
  assert.ok(!files.some((f) => f.startsWith(`${day(old)}.sqlite`) && !f.endsWith('.gz')), 'the raw file and its WAL are gone');
  assert.ok(!files.some((f) => f.endsWith('.partial')));
  assert.ok(files.includes(`${day(now)}.sqlite`), 'today is left alone');
  assert.equal(store.maintaining, null);

  assert.equal(store.ticks('MES', old - 1000, old + 10_000).length, 3_000);
  assert.deepEqual(store.quoteAt('MES', old + 500), { ts: old, bid: 5999.75, ask: 6000.25 });
  assert.equal(store.ticks('MES', now - 1000, now + 1000).length, 1);
  store.close();
});

test('maintain() twice is harmless and a .partial file left by a crash is never read as data', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticks-'));
  const store = new TickStore({ dir });
  const now = Date.UTC(2026, 9, 20, 12);
  const old = now - 3 * DAY;
  const other = now - 5 * DAY;
  writeFileSync(path.join(dir, `${day(other)}.sqlite.gz.partial`), 'truncated');
  store.record('MES', { ts: old, price: 1, size: 1, side: 'buy' });
  store.flush();
  await store.maintain(now);
  await store.maintain(now);
  assert.equal(store.ticks('MES', old - 1000, old + 1000).length, 1);
  assert.equal(store.ticks('MES', other - 1000, other + 1000).length, 0, 'a partial file is not a day');
  store.close();
});

test('maintain() keeps the live file when a late print reopened the day during the gzip', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticks-'));
  const store = new TickStore({ dir });
  const now = Date.UTC(2026, 9, 20, 12);
  const old = now - 3 * DAY;
  store.record('MES', { ts: old, price: 1, size: 1, side: 'buy' });
  store.flush();
  const run = store.maintain(now);
  store.record('MES', { ts: old + 1, price: 2, size: 1, side: 'sell' }); // reopens the day while it compresses
  store.flush();
  await run;
  const files = readdirSync(dir);
  assert.ok(files.includes(`${day(old)}.sqlite`), 'the live file is still there');
  assert.ok(!files.some((f) => f.endsWith('.partial')));
  assert.equal(store.ticks('MES', old - 1000, old + 1000).length, 2, 'no print was lost');
  store.close();
});
