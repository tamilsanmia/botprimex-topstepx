import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OrderflowService } from '../src/orderflow.js';
import { SessionClock } from '../src/session.js';

const MIN = 60_000;
const base = Date.UTC(2026, 9, 20, 14, 0, 0);

/** A tick store that counts reads and serves one buy and one sell per minute. */
function fakeStore() {
  const store = {
    reads: 0,
    ticks(root, since, until) {
      store.reads += 1;
      const out = [];
      for (let t = Math.floor(since / MIN) * MIN; t < until; t += MIN) {
        out.push([t + 1000, 6000, 3, 0], [t + 2000, 6000, 1, 1]);
      }
      return out;
    },
    quoteAt: () => null,
  };
  return store;
}

function setup(over = {}) {
  const store = fakeStore();
  const clock = new SessionClock({ timezone: 'America/New_York', reset_time: '18:00', eod_time: '16:10' });
  const time = { now: base + 30_000 };
  const service = new OrderflowService({ tickStore: store, clock, now: () => time.now, ...over });
  return { store, service, time };
}

test('a second request in the same candle within the TTL does not recompute', () => {
  const { store, service, time } = setup();
  const first = service.features('MES', '1m', base - 5 * MIN);
  assert.equal(store.reads, 1);
  assert.ok(first.length > 0);

  time.now += 2000;
  const second = service.features('MES', '1m', base - 5 * MIN);
  assert.equal(store.reads, 1, 'served from the cache');
  assert.equal(second, first);
  assert.deepEqual(service.stats, { hits: 1, misses: 1 });
});

test('the cache expires after the TTL', () => {
  const { store, service, time } = setup();
  service.features('MES', '1m', base - 5 * MIN);
  time.now += 4_999;
  service.features('MES', '1m', base - 5 * MIN);
  assert.equal(store.reads, 1);
  time.now += 2;
  service.features('MES', '1m', base - 5 * MIN);
  assert.equal(store.reads, 2, 'older than 5 s is recomputed');
});

test('a new candle recomputes even inside the TTL', () => {
  const { store, service, time } = setup({ ttlMs: 60 * MIN });
  service.features('MES', '1m', base - 5 * MIN);
  time.now = base + MIN + 1;
  service.features('MES', '1m', base - 5 * MIN);
  assert.equal(store.reads, 2);
});

test('root, timeframe and since each get their own entry', () => {
  const { store, service } = setup();
  service.features('MES', '1m', base - 5 * MIN);
  service.features('MNQ', '1m', base - 5 * MIN);
  service.features('MES', '5m', base - 5 * MIN);
  service.features('MES', '1m', base - 10 * MIN);
  service.features('MES', '1m', base - 5 * MIN + 30_000);
  service.features('MES', '1m', null);
  assert.equal(store.reads, 6);
  service.features('MES', '1m', null);
  service.features('MES', '1m', undefined);
  assert.equal(store.reads, 6, 'no since is its own repeatable key');
});

test('a mid-candle since is not answered from the aligned one', () => {
  const { service } = setup();
  const aligned = service.features('MES', '1m', base - 2 * MIN);
  const mid = service.features('MES', '1m', base - 2 * MIN + 30_000);
  assert.equal(aligned.length, mid.length + 1, 'the candle that opened before since is cut off');
});

test('an explicit until is never cached', () => {
  const { store, service } = setup();
  service.features('MES', '1m', base - 5 * MIN, base);
  service.features('MES', '1m', base - 5 * MIN, base);
  assert.equal(store.reads, 2);
  assert.equal(service.cache.size, 0);
});

test('the cache stays bounded and drops expired entries', () => {
  const { service, time } = setup({ maxEntries: 3 });
  for (let i = 0; i < 10; i += 1) service.features('MES', '1m', base - (i + 1) * MIN);
  assert.ok(service.cache.size <= 3, `size ${service.cache.size}`);

  time.now += 10_000;
  service.features('MES', '1m', base - 99 * MIN);
  assert.equal(service.cache.size, 1, 'expired entries were swept');
});

test('cached rows match a fresh computation', () => {
  const { service } = setup();
  const cached = service.features('MES', '1m', base - 5 * MIN);
  const fresh = service.compute('MES', '1m', base - 5 * MIN, base + 30_000);
  assert.deepEqual(cached, fresh);
});
