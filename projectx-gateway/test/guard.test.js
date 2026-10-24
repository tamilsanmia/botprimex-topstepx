import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AccountGuard, STATUS, summarizeFills } from '../src/guard.js';
import { LotTable } from '../src/lots.js';
import { resolveRules } from '../src/rules.js';
import { zonedToUtc } from '../src/session.js';

const TZ = 'America/New_York';
// Tuesday 20 Oct 2026; Saturday is the 24th.
const et = (day, hh, mm = 0) => zonedToUtc(2026, 10, day, hh, mm, TZ);

function makeGuard(topstep = {}, account = { name: '50KTC-V2-1', kind: 'TC', sizeUsd: 50000 }, statePath = null) {
  const resolved = resolveRules({
    phase: 'auto', preset: 'auto',
    protection: { daily_profit_lock: { enabled: false } },
    ...topstep,
    session: { news_blackout: [], ...(topstep.session || {}) },
  }, account);
  const file = statePath || path.join(mkdtempSync(path.join(os.tmpdir(), 'guard-')), 'state.json');
  return new AccountGuard({ resolved, lots: new LotTable(resolved.lots), statePath: file });
}

const base = { balance: 50000, unrealized: 0, dayRealized: 0, closedResults: [], entriesToday: 0, legs: [] };
const codes = (res) => res.reasons.map((r) => r.code);

test('active in a normal session', () => {
  const res = makeGuard().evaluate({ ...base, now: et(20, 10) });
  assert.equal(res.status, STATUS.ACTIVE);
  assert.equal(res.flatten, false);
  assert.equal(res.metrics.mllFloor, 48000);
});

test('DLL soft blocks entries, hard locks the day and flattens', () => {
  const g = makeGuard();
  const soft = g.evaluate({ ...base, now: et(20, 10), unrealized: -700 });
  assert.equal(soft.status, STATUS.ENTRIES_BLOCKED);
  assert.deepEqual(codes(soft), ['dll_soft']);
  assert.equal(soft.flatten, false);

  const hard = g.evaluate({ ...base, now: et(20, 10, 5), balance: 49100, dayRealized: -900 });
  assert.equal(hard.status, STATUS.DAY_LOCKED);
  assert.ok(hard.flatten);
  assert.ok(codes(hard).includes('dll_hard'));
});

test('daily_loss_type eod ignores open P&L', () => {
  const g = makeGuard({ phases: { evaluation: { daily_loss_type: 'eod' } } });
  assert.equal(g.evaluate({ ...base, now: et(20, 10), unrealized: -950 }).status, STATUS.ACTIVE);
});

test('a day lock survives a restart and clears at the next session reset', () => {
  const g1 = makeGuard();
  g1.evaluate({ ...base, now: et(20, 11), balance: 49090, dayRealized: -910 });
  const g2 = makeGuard({}, undefined, g1.statePath);
  assert.equal(g2.evaluate({ ...base, now: et(20, 12), balance: 49090, dayRealized: -910 }).status, STATUS.DAY_LOCKED);
  const nextDay = g2.evaluate({ ...base, now: et(20, 18, 10), balance: 49090, dayRealized: 0 });
  assert.equal(nextDay.status, STATUS.ACTIVE);
  assert.equal(nextDay.tradingDay, '2026-10-21');
});

test('trailing_eod: the floor moves only at eod_time, then MLL buffer locks the account', () => {
  const g = makeGuard();
  g.evaluate({ ...base, now: et(20, 12), balance: 51000, dayRealized: 1000 });
  assert.equal(g.last.metrics.mllFloor, 48000, 'unchanged intraday');
  g.evaluate({ ...base, now: et(20, 16, 11), balance: 51000, dayRealized: 1000 });
  assert.equal(g.last.metrics.mllFloor, 49000, 'trailed at EOD');
  const res = g.evaluate({ ...base, now: et(21, 10), balance: 49250, dayRealized: -250 });
  assert.equal(res.status, STATUS.ACCOUNT_LOCKED);
  assert.ok(codes(res).includes('mll_buffer'));
  assert.ok(res.flatten);
});

