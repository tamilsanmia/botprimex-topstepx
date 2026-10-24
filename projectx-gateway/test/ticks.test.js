import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
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

test('old days are gzipped yet still readable, expired days are dropped', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticks-'));
  const store = new TickStore({ dir, retentionDays: 5 });
  const now = Date.UTC(2026, 9, 20, 12);
  const old = now - 3 * DAY;
  const expired = now - 10 * DAY;
  store.record('MES', { ts: old, price: 1, size: 1, side: 'buy' });
  store.record('MES', { ts: expired, price: 2, size: 1, side: 'sell' });
  store.flush();
  store.maintain(now);

  const day = (ts) => new Date(ts).toISOString().slice(0, 10);
  assert.ok(existsSync(path.join(dir, `${day(old)}.sqlite.gz`)));
  assert.ok(!existsSync(path.join(dir, `${day(old)}.sqlite`)));
  assert.ok(!existsSync(path.join(dir, `${day(expired)}.sqlite`)));
  assert.equal(store.ticks('MES', old - 1000, old + 1000).length, 1);
  store.close();
});
