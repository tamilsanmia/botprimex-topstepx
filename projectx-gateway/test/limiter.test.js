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
  const limiter = new RateLimiter({ bars_per_30s: 5, other_per_60s: 1, order_reserve: 0 });
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

/** Never-settling job: holds a stamp without finishing, which is all the window cares about. */
const idle = () => new Promise(() => {});
const ping = (limiter, priority, label, log) => limiter.schedule('/api/Order/search', priority, async () => { log.push(label); return label; });

test('order_reserve: reads saturate their share of the window but orders still pass', async () => {
  const limiter = new RateLimiter({ bars_per_30s: 5, other_per_60s: 10, order_reserve: 3, max_queue: 500 });
  const ran = [];
  const reads = Array.from({ length: 12 }, (_, i) => ping(limiter, PRIORITY.READ, `read${i}`, ran));
  reads.forEach((p) => p.catch(() => {}));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ran.length, 7, 'reads stop at limit - order_reserve');
  assert.equal(limiter.status().other.used, 7);
  assert.equal(limiter.status().other.queued, 5);

  for (let i = 0; i < 3; i += 1) await ping(limiter, PRIORITY.ORDER, `order${i}`, ran);
  assert.deepEqual(ran.slice(7), ['order0', 'order1', 'order2'], 'orders use the reserved stamps immediately');
  assert.equal(limiter.status().other.used, 10);
  assert.equal(limiter.status().other.queued, 5, 'the queued reads are still waiting');
});

test('an order queued behind reads goes first when the window frees up', async () => {
  const limiter = new RateLimiter({ bars_per_30s: 5, other_per_60s: 4, order_reserve: 1, max_queue: 500 });
  const keepAlive = setInterval(() => {}, 1000);
  const ran = [];
  const bucket = limiter.buckets.other;
  const first = Array.from({ length: 4 }, (_, i) => ping(limiter, PRIORITY.READ, `r${i}`, ran));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran.length, 3, 'one stamp is kept back for orders');
  const late = ping(limiter, PRIORITY.READ, 'late-read', ran);
  const order = ping(limiter, PRIORITY.ORDER, 'order', ran);
  await order;
  assert.equal(ran.at(-1), 'order');
  assert.ok(!ran.includes('late-read'));
  // Age the stamps out so the remaining reads can run.
  bucket.stamps = bucket.stamps.map((t) => t - 61_000);
  clearTimeout(bucket.timer);
  bucket.timer = null;
  bucket.drain();
  await Promise.all([...first, late]);
  clearInterval(keepAlive);
  assert.equal(ran.length, 6);
});

test('the queue never exceeds max_queue: a full queue rejects new reads with RateLimitExceeded', async () => {
  const limiter = new RateLimiter({ bars_per_30s: 5, other_per_60s: 2, order_reserve: 0, max_queue: 3 });
  const settled = [];
  const track = (p, label) => p.then(() => settled.push([label, 'ok']), (err) => settled.push([label, err.kind, err.status, err.shed]));
  limiter.schedule('/api/Order/search', PRIORITY.READ, idle);
  limiter.schedule('/api/Order/search', PRIORITY.READ, idle);
  for (let i = 0; i < 3; i += 1) track(limiter.schedule('/api/Order/search', PRIORITY.READ, async () => null), `q${i}`);
  track(limiter.schedule('/api/Order/search', PRIORITY.READ, async () => null), 'overflow');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(settled, [['overflow', 'RateLimitExceeded', 429, true]]);
  const st = limiter.status().other;
  assert.equal(st.queued, 3);
  assert.equal(st.rejected, 1);
  assert.equal(st.queuedPeak, 3);
});