test('trailing_intraday follows peak equity including open profit', () => {
  const g = makeGuard({ phases: { evaluation: { max_loss_type: 'trailing_intraday', consistency_pct: null } } });
  g.evaluate({ ...base, now: et(20, 10), unrealized: 1500 });
  assert.equal(g.last.metrics.mllFloor, 49500);
  const res = g.evaluate({ ...base, now: et(20, 10, 1), unrealized: -300 });
  assert.equal(res.status, STATUS.ACCOUNT_LOCKED);
});

test('static floor never moves; lock balance caps the trailing floor', () => {
  const s = makeGuard({ phases: { evaluation: { max_loss_type: 'static' } } });
  s.evaluate({ ...base, now: et(20, 16, 20), balance: 52000, dayRealized: 500 });
  assert.equal(s.last.metrics.mllFloor, 48000);

  const funded = makeGuard({}, { name: '50KXFA-1', kind: 'XFA', sizeUsd: 50000 });
  funded.evaluate({ ...base, balance: 3000, now: et(20, 16, 20), dayRealized: 900 });
  const res = funded.evaluate({ ...base, balance: 3000, now: et(21, 10) });
  assert.equal(res.metrics.startBalance, 0);
  assert.equal(res.metrics.mllFloor, 0, 'capped at mll_lock_balance');
});

test('consistency: daily cap blocks entries and a pass needs best day <= 50% of profit', () => {
  const g = makeGuard({ protection: { daily_profit_lock: { enabled: false }, mll_buffer: 0 } });
  const capped = g.evaluate({ ...base, now: et(20, 11), balance: 51500, dayRealized: 1500 });
  assert.ok(codes(capped).includes('consistency_cap'));

  const g2 = makeGuard();
  g2.state.days = { '2026-10-19': { pnl: 2000, balanceEod: 52000 } };
  const notYet = g2.evaluate({ ...base, now: et(20, 11), balance: 53100, dayRealized: 1100 });
  assert.notEqual(notYet.status, STATUS.ACCOUNT_LOCKED, 'best day 2000 > 50% of 3100');
  assert.equal(notYet.metrics.consistencyOk, false);
  const passed = g2.evaluate({ ...base, now: et(20, 11, 30), balance: 54100, dayRealized: 1100 });
  assert.equal(passed.status, STATUS.ACCOUNT_LOCKED);
  assert.ok(codes(passed).includes('target_passed'));
});

test('funded scaling plan uses the last EOD balance', () => {
  const g = makeGuard({}, { name: '50KXFA-1', kind: 'XFA', sizeUsd: 50000 });
  assert.equal(g.evaluate({ ...base, balance: 0, now: et(20, 10) }).metrics.maxMiniEquivalent, 2);
  g.evaluate({ ...base, balance: 1600, now: et(20, 16, 15), dayRealized: 1600 });
  assert.equal(g.evaluate({ ...base, balance: 1600, now: et(21, 10) }).metrics.maxMiniEquivalent, 3);
});

test('profit giveback locks the day', () => {
  const g = makeGuard({ protection: { daily_profit_lock: { enabled: true, activate_at: 800, giveback_pct: 40 } } });
  g.evaluate({ ...base, now: et(20, 10), unrealized: 1000 });
  const res = g.evaluate({ ...base, now: et(20, 10, 5), unrealized: 590 });
  assert.equal(res.status, STATUS.DAY_LOCKED);
  assert.ok(codes(res).includes('profit_giveback'));
});

test('trade and loss counters block entries', () => {
  const g = makeGuard();
  assert.ok(codes(g.evaluate({ ...base, now: et(20, 10), entriesToday: 10 })).includes('max_trades_per_day'));
  assert.ok(codes(g.evaluate({ ...base, now: et(20, 10), closedResults: [5, -1, -2, -3] })).includes('max_consecutive_losses'));
  assert.ok(!codes(g.evaluate({ ...base, now: et(20, 10), closedResults: [-1, -2, 4] })).includes('max_consecutive_losses'));
});

