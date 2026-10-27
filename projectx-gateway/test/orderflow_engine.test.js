import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FeatureEngine, computeFeatures } from '../src/orderflow.js';
import { SessionClock } from '../src/session.js';
import { timeframe } from '../src/timeframes.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const clock = new SessionClock({ timezone: 'America/New_York', reset_time: '18:00', eod_time: '16:10' });

/**
 * The reference calls sessionStart once per tick (about 66 us each). Session starts
 * fall on whole minutes, so memoising by minute gives the same answers and keeps
 * the reference fast enough to run dozens of times. The engine gets the real clock.
 */
function memoClock() {
  const cache = new Map();
  return {
    sessionStart(ts) {
      const key = Math.floor(ts / MIN);
      let start = cache.get(key);
      if (start === undefined) {
        start = clock.sessionStart(ts);
        cache.set(key, start);
      }
      return start;
    },
  };
}
const refClock = memoClock();

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** [ts, price, size, side, seq] in (ts, seq) order: bursts, gaps over a candle and over a minute, block prints. */
function makeTicks({ start, end, seed = 1 }) {
  const rnd = lcg(seed);
  const ticks = [];
  let ts = start;
  let seq = 0;
  let price = 6000;
  while (ts < end) {
    const r = rnd();
    let dt;
    if (r < 0.3) dt = 0;
    else if (r < 0.995) dt = 1 + Math.floor(rnd() * 1000);
    else if (r < 0.998) dt = 20 * SEC + Math.floor(rnd() * 30 * SEC);
    else dt = 90 * SEC + Math.floor(rnd() * 400 * SEC);
    if (dt === 0 && ticks.length) seq += 1;
    else {
      ts += dt;
      seq = 0;
    }
    if (ts >= end) break;
    price = Math.max(1, price + (Math.floor(rnd() * 3) - 1) * 0.25);
    const size = rnd() < 0.01 ? 300 + Math.floor(rnd() * 301) : 1 + Math.floor(rnd() * 10);
    ticks.push([ts, price, size, rnd() < 0.5 ? 0 : 1, seq]);
  }
  return ticks;
}

/** Deterministic in ts, and null for some seconds. */
function quoteAt(ts) {
  const s = Math.floor(ts / SEC);
  if (s % 7 === 3) return null;
  const bid = 6000 + (s % 13) * 0.25;
  return { ts: s * SEC, bid, ask: bid + 0.25 * (1 + (s % 3)) };
}

const reference = (ticks, tfMs, since, quotes = quoteAt) => computeFeatures({ ticks, tfMs, since, clock: refClock, quoteAt: quotes, blockMultiple: 25, valueAreaPct: 70 });
const engineFor = (tfMs, quotes = quoteAt) => new FeatureEngine({ tfMs, clock, quoteAt: quotes, blockMultiple: 25, valueAreaPct: 70 });
const json = (rows) => JSON.stringify(rows);

// 2026-10-20 18:00 America/New_York (EDT) = 22:00 UTC.
const SESSION = Date.UTC(2026, 9, 20, 22);
const TICKS = makeTicks({ start: SESSION - 2 * HOUR, end: SESSION + 3 * HOUR, seed: 7 });

test('the generated ticks cover what the parity test claims to cover', () => {
  assert.ok(TICKS.length > 15_000, `${TICKS.length} ticks`);
  assert.ok(TICKS.some((t, i) => i && t[0] === TICKS[i - 1][0]), 'same-millisecond prints');
  assert.ok(TICKS.some((t, i) => i && t[0] - TICKS[i - 1][0] > 60 * SEC), 'gaps over a minute');
  assert.ok(TICKS.some((t) => t[2] >= 300), 'block prints');
  assert.ok(TICKS[0][0] < SESSION && TICKS.at(-1)[0] > SESSION, 'a session reset inside');
  assert.equal(clock.sessionStart(SESSION), SESSION);
});

test('parity: engine.view equals computeFeatures on the same ticks for every timeframe', () => {
  const firstSession = clock.sessionStart(TICKS[0][0]);
  const midSecond = SESSION + 90 * MIN + 7 * SEC;
  for (const tf of ['1s', '15s', '30s', '1m', '5m', '4h']) {
    const tfMs = timeframe(tf).ms;
    const engine = engineFor(tfMs);
    for (const [ts, price, size, side] of TICKS) engine.push(ts, price, size, side);
    for (const since of [firstSession, midSecond]) {
      const expected = reference(TICKS, tfMs, since);
      assert.ok(expected.length > 0, `${tf} since ${since} has rows`);
      assert.equal(json(engine.view(since)), json(expected), `${tf} since ${since}`);
    }
  }
});

test('parity on prefixes: the open candle is closed on a copy and a view never changes the state', () => {
  const resetIdx = TICKS.findIndex((t) => t[0] >= SESSION);
  // A cut between two prints of the same millisecond leaves the open candle mid-way for every timeframe.
  const midCandle = TICKS.findIndex((t, i) => i > 6_000 && t[0] === TICKS[i - 1][0]);
  const cuts = [1, 250, 5_000, midCandle, resetIdx, resetIdx + 1, TICKS.length - 3].sort((a, b) => a - b);
  const since = clock.sessionStart(TICKS[0][0]);
  for (const tf of ['1s', '15s', '30s', '1m', '5m', '4h']) {
    const tfMs = timeframe(tf).ms;
    const engine = engineFor(tfMs);
    let pushed = 0;
    for (const cut of cuts) {
      for (; pushed < cut; pushed += 1) {
        const [ts, price, size, side] = TICKS[pushed];
        engine.push(ts, price, size, side);
      }
      const expected = json(reference(TICKS.slice(0, cut), tfMs, since));
      assert.equal(json(engine.view(since)), expected, `${tf} after ${cut} ticks`);
      assert.equal(json(engine.view(since)), expected, `${tf} after ${cut} ticks, second view`);
    }
    for (; pushed < TICKS.length; pushed += 1) {
      const [ts, price, size, side] = TICKS[pushed];
      engine.push(ts, price, size, side);
    }
    assert.equal(json(engine.view(since)), json(reference(TICKS, tfMs, since)), `${tf} after the views, pushing on`);
  }
});

