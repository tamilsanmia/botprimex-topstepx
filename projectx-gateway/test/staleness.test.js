import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { GatewayApp, StartupError, assertStartable } from '../src/index.js';
import { AccountGuard, STATUS } from '../src/guard.js';
import { LotTable } from '../src/lots.js';
import { MarketStream } from '../src/marketStream.js';
import { resolveRules } from '../src/rules.js';
import { zonedToUtc } from '../src/session.js';

const TZ = 'America/New_York';
// Tuesday 20 Oct 2026; Saturday is the 24th, Sunday the 25th.
const et = (day, hh, mm = 0, ss = 0) => zonedToUtc(2026, 10, day, hh, mm, TZ) + ss * 1000;

function makeGuard({ stale, session } = {}) {
  const resolved = resolveRules({
    phase: 'auto', preset: 'auto',
    protection: { daily_profit_lock: { enabled: false } },
    session: { news_blackout: [], ...(session || {}) },
  }, { name: '50KTC-V2-1', kind: 'TC', sizeUsd: 50000 });
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'stale-')), 'state.json');
  return new AccountGuard({ resolved, lots: new LotTable(resolved.lots), statePath: file, stale });
}

const base = { balance: 50000, unrealized: 0, dayRealized: 0, closedResults: [], entriesToday: 0, legs: [] };
const codes = (res) => res.reasons.map((r) => r.code);
const quoteStale = (now, ageSecs, root = 'MES') => ({ reasons: [{ code: 'quote_stale', root, since: now - ageSecs * 1000, ageSecs }] });
const open = [{ root: 'MES', contracts: 1 }];

test('fresh data and a missing dataHealth input change nothing', () => {
  const g = makeGuard();
  const now = et(20, 10);
  assert.equal(g.evaluate({ ...base, now }).status, STATUS.ACTIVE);
  assert.equal(g.evaluate({ ...base, now, dataHealth: { ok: true, reasons: [] } }).status, STATUS.ACTIVE);
  assert.equal(g.evaluate({ ...base, now, dataHealth: quoteStale(now, 5) }).status, STATUS.ACTIVE, 'younger than block_entries_secs');
});

test('a quote older than block_entries_secs blocks entries but does not flatten', () => {
  const g = makeGuard();
  const now = et(20, 10);
  const res = g.evaluate({ ...base, now, legs: open, dataHealth: quoteStale(now, 16) });
  assert.equal(res.status, STATUS.ENTRIES_BLOCKED);
  assert.equal(res.canEnter, false);
  assert.ok(codes(res).includes('data_stale'));
  assert.match(res.reasons.find((r) => r.code === 'data_stale').detail, /quote_stale MES 16s/);
  assert.equal(res.flatten, false);
  assert.equal(g.canEnter({ root: 'MES', contracts: 1, legs: [] }).ok, false);
});

test('exactly block_entries_secs blocks, one second less does not', () => {
  const g = makeGuard();
  const now = et(20, 10);
  assert.equal(g.evaluate({ ...base, now, dataHealth: quoteStale(now, 14.9) }).canEnter, true);
  assert.equal(g.evaluate({ ...base, now, dataHealth: quoteStale(now, 15) }).canEnter, false);
});

test('flatten is raised at flatten_secs, and only while a position is open', () => {
  const g = makeGuard();
  const now = et(20, 10);
  const held = g.evaluate({ ...base, now, legs: open, dataHealth: quoteStale(now, 121) });
  assert.equal(held.flatten, true);
  assert.deepEqual(held.flattenReasons, ['data_stale']);
  assert.equal(held.status, STATUS.ENTRIES_BLOCKED, 'flatten does not lock the day');

  const early = g.evaluate({ ...base, now, legs: open, dataHealth: quoteStale(now, 119) });
  assert.equal(early.flatten, false);

  const flat = g.evaluate({ ...base, now, legs: [], dataHealth: quoteStale(now, 500) });
  assert.equal(flat.flatten, false, 'nothing to flatten');
  assert.equal(flat.canEnter, false, 'but entries stay blocked');

  const zero = g.evaluate({ ...base, now, legs: [{ root: 'MES', contracts: 0 }], dataHealth: quoteStale(now, 500) });
  assert.equal(zero.flatten, false, 'a zero-size leg is not a position');
});