test('session clock: entry window, flat_by, weekend, trading windows, news blackout', () => {
  const g = makeGuard({
    session: {
      trading_windows: [{ start: '09:30', end: '15:45' }],
      news_blackout: [{ days: 'mon-fri', start: '08:28', end: '08:35', flatten: true }],
    },
  });
  assert.ok(codes(g.evaluate({ ...base, now: et(20, 15, 50) })).includes('no_entry_window'));
  const flat = g.evaluate({ ...base, now: et(20, 16, 6) });
  assert.ok(flat.flatten && flat.flattenReasons.includes('session_flat_by'));
  assert.equal(flat.status, STATUS.ENTRIES_BLOCKED);
  const weekend = g.evaluate({ ...base, now: et(24, 12) });
  assert.ok(weekend.flattenReasons.includes('weekend'));
  assert.ok(codes(g.evaluate({ ...base, now: et(20, 20) })).includes('outside_trading_windows'));
  const news = g.evaluate({ ...base, now: et(21, 8, 30) });
  assert.ok(codes(news).includes('news_blackout') && news.flattenReasons.includes('news_blackout'));
  assert.equal(g.evaluate({ ...base, now: et(21, 10) }).status, STATUS.ACTIVE);
});

test('overnight hold mode skips the daily flat but not the weekend', () => {
  const g = makeGuard({ session: { hold_mode: 'overnight' } });
  assert.equal(g.evaluate({ ...base, now: et(20, 16, 6) }).flatten, false);
  assert.equal(g.evaluate({ ...base, now: et(23, 16, 30) }).flatten, true);
});

test('missed EOD snapshots are rebuilt from fills', () => {
  const g = makeGuard();
  const fill = (day, hh, pnl) => ({ creationTimestamp: new Date(et(day, hh)).toISOString(), profitAndLoss: pnl, fees: 1, commissions: 0, orderId: day * 100 + hh });
  const trades = [fill(19, 10, 600), fill(19, 11, 401), fill(20, 10, -201)];
  const added = g.rebuildHistory(trades, 50797, et(21, 10));
  assert.equal(added, 2);
  assert.equal(g.state.days['2026-10-19'].pnl, 999);
  assert.equal(g.state.days['2026-10-19'].balanceEod, 50999);
  assert.equal(g.state.days['2026-10-20'].balanceEod, 50797);
  assert.equal(g.state.hwmEod, 50999);
  assert.equal(g.evaluate({ ...base, balance: 50797, now: et(21, 10) }).metrics.mllFloor, 48999);
});

test('summarizeFills nets fees and commissions and counts entries', () => {
  const t = (hh, pnl, orderId) => ({ creationTimestamp: new Date(et(20, hh)).toISOString(), profitAndLoss: pnl, fees: 0.5, commissions: 0.25, orderId });
  const s = summarizeFills([t(9, null, 1), t(10, 20, 2), t(11, null, 3), t(12, -10, 4)], et(19, 18));
  assert.equal(s.entriesToday, 2);
  assert.deepEqual(s.closedResults, [19.25, -10.75]);
  assert.equal(s.dayRealized, 20 - 10 - 3);
});

test('canEnter enforces the cap and the overlap rule', () => {
  const g = makeGuard();
  g.evaluate({ ...base, now: et(20, 10) });
  assert.equal(g.canEnter({ root: 'ES', contracts: 1, legs: [{ root: 'MES', contracts: 2 }] }).ok, false);
  const cap = g.canEnter({ root: 'MNQ', contracts: 31, legs: [{ root: 'ES', contracts: 2 }] });
  assert.equal(cap.ok, false);
  assert.equal(cap.maxContracts, 30);
  assert.equal(g.canEnter({ root: 'MNQ', contracts: 30, legs: [{ root: 'ES', contracts: 2 }] }).ok, true);
});
