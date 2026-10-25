import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AccountGuard, STATUS, summarizeFills } from '../src/guard.js';
import { LotTable } from '../src/lots.js';
import { resolveRules } from '../src/rules.js';
import { zonedToUtc } from '../src/session.js';
import { sleep } from './helpers.js';

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

test('consistency: daily cap blocks entries and a pass needs best day <= 55% of profit', () => {
  const g = makeGuard({ protection: { daily_profit_lock: { enabled: false }, mll_buffer: 0 } });
  const capped = g.evaluate({ ...base, now: et(20, 11), balance: 51700, dayRealized: 1700 });
  assert.ok(codes(capped).includes('consistency_cap'));
  assert.equal(capped.metrics.consistencyCap, 1650);

  const g2 = makeGuard();
  g2.state.days = { '2026-10-19': { pnl: 2000, balanceEod: 52000 } };
  const notYet = g2.evaluate({ ...base, now: et(20, 11), balance: 53100, dayRealized: 1100 });
  assert.notEqual(notYet.status, STATUS.ACCOUNT_LOCKED, 'best day 2000 > 55% of 3100');
  assert.equal(notYet.metrics.consistencyOk, false);
  const passed = g2.evaluate({ ...base, now: et(20, 11, 30), balance: 54100, dayRealized: 1100 });
  assert.equal(passed.status, STATUS.ACCOUNT_LOCKED);
  assert.ok(codes(passed).includes('target_passed'));
});

const consistencyGuard = (mode) => makeGuard({
  protection: { daily_profit_lock: { enabled: false }, mll_buffer: 0 },
  phases: { evaluation: { consistency_mode: mode } },
});

test('consistency_mode cap_day (default): the day is capped and a pass needs the best day within 55% of profit', () => {
  const g = consistencyGuard(undefined);
  assert.equal(g.rules.consistency_mode, 'cap_day');
  const capped = g.evaluate({ ...base, now: et(20, 11), balance: 51700, dayRealized: 1700 });
  assert.ok(codes(capped).includes('consistency_cap'));
  assert.equal(capped.metrics.consistencyMode, 'cap_day');
  assert.equal(capped.metrics.consistencyCap, 1650);

  g.state.days = { '2026-10-19': { pnl: 2000, balanceEod: 52000 } };
  const short = g.evaluate({ ...base, now: et(21, 11), balance: 53100, dayRealized: 1100 });
  assert.equal(short.metrics.effectiveTarget, 3636.36);
  assert.notEqual(short.status, STATUS.ACCOUNT_LOCKED);
  const done = g.evaluate({ ...base, now: et(21, 12), balance: 53640, dayRealized: 1640 });
  assert.ok(codes(done).includes('target_passed'));
});

test('consistency_mode raise_target: no daily cap, the target rises to bestDay / pct', () => {
  const g = consistencyGuard('raise_target');
  const day = g.evaluate({ ...base, now: et(20, 11), balance: 51700, dayRealized: 1700 });
  assert.ok(!codes(day).includes('consistency_cap'), 'no cap in this mode');
  assert.equal(day.status, STATUS.ACTIVE);
  assert.equal(day.metrics.consistencyCap, null);
  assert.equal(day.metrics.effectiveTarget, 3090.91, '1700 / 0.55');

  const short = g.evaluate({ ...base, now: et(20, 12), balance: 53050, dayRealized: 3050 });
  assert.equal(short.metrics.effectiveTarget, 5545.45);
  assert.notEqual(short.status, STATUS.ACCOUNT_LOCKED, 'past the plain 3000 target but below the raised one');

  const small = consistencyGuard('raise_target');
  const normal = small.evaluate({ ...base, now: et(20, 11), balance: 51000, dayRealized: 1000 });
  assert.equal(normal.metrics.effectiveTarget, 3000, 'a modest best day leaves the target alone');
  small.state.days = { '2026-10-19': { pnl: 1000, balanceEod: 51000 }, '2026-10-20': { pnl: 1000, balanceEod: 52000 } };
  const pass = small.evaluate({ ...base, now: et(21, 11), balance: 53000, dayRealized: 1000 });
  assert.equal(pass.status, STATUS.ACCOUNT_LOCKED);
  assert.match(pass.reasons.find((x) => x.code === 'target_passed').detail, /reached target 3000/);

  const raised = consistencyGuard('raise_target');
  raised.state.days = { '2026-10-19': { pnl: 2000, balanceEod: 52000 } };
  assert.notEqual(raised.evaluate({ ...base, now: et(21, 11), balance: 53100, dayRealized: 1100 }).status, STATUS.ACCOUNT_LOCKED);
  const hit = raised.evaluate({ ...base, now: et(21, 12), balance: 53640, dayRealized: 1640 });
  assert.equal(hit.status, STATUS.ACCOUNT_LOCKED);
  assert.match(hit.reasons.find((x) => x.code === 'target_passed').detail, /raised target 3636\.36/);
});