test('flatten_secs 0 disables the flatten but still blocks entries', () => {
  const g = makeGuard({ stale: { flatten_secs: 0 } });
  const now = et(20, 10);
  const res = g.evaluate({ ...base, now, legs: open, dataHealth: quoteStale(now, 3600) });
  assert.equal(res.flatten, false);
  assert.equal(res.canEnter, false);
});

test('thresholds come from the stale option', () => {
  const g = makeGuard({ stale: { block_entries_secs: 5, flatten_secs: 30 } });
  const now = et(20, 10);
  assert.equal(g.evaluate({ ...base, now, dataHealth: quoteStale(now, 6) }).canEnter, false);
  assert.equal(g.evaluate({ ...base, now, legs: open, dataHealth: quoteStale(now, 31) }).flatten, true);
});

test('hub and reconcile problems count, with the same thresholds', () => {
  const g = makeGuard();
  const now = et(20, 10);
  for (const code of ['market_hub_down', 'user_hub_down', 'reconcile_stale']) {
    const res = g.evaluate({ ...base, now, legs: open, dataHealth: { reasons: [{ code, since: now - 130_000 }] } });
    assert.equal(res.canEnter, false, code);
    assert.deepEqual(res.flattenReasons, ['data_stale'], code);
    assert.match(res.reasons.find((r) => r.code === 'data_stale').detail, new RegExp(`${code} 130s`));
  }
});

test('several reasons are listed together in the detail', () => {
  const g = makeGuard();
  const now = et(20, 10);
  const res = g.evaluate({
    ...base, now, dataHealth: { reasons: [{ code: 'user_hub_down', since: now - 20_000 }, { code: 'quote_stale', root: 'MNQ', since: now - 30_000 }] },
  });
  const detail = res.reasons.find((r) => r.code === 'data_stale').detail;
  assert.match(detail, /user_hub_down 20s/);
  assert.match(detail, /quote_stale MNQ 30s/);
  assert.equal(res.reasons.filter((r) => r.code === 'data_stale').length, 1);
});

test('quote staleness is ignored on the weekend', () => {
  const g = makeGuard();
  const now = et(24, 12);
  const res = g.evaluate({ ...base, now, legs: open, dataHealth: quoteStale(now, 3600) });
  assert.ok(!codes(res).includes('data_stale'));
  assert.deepEqual(res.flattenReasons, ['weekend'], 'the weekend flatten stays; staleness adds nothing');
});

test('quote staleness is ignored from flat_by to the reset, in either hold mode', () => {
  for (const hold_mode of ['intraday', 'overnight']) {
    const g = makeGuard({ session: { hold_mode } });
    const now = et(20, 17, 30);
    const res = g.evaluate({ ...base, now, legs: open, dataHealth: quoteStale(now, 3600) });
    assert.ok(!codes(res).includes('data_stale'), hold_mode);
    assert.ok(!res.flattenReasons.includes('data_stale'), hold_mode);
  }
});

test('hub problems are NOT ignored while the market is shut', () => {
  const g = makeGuard({ session: { hold_mode: 'overnight' } });
  const now = et(20, 17, 30);
  const res = g.evaluate({ ...base, now, legs: open, dataHealth: { reasons: [{ code: 'user_hub_down', since: now - 600_000 }] } });
  assert.ok(codes(res).includes('data_stale'));
  assert.deepEqual(res.flattenReasons, ['data_stale']);
});

test('the daily reopen does not count the closed hours as stale', () => {
  const g = makeGuard({ session: { hold_mode: 'overnight' } });
  // Quotes last arrived at the 17:00 break; at 18:00:05 the session just reopened.
  const lastQuote = et(20, 16, 59);
  const justOpen = et(20, 18, 0, 5);
  const fresh = g.evaluate({ ...base, now: justOpen, legs: open, dataHealth: { reasons: [{ code: 'quote_stale', root: 'MES', since: lastQuote }] } });
  assert.ok(!codes(fresh).includes('data_stale'));
  assert.equal(fresh.flatten, false);

  const later = et(20, 18, 0, 20);
  const blocked = g.evaluate({ ...base, now: later, legs: open, dataHealth: { reasons: [{ code: 'quote_stale', root: 'MES', since: lastQuote }] } });
  assert.ok(codes(blocked).includes('data_stale'), 'no quote 20 s after the reopen blocks entries');
  assert.equal(blocked.flatten, false);

  const longer = et(20, 18, 2, 5);
  assert.equal(g.evaluate({ ...base, now: longer, legs: open, dataHealth: { reasons: [{ code: 'quote_stale', root: 'MES', since: lastQuote }] } }).flatten, true);
});