test('shedding drops the oldest BACKGROUND job first, then rejects the new read; orders are never shed', async () => {
  const limiter = new RateLimiter({ bars_per_30s: 5, other_per_60s: 1, order_reserve: 0, max_queue: 3 });
  const keepAlive = setInterval(() => {}, 1000);
  const out = {};
  const track = (label, p) => p.then(() => { out[label] = 'ok'; }, (err) => { out[label] = err.kind; });
  limiter.schedule('/api/Order/search', PRIORITY.READ, idle);
  track('bg1', limiter.schedule('/api/Order/search', PRIORITY.BACKGROUND, async () => null));
  track('bg2', limiter.schedule('/api/Order/search', PRIORITY.BACKGROUND, async () => null));
  track('read1', limiter.schedule('/api/Order/search', PRIORITY.READ, async () => null));
  assert.equal(limiter.status().other.queued, 3);

  track('read2', limiter.schedule('/api/Order/search', PRIORITY.READ, async () => null));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(out.bg1, 'RateLimitExceeded', 'the oldest background job went');
  assert.equal(out.bg2, undefined);
  assert.equal(limiter.status().other.queued, 3);

  track('read3', limiter.schedule('/api/Order/search', PRIORITY.READ, async () => null));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(out.bg2, 'RateLimitExceeded');

  track('read4', limiter.schedule('/api/Order/search', PRIORITY.READ, async () => null));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(out.read4, 'RateLimitExceeded', 'no background job left, so the new read is rejected');
  assert.equal(out.read1, undefined);

  // Orders are admitted past the bound and never shed.
  for (let i = 0; i < 5; i += 1) track(`order${i}`, limiter.schedule('/api/Order/place', PRIORITY.ORDER, async () => null));
  assert.equal(limiter.status().other.queued, 3 + 5);
  assert.equal(limiter.status().other.shed, 2);
  assert.ok(!Object.keys(out).some((k) => k.startsWith('order')));
  clearInterval(keepAlive);
});

test('a background job is accepted by shedding an older background job when the queue is full', async () => {
  const limiter = new RateLimiter({ bars_per_30s: 5, other_per_60s: 1, order_reserve: 0, max_queue: 2 });
  const out = {};
  const track = (label, p) => p.then(() => { out[label] = 'ok'; }, (err) => { out[label] = err.kind; });
  limiter.schedule('/api/Order/search', PRIORITY.READ, idle);
  track('a', limiter.schedule('/api/Order/search', PRIORITY.BACKGROUND, async () => null));
  track('b', limiter.schedule('/api/Order/search', PRIORITY.BACKGROUND, async () => null));
  track('c', limiter.schedule('/api/Order/search', PRIORITY.BACKGROUND, async () => null));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(out.a, 'RateLimitExceeded');
  assert.equal(limiter.status().other.queued, 2);
  assert.deepEqual(limiter.buckets.other.queue.map((j) => j.seq), [3, 4], 'b and c remain, in arrival order');
});

test('the queue stays ordered by priority then arrival without re-sorting', () => {
  const limiter = new RateLimiter({ bars_per_30s: 5, other_per_60s: 1, order_reserve: 0, max_queue: 100 });
  limiter.schedule('/api/Order/search', PRIORITY.READ, idle);
  const seen = [];
  const plan = [PRIORITY.BACKGROUND, PRIORITY.READ, PRIORITY.ORDER, PRIORITY.READ, PRIORITY.BACKGROUND, PRIORITY.ORDER];
  plan.forEach((p) => { limiter.schedule('/api/Order/search', p, async () => seen.push(p)).catch(() => {}); });
  assert.deepEqual(limiter.buckets.other.queue.map((j) => [j.priority, j.seq]), [[0, 4], [0, 7], [1, 3], [1, 5], [2, 2], [2, 6]]);
});

test('an unlimited-looking max_queue of 0 disables the bound, and the bars bucket has no reserve', async () => {
  const limiter = new RateLimiter({ bars_per_30s: 3, other_per_60s: 5, order_reserve: 20, max_queue: 0 });
  const ran = [];
  for (let i = 0; i < 3; i += 1) limiter.schedule('/api/History/retrieveBars', PRIORITY.READ, async () => ran.push(i));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran.length, 3, 'bars use their whole window');
  assert.equal(limiter.status().bars.orderReserve, 0);
  assert.equal(limiter.status().other.maxQueue, null);
  for (let i = 0; i < 50; i += 1) limiter.schedule('/api/Order/search', PRIORITY.BACKGROUND, idle).catch(() => {});
  assert.equal(limiter.status().other.shed, 0);
});

test('a reserve larger than the window still lets one non-order job through', async () => {
  const limiter = new RateLimiter({ bars_per_30s: 5, other_per_60s: 5, order_reserve: 20 });
  const ran = [];
  limiter.schedule('/api/Order/search', PRIORITY.READ, async () => ran.push('a')).catch(() => {});
  limiter.schedule('/api/Order/search', PRIORITY.READ, async () => ran.push('b')).catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ran, ['a']);
});
