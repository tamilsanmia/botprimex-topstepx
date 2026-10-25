import { zonedToUtc } from './session.js';

/**
 * CME holiday and early-close days for 2026 and 2027, as the guard uses them.
 *
 * Cautious by design; docs/topstep-rules-sources.md explains the sources and the gaps.
 * - Every product is treated as halting at the EARLIEST time seen, 13:00 ET (12:00 CT).
 *   Equity products on the day after Thanksgiving and 24 Dec halt at 13:15 ET, and some
 *   metals, energy and rates products differ by a few minutes.
 * - Topstep closes positions 15 minutes before any early close (verified, see the doc), so the
 *   guard stops entries 35 minutes before the close and flattens 20 minutes before it.
 * - A "closed" day blocks the whole trading day named by its date, from the evening
 *   before's reset (18:00 ET) to its own reset, like a weekend.
 * - Rows are keyed by the trading-day key the guard uses (the date the session ends on).
 * - `verified: false` means not confirmed against CME. No row is verified: the CME equity
 *   calendar could not be fetched, and the 2027 rows are derived from U.S. holiday rules.
 *
 * projectx/holidays.py carries the same data; tests/fixtures/guard_parity.json pins both.
 */
export const HOLIDAY_TIMEZONE = 'America/New_York';

export const HOLIDAY_RULES = Object.freeze({
  /** Earliest halt seen across products, ET wall clock. */
  earlyCloseEt: '13:00',
  /** Topstep: all positions closed this long before any early close (verified). */
  topstepCutoffMinBeforeClose: 15,
  /** The guard flattens this long before the close: the Topstep cutoff plus a 5 minute margin. */
  flatMinBeforeClose: 20,
  /** The guard stops entries this long before the close. */
  noEntryMinBeforeClose: 35,
});

const VERIFIED_ON = '2026-10-25';
const SRC_2026 = 'https://crosstrade.io/blog/cme-trading-hours-2026; https://damnpropfirms.com/trading-guides/cme-holiday-schedule/';
const SRC_2027 = 'derived from U.S. holiday rules (CME 2027 calendar not published when written); https://help.topstep.com/en/articles/13350348-topstep-holiday-trading-hours';

const closed = (date, name, source) => ({ date, name, type: 'closed', closeEt: null, source, verified: false, verifiedOn: VERIFIED_ON });
const early = (date, name, source) => ({ date, name, type: 'early', closeEt: HOLIDAY_RULES.earlyCloseEt, source, verified: false, verifiedOn: VERIFIED_ON });

export const HOLIDAYS = Object.freeze([
  closed('2026-01-01', "New Year's Day", SRC_2026),
  early('2026-01-19', 'Martin Luther King Jr. Day', SRC_2026),
  early('2026-02-16', "Presidents' Day", SRC_2026),
  closed('2026-04-03', 'Good Friday (jobs report day, special CME settlement)', SRC_2026),
  early('2026-05-25', 'Memorial Day', SRC_2026),
  early('2026-06-19', 'Juneteenth', SRC_2026),
  early('2026-07-03', 'Independence Day (observed)', SRC_2026),
  early('2026-09-07', 'Labor Day', SRC_2026),
  early('2026-11-26', 'Thanksgiving Day', SRC_2026),
  early('2026-11-27', 'Day after Thanksgiving', SRC_2026),
  early('2026-12-24', 'Christmas Eve', SRC_2026),
  closed('2026-12-25', 'Christmas Day', SRC_2026),

  closed('2027-01-01', "New Year's Day", SRC_2027),
  early('2027-01-18', 'Martin Luther King Jr. Day', SRC_2027),
  early('2027-02-15', "Presidents' Day", SRC_2027),
  closed('2027-03-26', 'Good Friday', SRC_2027),
  early('2027-05-31', 'Memorial Day', SRC_2027),
  early('2027-06-18', 'Juneteenth (observed, a guess: 19 Jun is a Saturday)', SRC_2027),
  early('2027-07-05', 'Independence Day (observed)', SRC_2027),
  early('2027-09-06', 'Labor Day', SRC_2027),
  early('2027-11-25', 'Thanksgiving Day', SRC_2027),
  early('2027-11-26', 'Day after Thanksgiving', SRC_2027),
  closed('2027-12-24', 'Christmas Day (observed)', SRC_2027),
]);

const BY_DATE = new Map(HOLIDAYS.map((h) => [h.date, h]));

/** The holiday row for a trading-day key ("YYYY-MM-DD"), or null. */
export function holidayFor(key) {
  return BY_DATE.get(key) || null;
}

/**
 * Absolute times (epoch ms) of an early-close row: the halt, the cutoff for new entries
 * and the time the guard flattens. Null for a closed day.
 */
export function earlyCloseTimes(row) {
  if (!row || row.type !== 'early') return null;
  const [y, m, d] = row.date.split('-').map(Number);
  const [hh, mm] = row.closeEt.split(':').map(Number);
  const closeTs = zonedToUtc(y, m, d, hh, mm, HOLIDAY_TIMEZONE);
  const minute = 60_000;
  return {
    closeTs,
    noEntryTs: closeTs - HOLIDAY_RULES.noEntryMinBeforeClose * minute,
    flatTs: closeTs - HOLIDAY_RULES.flatMinBeforeClose * minute,
  };
}