test('entries recover as soon as the reason clears', () => {
  const g = makeGuard();
  const now = et(20, 10);
  assert.equal(g.evaluate({ ...base, now, dataHealth: quoteStale(now, 30) }).canEnter, false);
  const res = g.evaluate({ ...base, now: now + 1000, dataHealth: { ok: true, reasons: [] } });
  assert.equal(res.canEnter, true);
  assert.equal(res.status, STATUS.ACTIVE);
});

test('stale data never creates a persistent lock', () => {
  const g = makeGuard();
  const now = et(20, 10);
  g.evaluate({ ...base, now, legs: open, dataHealth: quoteStale(now, 600) });
  assert.equal(g.state.dayLock, null);
  assert.equal(g.state.accountLock, null);
});

/* ------------------------------------------------- MarketStream receive age -- */

function marketStream() {
  const contracts = {
    front: (root) => ({ contractId: `CON.${root}` }),
    rootForContract: (id) => String(id).split('.')[1],
  };
  const stream = new MarketStream({ url: 'u', tokenFactory: () => 't', contracts, hubFactory: () => ({}) });
  stream.want('MES');
  return stream;
}

test('quote age counts local receive time, not the server timestamp', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const m = marketStream();
  assert.equal(m.quoteSince('MES'), null, 'not subscribed yet and nothing received');
  assert.equal(m.quoteAgeMs('MES'), null);
  assert.equal(m.quoteAgeMs('NOPE'), null, 'unknown roots have no age');

  m.subscribedAt.set('CON.MES', 1_000_000);
  t.mock.timers.tick(10_000);
  assert.equal(m.quoteAgeMs('MES'), 10_000, 'before any message the age runs from the subscription');

  // A server timestamp from last year changes nothing.
  m.onQuote('CON.MES', { lastPrice: 6000, timestamp: '2025-01-01T00:00:00Z' });
  assert.equal(m.quoteAgeMs('MES'), 0);
  t.mock.timers.tick(4_000);
  assert.equal(m.quoteAgeMs('MES'), 4_000);

  m.onTrade('CON.MES', { price: 6001, volume: 1, type: 0, timestamp: '2020-01-01T00:00:00Z' });
  assert.equal(m.quoteAgeMs('MES'), 0, 'a trade print refreshes it');
  t.mock.timers.tick(1_000);
  m.onDepth('CON.MES', { type: 3, price: 6001.25, volume: 5 });
  assert.equal(m.quoteAgeMs('MES'), 0, 'a depth update refreshes it');
});

test('resubscribing restarts the age from the new subscription', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  const m = marketStream();
  m.onQuote('CON.MES', { lastPrice: 6000 });
  t.mock.timers.tick(60_000);
  assert.equal(m.quoteAgeMs('MES'), 60_000);
  const hub = { invoke: async () => {} };
  await m.resubscribeAll(hub, true);
  assert.equal(m.quoteAgeMs('MES'), 0, 'the hub was down, so the old receive time says nothing about the new feed');
  assert.deepEqual(m.wantedRoots(), ['MES']);
});

/* ------------------------------------------------------ GatewayApp.dataHealth -- */

function bareApp({ now, mock = true } = {}) {
  const app = Object.create(GatewayApp.prototype);
  app.cfg = { gateway: { stale: { block_entries_secs: 15, flatten_secs: 120, notify: true }, reconcile_secs: 30 }, dataOnly: false, mock };
  app.guardSource = 'projectx';
  app.market = {
    hub: { state: 'connected', stateAt: now - 3_600_000 },
    wantedRoots: () => ['MES', 'MNQ'],
    quoteSince: (root) => ({ MES: now - 2_000, MNQ: now - 40_000 })[root],
  };
  app.user = { hub: { state: 'connected', stateAt: now - 3_600_000 }, lastReconcileAt: now - 5_000 };
  return app;
}

test('dataHealth names each stale quote and leaves fresh ones out', () => {
  const now = Date.now();
  const health = bareApp({ now }).dataHealth(now);
  assert.equal(health.ok, false);
  assert.deepEqual(health.reasons.map((r) => [r.code, r.root, r.ageSecs]), [['quote_stale', 'MNQ', 40]]);
  assert.equal(health.reasons[0].since, now - 40_000);
});