test('consistency_mode off: neither the cap nor the best-day condition applies', () => {
  const g = consistencyGuard('off');
  const day = g.evaluate({ ...base, now: et(20, 11), balance: 51900, dayRealized: 1900 });
  assert.ok(!codes(day).includes('consistency_cap'));
  assert.equal(day.metrics.consistencyOk, true);
  g.state.days = { '2026-10-19': { pnl: 2500, balanceEod: 52500 } };
  const passed = g.evaluate({ ...base, now: et(21, 11), balance: 53000, dayRealized: 500 });
  assert.equal(passed.metrics.effectiveTarget, 3000);
  assert.ok(codes(passed).includes('target_passed'), 'a lopsided best day does not stop the pass');
});

test('consistency_mode is validated', () => {
  assert.throws(
    () => resolveRules({ phase: 'evaluation', preset: '50k', phases: { evaluation: { consistency_mode: 'strict' } } }, null),
    /consistency_mode must be cap_day, raise_target, off, got "strict"/,
  );
  const off = resolveRules({ phase: 'evaluation', preset: '50k', phases: { evaluation: { consistency_mode: 'off', profit_target: null } } }, null);
  assert.equal(off.rules.consistency_mode, 'off');
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

test('counters set to 0 never block', () => {
  const g = makeGuard({ protection: { daily_profit_lock: { enabled: false }, max_trades_per_day: 0, max_consecutive_losses: 0 } });
  const res = g.evaluate({ ...base, now: et(20, 10), entriesToday: 50, closedResults: [-1, -1, -1, -1, -1] });
  assert.equal(res.status, STATUS.ACTIVE);
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

// Fills the way the gateway stores them: side 0 buy / 1 sell, P&L only on the closing half-turn.
function fills(contractId, rows, day = 20) {
  return rows.map(([hh, mm, side, size, pnl, orderId], i) => ({
    id: `${contractId}-${hh}${mm}-${i}`,
    contractId,
    creationTimestamp: new Date(et(day, hh, mm)).toISOString(),
    side,
    size,
    profitAndLoss: pnl,
    fees: 0.5,
    commissions: 0.25,
    orderId,
  }));
}
const BUY = 0;
const SELL = 1;

test('summarizeFills: a partial exit round trip is one result', () => {
  // Buy 3, sell 1 for +30, sell 2 for +50: three fills with P&L on two of them, one trip.
  const s = summarizeFills(fills('MES', [
    [9, 0, BUY, 3, null, 1], [10, 0, SELL, 1, 30, 2], [11, 0, SELL, 2, 50, 3],
  ]), et(19, 18));
  assert.deepEqual(s.closedResults, [30 + 50 - 3 * 0.75]);
  assert.equal(s.dayRealized, 30 + 50 - 3 * 0.75);
  assert.equal(s.entriesToday, 1);
});

test('summarizeFills: scaling in and out stays one trip; the next trip starts from flat', () => {
  const s = summarizeFills(fills('MES', [
    [9, 0, BUY, 1, null, 1], [9, 5, BUY, 1, null, 2], [10, 0, SELL, 1, 20, 3], [10, 5, SELL, 1, -5, 4],
    [11, 0, SELL, 2, null, 5], [12, 0, BUY, 2, 40, 6],
  ]), et(19, 18));
  assert.deepEqual(s.closedResults, [20 - 5 - 4 * 0.75, 40 - 2 * 0.75]);
  assert.equal(s.entriesToday, 3);
});

test('summarizeFills: a flip closes the old trip and opens a new one', () => {
  // Long 2, then sell 3: closes the long (+60) and opens a short 1. The fill fees split 2:1.
  const rows = [[9, 0, BUY, 2, null, 1], [10, 0, SELL, 3, 60, 2], [11, 0, BUY, 1, -10, 3]];
  const s = summarizeFills(fills('MES', rows), et(19, 18));
  const long = -0.75 + (60 - 0.75 * (2 / 3));
  const short = -0.75 * (1 / 3) + (-10 - 0.75);
  assert.equal(s.closedResults.length, 2);
  assert.ok(Math.abs(s.closedResults[0] - long) < 1e-9);
  assert.ok(Math.abs(s.closedResults[1] - short) < 1e-9);
  // Every dollar of the fills ends up in exactly one result.
  assert.ok(Math.abs(s.closedResults.reduce((a, b) => a + b, 0) - s.dayRealized) < 1e-9);
});

test('summarizeFills: contracts are separate round trips and interleave', () => {
  const rows = [
    ...fills('MES', [[9, 0, BUY, 1, null, 1], [11, 0, SELL, 1, 10, 4]]),
    ...fills('MNQ', [[9, 30, SELL, 2, null, 2], [10, 0, BUY, 1, 5, 3], [10, 30, BUY, 1, 15, 5]]),
  ];
  const s = summarizeFills(rows, et(19, 18));
  // MNQ closes at 10:30, MES at 11:00: results are in the order the trips close.
  assert.deepEqual(s.closedResults, [5 + 15 - 3 * 0.75, 10 - 2 * 0.75]);
  assert.equal(s.entriesToday, 2);
});

test('summarizeFills: a trip opened before the day start closes on the day it ends; voided fills are ignored', () => {
  const rows = [
    ...fills('MES', [[9, 0, BUY, 1, null, 1]], 19), // yesterday, before today's 18:00 reset on the 19th
    ...fills('MES', [[10, 0, SELL, 1, 25, 2]], 20),
  ];
  rows.push({ ...rows[1], id: 'void', voided: true, profitAndLoss: 999 });
  const s = summarizeFills(rows, et(19, 18));
  assert.deepEqual(s.closedResults, [25 - 0.75 - 0.75], 'the entry fees belong to the trip');
  assert.equal(s.dayRealized, 25 - 0.75, 'but only today\'s fills count towards today');
  assert.equal(s.entriesToday, 0);
});

test('summarizeFills: a fill that cannot be tracked still counts, as its own result when it has P&L', () => {
  const s = summarizeFills([
    { id: 1, creationTimestamp: new Date(et(20, 10)).toISOString(), profitAndLoss: 12, fees: 1, commissions: 0, orderId: 9 },
    { id: 2, creationTimestamp: new Date(et(20, 11)).toISOString(), profitAndLoss: null, fees: 1, commissions: 0, orderId: 10 },
  ], et(19, 18));
  assert.deepEqual(s.closedResults, [11]);
  assert.equal(s.dayRealized, 10);
  assert.equal(s.entriesToday, 1);
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

/* ------------------------------------------------------ debounced persistence -- */

function persistGuard(topstep = {}, persistDebounceMs = 40) {
  const resolved = resolveRules({
    phase: 'auto', preset: 'auto',
    protection: { daily_profit_lock: { enabled: false } },
    ...topstep,
    session: { news_blackout: [], ...(topstep.session || {}) },
  }, { name: '50KTC-V2-1', kind: 'TC', sizeUsd: 50000 });
  const statePath = path.join(mkdtempSync(path.join(os.tmpdir(), 'guard-')), 'state.json');
  const guard = new AccountGuard({ resolved, lots: new LotTable(resolved.lots), statePath, persistDebounceMs });
  const onDisk = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null);
  return { guard, statePath, onDisk };
}

test('a new day peak is written a moment later, not on the tick that set it', async () => {
  const { guard, onDisk } = persistGuard();
  // First evaluation of the day rolls the day over, which is critical and written at once.
  guard.evaluate({ ...base, now: et(20, 10) });
  assert.equal(onDisk().dayPeakPnl, 0);

  guard.evaluate({ ...base, now: et(20, 10, 1), unrealized: 400 });
  assert.equal(guard.state.dayPeakPnl, 400);
  assert.equal(onDisk().dayPeakPnl, 0, 'the peak is still only in memory');
  assert.ok(guard.persistTimer, 'a write is scheduled');

  await sleep(80);
  assert.equal(onDisk().dayPeakPnl, 400, 'and it lands after the debounce');
  assert.equal(guard.persistTimer, null);
  assert.equal(guard.persistPending, false);
});

test('many peak updates inside the window cause one write with the latest value', async () => {
  const { guard, onDisk } = persistGuard();
  guard.evaluate({ ...base, now: et(20, 10) });
  let writes = 0;
  const persist = guard.persist.bind(guard);
  guard.persist = () => { writes += 1; persist(); };
  for (let i = 1; i <= 50; i += 1) guard.evaluate({ ...base, now: et(20, 10, 1) + i, unrealized: 10 * i });
  assert.equal(writes, 0);
  await sleep(80);
  assert.equal(writes, 1);
  assert.equal(onDisk().dayPeakPnl, 500);
});

test('an intraday high-water mark is debounced the same way', async () => {
  const { guard, onDisk } = persistGuard({ phases: { evaluation: { max_loss_type: 'trailing_intraday', consistency_pct: null } } });
  guard.evaluate({ ...base, now: et(20, 10) });
  guard.evaluate({ ...base, now: et(20, 10, 1), unrealized: 700 });
  assert.equal(guard.state.hwmIntraday, 50700);
  assert.notEqual(onDisk().hwmIntraday, 50700);
  await sleep(80);
  assert.equal(onDisk().hwmIntraday, 50700);
});

test('locks persist immediately, together with any pending peak', () => {
  const { guard, onDisk } = persistGuard();
  guard.evaluate({ ...base, now: et(20, 10) });
  guard.evaluate({ ...base, now: et(20, 10, 1), unrealized: 300 });
  assert.equal(onDisk().dayPeakPnl, 0);

  const hard = guard.evaluate({ ...base, now: et(20, 10, 2), balance: 49100, dayRealized: -900, unrealized: 0 });
  assert.equal(hard.status, STATUS.DAY_LOCKED);
  const disk = onDisk();
  assert.equal(disk.dayLock.reason, 'dll_hard', 'the lock is on disk before evaluate() returned');
  assert.equal(disk.dayPeakPnl, 300, 'the whole state is written, so the pending peak went along');
  assert.equal(guard.persistTimer, null, 'and the scheduled write was cancelled');
});

test('an account lock persists immediately', () => {
  const { guard, onDisk } = persistGuard();
  guard.evaluate({ ...base, now: et(20, 10) });
  const res = guard.evaluate({ ...base, now: et(20, 10, 1), balance: 48200 });
  assert.equal(res.status, STATUS.ACCOUNT_LOCKED);
  assert.equal(onDisk().accountLock.reason, 'mll_buffer');
});

test('day rollover and the EOD snapshot persist immediately', () => {
  const { guard, onDisk } = persistGuard();
  guard.evaluate({ ...base, now: et(20, 12) });
  assert.equal(onDisk().dayKey, '2026-10-20');
  guard.evaluate({ ...base, now: et(20, 16, 11), balance: 50500, dayRealized: 500 });
  assert.equal(onDisk().lastEodKey, '2026-10-20');
  assert.equal(onDisk().hwmEod, 50500);
  guard.evaluate({ ...base, now: et(21, 10), balance: 50500 });
  assert.equal(onDisk().dayKey, '2026-10-21');
});

test('reset() and rebuildHistory() persist immediately', () => {
  const { guard, onDisk } = persistGuard();
  guard.evaluate({ ...base, now: et(20, 10) });
  guard.evaluate({ ...base, now: et(20, 10, 2), balance: 49100, dayRealized: -900 });
  assert.ok(onDisk().dayLock);
  guard.reset('day');
  assert.equal(onDisk().dayLock, null);

  const fill = { creationTimestamp: new Date(et(19, 10)).toISOString(), profitAndLoss: 600, fees: 1, commissions: 0, orderId: 1 };
  guard.rebuildHistory([fill], 50599, et(21, 10));
  assert.ok(onDisk().days['2026-10-19']);
});

test('flush() writes a pending peak at once and cancels the timer', async () => {
  const { guard, onDisk } = persistGuard({}, 60_000);
  guard.evaluate({ ...base, now: et(20, 10) });
  guard.evaluate({ ...base, now: et(20, 10, 1), unrealized: 250 });
  assert.equal(onDisk().dayPeakPnl, 0);
  guard.flush();
  assert.equal(onDisk().dayPeakPnl, 250);
  assert.equal(guard.persistTimer, null);
  assert.equal(guard.persistPending, false);
});

test('flush() with nothing pending writes nothing', () => {
  const { guard, statePath } = persistGuard({}, 60_000);
  guard.flush();
  assert.equal(existsSync(statePath), false);
  guard.evaluate({ ...base, now: et(20, 10) });
  rmSync(statePath);
  guard.flush();
  assert.equal(existsSync(statePath), false, 'a clean state is not rewritten');
});

test('a restart after flush() sees the peak, so profit giveback still works', () => {
  const lock = { protection: { daily_profit_lock: { enabled: true, activate_at: 800, giveback_pct: 40 } } };
  const first = persistGuard(lock, 60_000);
  first.guard.evaluate({ ...base, now: et(20, 10) });
  first.guard.evaluate({ ...base, now: et(20, 10, 1), unrealized: 1000 });
  first.guard.flush();

  const resolved = resolveRules({ phase: 'auto', preset: 'auto', ...lock, session: { news_blackout: [] } }, { name: '50KTC-V2-1', kind: 'TC', sizeUsd: 50000 });
  const second = new AccountGuard({ resolved, lots: new LotTable(resolved.lots), statePath: first.statePath });
  assert.equal(second.state.dayPeakPnl, 1000);
  const res = second.evaluate({ ...base, now: et(20, 10, 5), unrealized: 590 });
  assert.equal(res.status, STATUS.DAY_LOCKED);
});
