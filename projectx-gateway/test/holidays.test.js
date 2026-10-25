import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AccountGuard, STATUS } from '../src/guard.js';
import { HOLIDAYS, HOLIDAY_RULES, HOLIDAY_TIMEZONE, earlyCloseTimes, holidayFor } from '../src/holidays.js';
import { LotTable } from '../src/lots.js';
import { resolveRules } from '../src/rules.js';
import { localParts, zonedToUtc } from '../src/session.js';

const TZ = 'America/New_York';
const at = (y, m, d, hh, mm = 0) => zonedToUtc(y, m, d, hh, mm, TZ);

function makeGuard(topstep = {}) {
  const resolved = resolveRules({
    phase: 'evaluation', preset: '50k', start_balance: 50000,
    protection: { daily_profit_lock: { enabled: false } },
    ...topstep,
    session: { news_blackout: [], ...(topstep.session || {}) },
  }, null);
  return new AccountGuard({ resolved, lots: new LotTable(resolved.lots), statePath: null });
}
const base = { balance: 50000, unrealized: 0, dayRealized: 0, closedResults: [], entriesToday: 0, legs: [] };
const codes = (res) => res.reasons.map((r) => r.code);
const evalAt = (g, y, m, d, hh, mm = 0, extra = {}) => g.evaluate({ ...base, now: at(y, m, d, hh, mm), ...extra });

test('the table is well formed: unique weekday dates, a source and a check date on every row', () => {
  const seen = new Set();
  for (const h of HOLIDAYS) {
    assert.match(h.date, /^20(26|27)-\d\d-\d\d$/);
    assert.ok(!seen.has(h.date), `duplicate ${h.date}`);
    seen.add(h.date);
    const [y, m, d] = h.date.split('-').map(Number);
    const weekday = localParts(at(y, m, d, 12), TZ).weekday;
    assert.ok(weekday >= 1 && weekday <= 5, `${h.date} ${h.name} is not a weekday`);
    assert.ok(h.name && h.source && /^\d{4}-\d\d-\d\d$/.test(h.verifiedOn), `${h.date} lacks name, source or verifiedOn`);
    assert.equal(h.verified, false, 'no row is verified against CME');
    assert.ok(['closed', 'early'].includes(h.type));
    assert.equal(h.type === 'early' ? h.closeEt : null, h.closeEt);
  }
  assert.deepEqual([...seen], [...seen].sort(), 'rows are in date order');
  assert.ok(HOLIDAYS.some((h) => h.date.startsWith('2026')) && HOLIDAYS.some((h) => h.date.startsWith('2027')));
  // Spot checks against the U.S. holiday rules.
  for (const date of ['2026-04-03', '2026-12-25', '2027-03-26', '2027-12-24']) assert.equal(holidayFor(date).type, 'closed', date);
  for (const date of ['2026-05-25', '2026-11-26', '2026-11-27', '2027-05-31', '2027-11-25']) assert.equal(holidayFor(date).type, 'early', date);
  assert.equal(holidayFor('2026-10-20'), null);
});

test('early-close times follow the ET wall clock through DST', () => {
  const memorial = earlyCloseTimes(holidayFor('2026-05-25'));
  assert.equal(memorial.closeTs, Date.UTC(2026, 4, 25, 17, 0), '13:00 EDT');
  assert.equal(memorial.noEntryTs, memorial.closeTs - 35 * 60_000);
  assert.equal(memorial.flatTs, memorial.closeTs - 20 * 60_000);
  assert.equal(earlyCloseTimes(holidayFor('2026-11-26')).closeTs, Date.UTC(2026, 10, 26, 18, 0), '13:00 EST');
  assert.equal(earlyCloseTimes(holidayFor('2026-12-25')), null);
  // Topstep's cutoff is 15 minutes before the close; the guard flattens before it.
  assert.ok(HOLIDAY_RULES.flatMinBeforeClose > HOLIDAY_RULES.topstepCutoffMinBeforeClose);
  assert.ok(HOLIDAY_RULES.noEntryMinBeforeClose > HOLIDAY_RULES.flatMinBeforeClose);
});

test('an early close tightens no_entry_after and flat_by for that day only', () => {
  const g = makeGuard();
  assert.equal(evalAt(g, 2026, 5, 25, 10).status, STATUS.ACTIVE);
  assert.equal(evalAt(g, 2026, 5, 25, 12, 24).status, STATUS.ACTIVE);

  const late = evalAt(g, 2026, 5, 25, 12, 25);
  assert.equal(late.status, STATUS.ENTRIES_BLOCKED);
  assert.deepEqual(codes(late), ['no_entry_window']);
  assert.equal(late.flatten, false);
  assert.equal(evalAt(g, 2026, 5, 25, 12, 39).flatten, false);

  const flat = evalAt(g, 2026, 5, 25, 12, 40);
  assert.ok(flat.flatten);
  assert.deepEqual(flat.flattenReasons, ['session_flat_by']);
  assert.ok(evalAt(g, 2026, 5, 25, 14).flatten);
  assert.ok(evalAt(g, 2026, 5, 25, 17, 59).flatten);
  assert.deepEqual(flat.holiday, { date: '2026-05-25', name: 'Memorial Day', type: 'early', closeEt: '13:00' });

  // The reopen at 18:00 starts Tuesday's trading day, which is a normal one.
  assert.equal(evalAt(g, 2026, 5, 25, 18, 6).status, STATUS.ACTIVE);
  assert.equal(evalAt(g, 2026, 5, 25, 18, 6).holiday, null);
  assert.equal(evalAt(g, 2026, 5, 26, 12, 30).status, STATUS.ACTIVE);
  // The Sunday evening session that belongs to the holiday's trading day is open.
  assert.equal(evalAt(g, 2026, 5, 24, 18, 30).status, STATUS.ACTIVE);
});

