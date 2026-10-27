import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PerformanceObserver } from 'node:perf_hooks';

import { GatewayError } from '../src/errors.js';
import { OrderflowService, computeFeatures } from '../src/orderflow.js';
import { SessionClock } from '../src/session.js';
import { TickStore } from '../src/ticks.js';
import { timeframe } from '../src/timeframes.js';
import { sleep, tmpDir, waitFor } from './helpers.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const clock = new SessionClock({ timezone: 'America/New_York', reset_time: '18:00', eod_time: '16:10' });
// 2026-10-20 18:00 America/New_York = 22:00 UTC; the session before opened 24 h earlier.
const SESSION = Date.UTC(2026, 9, 20, 22);
const PREV_SESSION = SESSION - 24 * HOUR;

/** sessionStart memoised by minute (session starts are whole minutes), so the reference stays fast. */
const refClock = (() => {
  const cache = new Map();
  return {
    sessionStart(ts) {
      const key = Math.floor(ts / MIN);
      if (!cache.has(key)) cache.set(key, clock.sessionStart(ts));
      return cache.get(key);
    },
  };
})();

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** [ts, price, size, side] with same-millisecond bursts, gaps and block prints. */
function makeTicks({ start, end, seed = 1, meanGapMs = 3000, price = 6000 }) {
  const rnd = lcg(seed);
  const out = [];
  let ts = start;
  for (;;) {
    const r = rnd();
    if (r >= 0.25) ts += r < 0.995 ? 1 + Math.floor(rnd() * 2 * meanGapMs) : 90 * SEC + Math.floor(rnd() * 200 * SEC);
    if (ts >= end) return out;
    price = Math.max(1, price + (Math.floor(rnd() * 3) - 1) * 0.25);
    out.push([ts, price, rnd() < 0.01 ? 300 + Math.floor(rnd() * 300) : 1 + Math.floor(rnd() * 10), rnd() < 0.5 ? 0 : 1]);
  }
}

function setup({ now, ...over } = {}) {
  const tmp = tmpDir('of-svc-');
  const store = new TickStore({ dir: tmp.dir });
  const time = { now };
  const service = new OrderflowService({ tickStore: store, clock, now: () => time.now, ...over });
  return {
    store,
    service,
    time,
    done() {
      store.close();
      tmp.remove();
    },
  };
}

function record(store, root, ticks, { quotes = true } = {}) {
  for (const [ts, price, size, side] of ticks) {
    store.record(root, { ts, price, size, side: side === 0 ? 'buy' : 'sell' });
    if (quotes && ts % 7 !== 0) store.recordQuote(root, ts, price - 0.25, price + 0.25 * (1 + (ts % 3)));
  }
  store.flush();
}

/** What the old OrderflowService.compute answered: a full replay from sessionStart(from). */
function reference(store, root, tf, since, now) {
  const tfMs = timeframe(tf).ms;
  const from = since ?? now - 500 * tfMs;
  return computeFeatures({
    ticks: store.ticks(root, clock.sessionStart(from), now),
    tfMs,
    since: from,
    clock: refClock,
    blockMultiple: 25,
    valueAreaPct: 70,
    quoteAt: (ts) => store.quoteAt(root, ts),
  });
}

const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

/**
 * A 5 ms setInterval heartbeat. `wall` is the largest delay of a beat. On this shared
 * host an idle process also sees beats delayed by 100 ms and more while it is not
 * scheduled, and a single young-generation GC can take 50 ms, so `held` is the part
 * of a delay the code itself held the loop: bounded by the CPU the process used in it,
 * minus the GC pauses inside it. `rows` is the most `counter()` grew between two beats.
 */