test('dataHealth reports a down market hub, a down user hub and a stale reconcile', () => {
  const now = Date.now();
  const app = bareApp({ now });
  app.market.quoteSince = () => now;
  app.market.hub = { state: 'reconnecting', stateAt: now - 20_000 };
  app.user.hub = { state: 'disconnected', stateAt: now - 30_000 };
  app.user.lastReconcileAt = now - 200_000;
  assert.deepEqual(app.dataHealth(now).reasons.map((r) => [r.code, r.ageSecs]), [
    ['market_hub_down', 20], ['user_hub_down', 30], ['reconcile_stale', 200],
  ]);

  app.market.hub = { state: 'reconnecting', stateAt: now - 5_000 };
  app.user.hub = { state: 'reconnecting', stateAt: now - 5_000 };
  app.user.lastReconcileAt = now - 80_000;
  assert.deepEqual(app.dataHealth(now).reasons, [], 'short blips and a reconcile younger than three intervals are tolerated');
});

test('dataHealth ignores the user side in dry-run guard mode and in data-only mode', () => {
  const now = Date.now();
  const app = bareApp({ now });
  app.market.quoteSince = () => now;
  app.user.hub = { state: 'idle', stateAt: 0 };
  app.user.lastReconcileAt = 0;
  app.guardSource = 'freqtrade';
  assert.equal(app.dataHealth(now).ok, true);
  app.guardSource = 'projectx';
  app.cfg.dataOnly = true;
  assert.equal(app.dataHealth(now).ok, true);
});

test('a hub that never started is not reported as down', () => {
  const now = Date.now();
  const app = bareApp({ now });
  app.market.quoteSince = () => null;
  app.market.hub = { state: 'idle', stateAt: 0 };
  assert.equal(app.dataHealth(now).ok, true);
});

/* ------------------------------------------------------------- notifications -- */

test('operators hear once when data goes stale and once when it recovers, at most a minute apart', () => {
  const sent = [];
  const app = Object.create(GatewayApp.prototype);
  app.cfg = { gateway: { stale: { notify: true } } };
  app.notify = (text) => sent.push(text);
  const stale = { reasons: [{ code: 'data_stale', detail: 'quote_stale MES 30s' }], flattenReasons: [] };
  const fresh = { reasons: [], flattenReasons: [] };

  app.noticeDataHealth(fresh, 1_000_000);
  assert.equal(sent.length, 0, 'fresh at start says nothing');
  app.noticeDataHealth(stale, 1_000_000);
  app.noticeDataHealth(stale, 1_010_000);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /stale.*entries are blocked.*quote_stale MES 30s/);

  app.noticeDataHealth(fresh, 1_020_000);
  assert.equal(sent.length, 1, 'recovery within a minute waits');
  app.noticeDataHealth(fresh, 1_070_000);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /fresh again/);

  app.noticeDataHealth({ reasons: stale.reasons, flattenReasons: ['data_stale'] }, 1_200_000);
  assert.match(sent[2], /flattened/);
});

test('notify: false keeps the gateway quiet', () => {
  const sent = [];
  const app = Object.create(GatewayApp.prototype);
  app.cfg = { gateway: { stale: { notify: false } } };
  app.notify = (text) => sent.push(text);
  app.noticeDataHealth({ reasons: [{ code: 'data_stale', detail: 'x' }], flattenReasons: [] }, 5_000_000);
  assert.equal(sent.length, 0);
});

/* ------------------------------------------------------------------ config -- */

test('assertStartable rejects thresholds that cannot work', () => {
  const cfg = (stale) => ({ secret: 's', mock: true, dryRun: true, gateway: { stale } });
  assert.doesNotThrow(() => assertStartable(cfg({ block_entries_secs: 15, flatten_secs: 120 })));
  assert.doesNotThrow(() => assertStartable(cfg({ block_entries_secs: 15, flatten_secs: 0 })), 'flatten_secs 0 means never');
  assert.throws(() => assertStartable(cfg({ block_entries_secs: 0, flatten_secs: 120 })), StartupError);
  assert.throws(() => assertStartable(cfg({ block_entries_secs: 'x', flatten_secs: 120 })), /block_entries_secs/);
  assert.throws(() => assertStartable(cfg({ block_entries_secs: 60, flatten_secs: 30 })), /flatten_secs/);
});