test('an early close never loosens times that are already earlier in the config', () => {
  const g = makeGuard({ session: { no_entry_after: '11:00', flat_by: '12:00' } });
  assert.ok(codes(evalAt(g, 2026, 5, 25, 11, 5)).includes('no_entry_window'));
  assert.equal(evalAt(g, 2026, 5, 25, 11, 5).flatten, false);
  assert.ok(evalAt(g, 2026, 5, 25, 12, 5).flatten);
  // A configured time later than the holiday's is brought forward.
  const normal = makeGuard();
  assert.equal(evalAt(normal, 2026, 5, 26, 12, 30).status, STATUS.ACTIVE);
  assert.equal(evalAt(normal, 2026, 5, 25, 12, 30).status, STATUS.ENTRIES_BLOCKED);
});

test('an early close in overnight hold mode blocks entries but does not flatten', () => {
  const g = makeGuard({ session: { hold_mode: 'overnight' } });
  const res = evalAt(g, 2026, 5, 25, 14);
  assert.equal(res.status, STATUS.ENTRIES_BLOCKED);
  assert.equal(res.flatten, false);
});

test('a closed day behaves like a weekend: entries blocked and positions flattened', () => {
  const g = makeGuard();
  const friday = evalAt(g, 2026, 4, 3, 10);
  assert.equal(friday.status, STATUS.ENTRIES_BLOCKED);
  assert.deepEqual(codes(friday), ['holiday']);
  assert.deepEqual(friday.flattenReasons, ['holiday']);
  assert.ok(friday.flatten && !friday.canEnter);
  assert.equal(friday.holiday.type, 'closed');
  // The session that opens the evening before belongs to the closed day.
  assert.ok(evalAt(g, 2026, 4, 2, 19).flatten);
  assert.equal(evalAt(g, 2026, 4, 2, 12).status, STATUS.ACTIVE);
  // Overnight hold mode does not exempt a closed day, same as a weekend.
  const overnight = makeGuard({ session: { hold_mode: 'overnight' } });
  assert.ok(evalAt(overnight, 2026, 12, 25, 11).flatten);
});

test('use_holiday_calendar false ignores the table', () => {
  const g = makeGuard({ session: { use_holiday_calendar: false } });
  assert.equal(evalAt(g, 2026, 4, 3, 10).status, STATUS.ACTIVE);
  const afterEarlyClose = evalAt(g, 2026, 5, 25, 14);
  assert.equal(afterEarlyClose.status, STATUS.ACTIVE, 'the normal 15:45 no-entry time is not reached');
  assert.equal(afterEarlyClose.flatten, false);
  assert.equal(afterEarlyClose.holiday, null);
});

test('use_holiday_calendar must be a boolean', () => {
  assert.throws(() => makeGuard({ session: { use_holiday_calendar: 'yes' } }), /use_holiday_calendar must be true or false/);
});

test('sessionClosed covers closed days and the hours after an early close', () => {
  const g = makeGuard();
  assert.equal(g.sessionClosed(at(2026, 4, 3, 10)), true);
  assert.equal(g.sessionClosed(at(2026, 5, 25, 12, 59)), false);
  assert.equal(g.sessionClosed(at(2026, 5, 25, 13, 0)), true);
  assert.equal(g.sessionClosed(at(2026, 5, 25, 17, 59)), true);
  assert.equal(g.sessionClosed(at(2026, 5, 25, 18, 1)), false);
  assert.equal(g.sessionClosed(at(2026, 5, 26, 14)), false);
});

test('stale quotes are not counted while a holiday keeps the market shut', () => {
  const g = makeGuard();
  const stale = (now) => ({ reasons: [{ code: 'quote_stale', root: 'ES', since: now - 3_600_000 }] });
  const closedDay = at(2026, 4, 3, 10);
  assert.ok(!codes(g.evaluate({ ...base, now: closedDay, dataHealth: stale(closedDay) })).includes('data_stale'));
  const afterClose = at(2026, 5, 25, 14);
  assert.ok(!codes(g.evaluate({ ...base, now: afterClose, dataHealth: stale(afterClose) })).includes('data_stale'));
  const open = at(2026, 5, 26, 11);
  assert.ok(codes(g.evaluate({ ...base, now: open, dataHealth: stale(open) })).includes('data_stale'));
});

test('the table matches the snapshot that projectx/holidays.py is tested against', () => {
  // After editing holidays.js (and holidays.py), rewrite tests/fixtures/holidays.json as
  // JSON.stringify({ _comment, timezone: HOLIDAY_TIMEZONE, rules: HOLIDAY_RULES, holidays: HOLIDAYS }, null, 2).
  const snapshot = JSON.parse(readFileSync(new URL('../../tests/fixtures/holidays.json', import.meta.url), 'utf8'));
  assert.equal(snapshot.timezone, HOLIDAY_TIMEZONE);
  assert.deepEqual(snapshot.rules, HOLIDAY_RULES);
  assert.deepEqual(snapshot.holidays, JSON.parse(JSON.stringify(HOLIDAYS)));
});