function heartbeat(periodMs = 5, counter = () => 0) {
  const beats = [];
  const gcs = [];
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gcs.push([e.startTime, e.startTime + e.duration]);
  });
  observer.observe({ entryTypes: ['gc'] });
  let lastWall = performance.now();
  let lastCpu = cpuMs();
  let lastCount = counter();
  let rows = 0;
  const timer = setInterval(() => {
    const wall = performance.now();
    const cpu = cpuMs();
    const count = counter();
    beats.push([lastWall, wall, cpu - lastCpu]);
    rows = Math.max(rows, count - lastCount);
    lastWall = wall;
    lastCpu = cpu;
    lastCount = count;
  }, periodMs);
  return {
    async stop() {
      clearInterval(timer);
      // The stretch since the last beat counts too: a loop that never yields has no beats at all.
      beats.push([lastWall, performance.now(), cpuMs() - lastCpu]);
      rows = Math.max(rows, counter() - lastCount);
      await sleep(20); // GC entries are delivered asynchronously
      observer.disconnect();
      const stats = { beats: beats.length, wall: 0, held: 0, gc: 0, rows };
      for (const [from, to, cpu] of beats) {
        const late = to - from - periodMs;
        const gc = gcs.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
        stats.wall = Math.max(stats.wall, late);
        stats.gc = Math.max(stats.gc, gc);
        stats.held = Math.max(stats.held, Math.min(late, cpu) - gc);
      }
      return stats;
    },
  };
}

async function untilReady(fn) {
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (err.status !== 503) throw err;
      await sleep(5);
    }
  }
}

const TICKS = makeTicks({ start: PREV_SESSION - HOUR, end: SESSION + 2 * HOUR, seed: 11 });

test('answers equal the full-replay reference for 15s, 30s, 1m and a missing since', async () => {
  const ctx = setup({ now: SESSION + HOUR });
  try {
    record(ctx.store, 'MES', TICKS);
    const now = ctx.time.now;
    for (const tf of ['15s', '30s', '1m']) {
      for (const since of [SESSION + 20 * MIN, SESSION - 30 * MIN, null]) {
        const rows = await ctx.service.features('MES', tf, since);
        const expected = reference(ctx.store, 'MES', tf, since, now);
        assert.ok(expected.length > 10, `${tf} ${since} has rows`);
        assert.deepEqual(rows, expected, `${tf} since ${since}`);
        assert.equal(JSON.stringify(rows), JSON.stringify(expected));
        assert.ok(rows.some((r) => r.spread !== undefined), 'quotes are joined');
      }
    }
  } finally {
    ctx.done();
  }
});

test('a later request reads only the prints recorded since the last one', async () => {
  const ctx = setup({ now: SESSION + 30 * MIN + 7 * SEC });
  try {
    const t1 = ctx.time.now;
    const t2 = t1 + 3 * MIN;
    const early = makeTicks({ start: SESSION - HOUR, end: t1, seed: 5, meanGapMs: 500 });
    const late = [];
    for (let ts = t1; ts < t2; ts += 700) late.push([ts, 6001 + (ts % 5) * 0.25, 1 + (ts % 4), ts % 3 === 0 ? 1 : 0]);
    record(ctx.store, 'MES', early);
    const since = SESSION + 5 * MIN;
    assert.deepEqual(await ctx.service.features('MES', '15s', since), reference(ctx.store, 'MES', '15s', since, t1));

    let read = 0;
    const original = ctx.store.ticksAfter.bind(ctx.store);
    ctx.store.ticksAfter = (...args) => {
      const rows = original(...args);
      read += rows.length;
      return rows;
    };
    // Some of the new prints fall in the candle that was open at t1, the rest open new ones.
    assert.ok(late.some((t) => Math.floor(t[0] / 15_000) === Math.floor((t1 - 1) / 15_000)));
    assert.ok(late.some((t) => t[0] > t1 + 30 * SEC));
    record(ctx.store, 'MES', late);
    ctx.time.now = t2;
    const rows = await ctx.service.features('MES', '15s', since);
    assert.equal(read, late.length, 'only the new rows were read');
    assert.deepEqual(rows, reference(ctx.store, 'MES', '15s', since, t2));
  } finally {
    ctx.done();
  }
});

test('a since in an earlier session gets its own engine replayed from that session', async () => {
  const ctx = setup({ now: SESSION + HOUR });
  try {
    record(ctx.store, 'MES', TICKS);
    const now = ctx.time.now;
    const today = await ctx.service.features('MES', '1m', SESSION + 10 * MIN);
    assert.ok(today.every((r) => r.ts >= SESSION + 10 * MIN));
    const since = PREV_SESSION + 3 * HOUR;
    const earlier = await ctx.service.features('MES', '1m', since);
    assert.ok(earlier.some((r) => r.ts < SESSION), 'the previous session is included');
    assert.deepEqual(earlier, reference(ctx.store, 'MES', '1m', since, now));
    assert.deepEqual(await ctx.service.features('MES', '1m', SESSION + 10 * MIN), reference(ctx.store, 'MES', '1m', SESSION + 10 * MIN, now));
  } finally {
    ctx.done();
  }
});

