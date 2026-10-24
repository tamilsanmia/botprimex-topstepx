import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PRIORITY, RateLimiter } from '../src/limiter.js';

test('bars bucket never exceeds its window under a burst', async () => {
  const limiter = new RateLimiter({ bars_per_30s: 5, other_per_60s: 100 });
  const started = [];
  const jobs = [];
  for (let i = 0; i < 8; i += 1) {
    jobs.push(limiter.schedule('/api/History/retrieveBars', PRIORITY.READ, async () => started.push(i)));
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(started.length, 5, 'only the window limit runs immediately');
  assert.equal(limiter.status().bars.queued, 3);
  assert.equal(limiter.status().other.used, 0, 'buckets are independent');
});

test('orders jump ahead of queued reads', async () => {
  const limiter = new RateLimiter({ bars_per_30s: 5, other_per_60s: 1 });
  const order = [];
  await limiter.schedule('/api/Order/searchOpen', PRIORITY.READ, async () => order.push('first'));
  const later = [
    limiter.schedule('/api/Order/searchOpen', PRIORITY.BACKGROUND, async () => order.push('background')),
    limiter.schedule('/api/Order/search', PRIORITY.READ, async () => order.push('read')),
    limiter.schedule('/api/Order/place', PRIORITY.ORDER, async () => order.push('order')),
  ];
  const bucket = limiter.buckets.other;
  bucket.stamps = [];
  clearTimeout(bucket.timer);
  bucket.timer = null;
  bucket.limit = 3;
  bucket.drain();
  await Promise.all(later);
  assert.deepEqual(order, ['first', 'order', 'read', 'background']);
});

test('backoff pauses a bucket after a 429', async () => {
  const limiter = new RateLimiter({ bars_per_30s: 5, other_per_60s: 5 });
  // The limiter's timers are unref'd so they never hold the gateway open; keep the loop alive here.
  const keepAlive = setInterval(() => {}, 1000);
  limiter.backoff('/api/Order/search', 200);
  const t0 = Date.now();
  await limiter.schedule('/api/Order/search', PRIORITY.READ, async () => null);
  clearInterval(keepAlive);
  assert.ok(Date.now() - t0 >= 180);
  assert.equal(limiter.status().other.throttled429, 1);
});