function resetScenario(sessionStart) {
  const ticks = [];
  // 300 prints from 300.5 s before the reset. On 15s candles the last value area before
  // the reset is then taken at the reset itself, so the first post-reset close only
  // recomputes it if the reset also restarted the 60 s profile step.
  let ts = sessionStart - 301 * SEC - 500;
  for (let i = 0; i < 300; i += 1) ticks.push([ts += SEC, 6000 + (i % 4) * 0.25, 1 + (i % 3), i % 3 === 0 ? 1 : 0, 0]);
  ts = sessionStart;
  for (let i = 0; i < 49; i += 1) ticks.push([ts += SEC, 7000 + (i % 5) * 0.25, 2, i % 4 === 0 ? 1 : 0, 0]);
  ticks.push([ts += SEC, 7000, 500, 0, 0]); // 50th print after the reset
  for (let i = 0; i < 30; i += 1) ticks.push([ts += SEC, 7001, 1, 1, 0]);
  return ticks;
}

function checkReset(sessionStart) {
  for (const tfMs of [MIN, 15 * SEC]) checkResetOn(sessionStart, tfMs);
}

function checkResetOn(sessionStart, tfMs) {
  const ticks = resetScenario(sessionStart);
  const engine = engineFor(tfMs, null);
  for (const [ts, price, size, side] of ticks) engine.push(ts, price, size, side);
  const since = sessionStart - HOUR;
  const rows = engine.view(since);
  assert.equal(json(rows), json(reference(ticks, tfMs, since, null)));

  const pre = rows.filter((r) => r.ts < sessionStart);
  const post = rows.filter((r) => r.ts >= sessionStart);
  const preCvd = ticks.filter((t) => t[0] < sessionStart).reduce((s, t) => s + (t[3] === 0 ? t[2] : -t[2]), 0);
  assert.equal(pre.at(-1).cvd_session, preCvd, 'the last row before the reset keeps the old session');
  assert.ok(pre.at(-1).poc < 7000 && pre.at(-1).val < 7000, 'and its value area');
  const firstPost = ticks.filter((t) => t[0] >= sessionStart && t[0] < post[0].ts + tfMs);
  assert.equal(post[0].cvd_session, firstPost.reduce((s, t) => s + (t[3] === 0 ? t[2] : -t[2]), 0), 'counts only post-reset prints');
  for (const r of post) assert.ok(r.poc >= 7000 && r.val >= 7000 && r.vah >= 7000, 'the profile restarts at the reset');
  const blockRow = post.find((r) => r.block_count > 0);
  assert.ok(blockRow, 'block detection does not re-warm at the reset');
  assert.equal(blockRow.block_volume, 500);
  assert.equal(blockRow.block_delta, 500);
  return rows;
}

test('session reset at 18:00 New York: cvd, profile and value area restart, block detection stays warm', () => {
  checkReset(SESSION);
});

test('session reset across the 2026-11-01 DST change happens at 23:00 UTC, also for an engine started a day earlier', () => {
  const dstSession = Date.UTC(2026, 10, 1, 23);
  assert.equal(clock.sessionStart(dstSession), dstSession);
  assert.equal(clock.sessionStart(dstSession - 1), Date.UTC(2026, 9, 31, 22), 'the previous session opened at 22:00 UTC (EDT)');
  checkReset(dstSession);

  // An engine whose cached trading day was computed before the change.
  const early = makeTicks({ start: Date.UTC(2026, 9, 31, 20), end: Date.UTC(2026, 10, 2, 1), seed: 3 });
  const engine = engineFor(MIN);
  for (const [ts, price, size, side] of early) engine.push(ts, price, size, side);
  const since = Date.UTC(2026, 9, 31, 21);
  const rows = engine.view(since);
  assert.equal(json(rows), json(reference(early, MIN, since)));
  const signedSum = (from, to) => early.filter((t) => t[0] >= from && t[0] < to).reduce((s, t) => s + (t[3] === 0 ? t[2] : -t[2]), 0);
  const after22 = rows.find((r) => r.ts >= Date.UTC(2026, 10, 1, 22));
  assert.equal(after22.cvd_session, signedSum(Date.UTC(2026, 9, 31, 22), after22.ts + MIN), 'no reset at 22:00 UTC on the DST day');
  const after23 = rows.find((r) => r.ts >= dstSession);
  assert.equal(after23.cvd_session, signedSum(dstSession, after23.ts + MIN), 'the reset is at 23:00 UTC');
});

test('retention: only the newest 5000 candles are returned and closed rows stay bounded', () => {
  const start = SESSION + 10 * MIN;
  const ticks = [];
  for (let i = 0; i < 12_000; i += 1) ticks.push([start + i * SEC + 3, 6000 + (i % 40) * 0.25, 1 + (i % 7), i % 2, 0]);
  const engine = engineFor(SEC);
  for (const [ts, price, size, side] of ticks) {
    engine.push(ts, price, size, side);
    assert.ok(engine.committedCount <= 10_000);
  }
  assert.ok(engine.committedCount < 11_999, 'old rows were dropped');
  const rows = engine.view(0);
  assert.equal(rows.length, 5000);
  assert.equal(json(rows), json(reference(ticks, SEC, 0)));
  const since = start + 8_000 * SEC;
  assert.equal(json(engine.view(since)), json(reference(ticks, SEC, since)));
});