test('the engine of the next session is kept current, so crossing into it is a warm request', async () => {
  const ctx = setup({ now: SESSION + HOUR });
  try {
    record(ctx.store, 'MES', TICKS);
    // 15s with no since starts 125 minutes back, in the previous session.
    await ctx.service.features('MES', '15s', null);
    const next = [...ctx.service.entries.keys()].find((k) => k === `MES|15s|${SESSION}`);
    assert.ok(next, 'an engine for the current session exists');
    await waitFor(() => ctx.service.entries.get(next).seeded && !ctx.service.entries.get(next).running);
    ctx.time.now = SESSION + 2 * HOUR + 10 * MIN; // since now falls in the current session
    let read = 0;
    const original = ctx.store.ticksAfter.bind(ctx.store);
    ctx.store.ticksAfter = (...args) => {
      const rows = original(...args);
      read += rows.length;
      return rows;
    };
    const rows = await ctx.service.features('MES', '15s', null);
    assert.deepEqual(rows, reference(ctx.store, 'MES', '15s', null, ctx.time.now));
    assert.ok(read < TICKS.filter((t) => t[0] >= SESSION).length, `only the gap was read (${read})`);
  } finally {
    ctx.done();
  }
});

test('a request that waits longer than waitMs gets a 503 while the replay goes on', async () => {
  const ctx = setup({ now: SESSION + 4 * HOUR, waitMs: 1 });
  try {
    const ticks = [];
    for (let i = 0; i < 200_000; i += 1) ticks.push([SESSION + i * 60, 21000 + (i % 80) * 0.25, 1 + (i % 9), i % 3 === 0 ? 1 : 0]);
    record(ctx.store, 'MNQ', ticks, { quotes: false });
    const since = SESSION + HOUR;
    await assert.rejects(ctx.service.features('MNQ', '1m', since), (err) => {
      assert.ok(err instanceof GatewayError);
      assert.equal(err.status, 503);
      assert.equal(err.kind, 'ExchangeNotAvailable');
      assert.match(err.message, /still loading/);
      return true;
    });
    const rows = await waitFor(async () => {
      try {
        return await ctx.service.features('MNQ', '1m', since);
      } catch (err) {
        if (err.status === 503) return null;
        throw err;
      }
    }, 20_000);
    assert.deepEqual(rows, reference(ctx.store, 'MNQ', '1m', since, ctx.time.now));
  } finally {
    ctx.done();
  }
});

test('an explicit until replays to that moment and keeps no engine', async () => {
  const ctx = setup({ now: SESSION + 2 * HOUR });
  try {
    record(ctx.store, 'MES', TICKS);
    const until = SESSION + 50 * MIN + 123;
    const rows = await ctx.service.features('MES', '30s', SESSION + 5 * MIN, until);
    assert.deepEqual(rows, reference(ctx.store, 'MES', '30s', SESSION + 5 * MIN, until));
    assert.ok(rows.at(-1).ts < until);
    assert.equal(ctx.service.entries.size, 0);
  } finally {
    ctx.done();
  }
});

test('engines are bounded by maxEngines and dropped after idleMs', async () => {
  const ctx = setup({ now: SESSION + HOUR, maxEngines: 2 });
  try {
    for (const root of ['MES', 'MNQ', 'MGC']) record(ctx.store, root, TICKS.filter((t) => t[0] >= SESSION));
    for (const root of ['MES', 'MNQ', 'MGC']) await ctx.service.features(root, '1m', SESSION + 5 * MIN);
    assert.ok(ctx.service.entries.size <= 2, `${ctx.service.entries.size} entries`);
    assert.ok(!ctx.service.entries.has(`MES|1m|${SESSION}`), 'the least recently used went first');

    ctx.time.now += 31 * MIN;
    await ctx.service.features('MES', '1m', SESSION + 5 * MIN);
    assert.deepEqual([...ctx.service.entries.keys()], [`MES|1m|${SESSION}`], 'idle entries were dropped');
  } finally {
    ctx.done();
  }
});

test('a large replay never blocks the event loop for 50 ms', async (t) => {
  const ctx = setup({ now: SESSION + 6 * HOUR, waitMs: 50 });
  try {
    // About 300k MNQ prints over five hours of one session, plus two small pairs.
    let price = 21000;
    const rnd = lcg(42);
    const batch = [];
    for (let i = 0; i < 300_000; i += 1) {
      price = Math.max(1, price + (Math.floor(rnd() * 3) - 1) * 0.25);
      batch.push([SESSION + MIN + i * 60, price, rnd() < 0.01 ? 400 : 1 + Math.floor(rnd() * 10), rnd() < 0.5 ? 0 : 1]);
      if (batch.length === 50_000) record(ctx.store, 'MNQ', batch.splice(0), { quotes: false });
    }
    record(ctx.store, 'MNQ', batch.splice(0), { quotes: false });
    record(ctx.store, 'MES', makeTicks({ start: SESSION, end: SESSION + 5 * HOUR, seed: 2 }));
    record(ctx.store, 'MGC', makeTicks({ start: SESSION, end: SESSION + 5 * HOUR, seed: 3, price: 2400 }));
    const since = SESSION + 30 * MIN;

    let read = 0;
    const original = ctx.store.ticksAfter.bind(ctx.store);
    ctx.store.ticksAfter = (...args) => {
      const rows = original(...args);
      read += rows.length;
      return rows;
    };

    // Replays on a fresh service each attempt. A replay that does not yield fails every
    // attempt; a beat delayed by the host (see heartbeat()) only fails one of them.
    const attempts = [];
    let rows;
    let others;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const service = new OrderflowService({ tickStore: ctx.store, clock, now: () => ctx.time.now, waitMs: 50 });
      read = 0;
      const beat = heartbeat(5, () => read);
      const started = performance.now();
      let stats;
      try {
        [rows, ...others] = await Promise.all([
          untilReady(() => service.features('MNQ', '15s', since)),
          untilReady(() => service.features('MES', '15s', since)),
          untilReady(() => service.features('MGC', '1m', since)),
        ]);
      } finally {
        stats = await beat.stop();
      }
      const elapsed = performance.now() - started;
      attempts.push({ elapsed, ...stats });
      t.diagnostic(`attempt ${attempt}: replay of ${read} prints took ${elapsed.toFixed(0)} ms over ${stats.beats} beats; `
        + `loop held by the code at most ${stats.held.toFixed(1)} ms, largest beat delay ${stats.wall.toFixed(1)} ms wall, `
        + `largest GC time in one beat ${stats.gc.toFixed(1)} ms, most prints read between two beats ${stats.rows}`);
      assert.ok(read > 300_000, 'every print was replayed');
      assert.ok(elapsed > 200, `the replay was long enough to need chunking (${elapsed.toFixed(0)} ms)`);
      // Deterministic: the replay yields between pages, so no beat waits for more than a few pages.
      assert.ok(stats.rows <= 20_000, `${stats.rows} prints were read between two beats`);
      if (stats.held < 50) break;
    }
    const idleBeat = heartbeat();
    await sleep(1000);
    const idle = await idleBeat.stop();
    t.diagnostic(`idle process on this host: largest beat delay ${idle.wall.toFixed(1)} ms wall over ${idle.beats} beats`);
    const best = Math.min(...attempts.map((a) => a.held));
    assert.ok(best < 50, `the code held the event loop for ${attempts.map((a) => a.held.toFixed(1)).join(' / ')} ms`);

    assert.equal(JSON.stringify(rows), JSON.stringify(reference(ctx.store, 'MNQ', '15s', since, ctx.time.now)));
    assert.deepEqual(others[0], reference(ctx.store, 'MES', '15s', since, ctx.time.now));
    assert.deepEqual(others[1], reference(ctx.store, 'MGC', '1m', since, ctx.time.now));
  } finally {
    ctx.done();
  }
});
