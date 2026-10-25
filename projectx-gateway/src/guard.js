import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { earlyCloseTimes, holidayFor } from './holidays.js';
import { ORDER_SIDE } from './projectx.js';
import { maxMiniEquivalent } from './rules.js';
import { SessionClock, inWindow, parseDays, parseHHMM } from './session.js';

export const STATUS = Object.freeze({
  ACTIVE: 'active',
  ENTRIES_BLOCKED: 'entries_blocked',
  DAY_LOCKED: 'day_locked',
  ACCOUNT_LOCKED: 'account_locked',
});

const RANK = { active: 0, entries_blocked: 1, day_locked: 2, account_locked: 3 };

const PERSIST_DEBOUNCE_MS = 1000;
const STALE_DEFAULTS = Object.freeze({ block_entries_secs: 15, flatten_secs: 120 });

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

function emptyState() {
  return {
    version: 1,
    hwmEod: null,
    hwmIntraday: null,
    days: {},
    lastEodKey: null,
    dayKey: null,
    dayPeakPnl: 0,
    dayLock: null,
    accountLock: null,
  };
}

/**
 * Net P&L of a fill the way TopstepX reports it: gross P&L (only on the closing
 * half-turn) minus fees minus commissions, which the gateway bills separately.
 */
export function fillNet(t) {
  const gross = t.profitAndLoss === null || t.profitAndLoss === undefined ? 0 : Number(t.profitAndLoss) || 0;
  return gross - (Number(t.fees) || 0) - (Number(t.commissions) || 0);
}

/**
 * Today's realized P&L, closed results in order, and entries, from raw fills.
 *
 * A closed result is a round trip: the net of every fill of one contract from flat
 * back to flat, so scaling in or out of a position is one result, like a closed
 * Freqtrade trade. A fill that flips the position closes the old trip and opens a
 * new one (its fees are split by size). Position state is tracked over all fills, so
 * a trip opened before dayStart counts on the day it closes. A fill without a usable
 * side or size cannot be tracked: it counts in dayRealized, and as its own result
 * when it carries P&L.
 */
export function summarizeFills(trades, dayStart) {
  const fills = trades
    .filter((t) => !t.voided && Number.isFinite(Date.parse(t.creationTimestamp)))
    .map((t) => ({ t, ts: Date.parse(t.creationTimestamp) }))
    .sort((a, b) => a.ts - b.ts || (Number(a.t.id) || 0) - (Number(b.t.id) || 0));

  let dayRealized = 0;
  const closedResults = [];
  const entries = new Set();
  const trips = new Map(); // contractId -> { pos, net } for the round trip in progress
  for (const { t, ts } of fills) {
    const today = ts >= dayStart;
    const net = fillNet(t);
    const opening = t.profitAndLoss === null || t.profitAndLoss === undefined;
    if (today) {
      dayRealized += net;
      if (opening) entries.add(t.orderId ?? t.id);
    }

    const size = Number(t.size);
    const sign = t.side === ORDER_SIDE.BUY ? 1 : t.side === ORDER_SIDE.SELL ? -1 : 0;
    if (!sign || !(size > 0)) {
      if (today && !opening) closedResults.push(net);
      continue;
    }

    const key = t.contractId ?? '';
    const trip = trips.get(key) || { pos: 0, net: 0 };
    const signed = sign * size;
    const after = trip.pos + signed;
    if (trip.pos !== 0 && Math.sign(after) !== Math.sign(trip.pos)) {
      // Back to flat or through it: the part up to flat closes the trip.
      const closeShare = Math.abs(trip.pos) / size;
      const gross = opening ? 0 : Number(t.profitAndLoss) || 0;
      const fees = (Number(t.fees) || 0) + (Number(t.commissions) || 0);
      const result = trip.net + gross - fees * closeShare;
      if (today) closedResults.push(result);
      trips.set(key, after === 0 ? { pos: 0, net: 0 } : { pos: after, net: -fees * (1 - closeShare) });
    } else {
      trips.set(key, { pos: after, net: trip.net + net });
    }
  }
  return { dayRealized, closedResults, entriesToday: entries.size };
}

/**
 * Topstep rules and account protection.
 *
 * Pure evaluation over (rules, persisted state, live inputs). It is run on every
 * tick and fill, independent of Freqtrade's loop, and its verdict is enforced by
 * the order router (entries refused) and the flatten fallback.
 */
export class AccountGuard extends EventEmitter {
  constructor({ resolved, lots, statePath, now = () => Date.now(), stale = {}, persistDebounceMs = PERSIST_DEBOUNCE_MS }) {
    super();
    this.resolved = resolved;
    this.stale = { ...STALE_DEFAULTS, ...stale };
    this.persistDebounceMs = persistDebounceMs;
    this.persistTimer = null;
    this.persistPending = false;
    this.rules = resolved.rules;
    this.session = resolved.session;
    this.protection = resolved.protection;
    this.start = resolved.startBalance;
    this.lots = lots;
    this.statePath = statePath;
    this.now = now;
    this.clock = new SessionClock({
      timezone: resolved.timezone,
      reset_time: this.session.reset_time,
      eod_time: this.session.eod_time,
    });
    this.times = {
      noEntryBefore: parseHHMM(this.session.no_entry_before),
      noEntryAfter: parseHHMM(this.session.no_entry_after),
      flatBy: parseHHMM(this.session.flat_by),
      reset: parseHHMM(this.session.reset_time),
      windows: (this.session.trading_windows || []).map((w) => ({ start: parseHHMM(w.start), end: parseHHMM(w.end) })),
      news: (this.session.news_blackout || []).map((w) => ({
        days: parseDays(w.days), start: parseHHMM(w.start), end: parseHHMM(w.end), flatten: Boolean(w.flatten), label: w.label || null,
      })),
    };
    this.state = this.load();
    this.last = null;
    this.lastSignature = null;
  }

  load() {
    if (!this.statePath) return emptyState();
    try {
      return { ...emptyState(), ...JSON.parse(readFileSync(this.statePath, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[guard] state ${this.statePath} unreadable (${err.message}); starting fresh`);
      return emptyState();
    }
  }

  /** Writes the state to disk now (atomic tmp + rename). Locks, day rollover and EOD snapshots use this. */
  persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.persistPending = false;
    if (!this.statePath) return;
    mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.statePath);
  }

  /**
   * Persists a change that can wait: a new day peak or intraday high-water mark
   * moves on nearly every tick while a position is open, and writing the file each
   * time blocks the event loop. The write happens at most persistDebounceMs later.
   * Losing it in a crash costs at most that second of peak, never a lock.
   */
  persistLater() {
    this.persistPending = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.persistPending) this.persist();
    }, this.persistDebounceMs);
    this.persistTimer.unref?.();
  }

  /** Writes any debounced change now. Call on shutdown. */
  flush() {
    if (this.persistPending) this.persist();
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }

  /**
   * Rebuilds end-of-day history the gateway missed (it was down at eod_time) from
   * fills. Each past day's EOD balance is the current balance minus every fill's
   * net P&L after that day's EOD. Never invents a day with no fills.
   */
  rebuildHistory(trades, currentBalance, now = this.now()) {
    const today = this.clock.tradingDay(now);
    const fills = trades.filter((t) => !t.voided).map((t) => ({ ts: Date.parse(t.creationTimestamp), net: fillNet(t) }))
      .filter((f) => Number.isFinite(f.ts)).sort((a, b) => a.ts - b.ts);

    const byDay = new Map();
    for (const f of fills) {
      const day = this.clock.tradingDay(f.ts);
      if (day.key === today.key) continue;
      const entry = byDay.get(day.key) || { pnl: 0, eodTs: day.eodTs };
      entry.pnl += f.net;
      byDay.set(day.key, entry);
    }

    let added = 0;
    for (const [key, entry] of byDay) {
      if (this.state.days[key]) continue;
      const after = fills.filter((f) => f.ts > entry.eodTs).reduce((s, f) => s + f.net, 0);
      this.state.days[key] = { pnl: round2(entry.pnl), balanceEod: round2(currentBalance - after), rebuilt: true };
      added += 1;
    }
    if (added) {
      for (const d of Object.values(this.state.days)) {
        this.state.hwmEod = Math.max(this.state.hwmEod ?? this.start, d.balanceEod);
      }
      const keys = Object.keys(this.state.days).sort();
      const lastKey = keys[keys.length - 1];
      if (!this.state.lastEodKey || lastKey > this.state.lastEodKey) this.state.lastEodKey = lastKey;
      this.persist();
      console.log(`[guard] rebuilt ${added} missed end-of-day snapshot(s) from fills`);
    }
    return added;
  }

  isWeekend(p) {
    const t = this.times;
    return p.weekday === 6
      || (p.weekday === 5 && p.minutes >= t.flatBy)
      || (p.weekday === 0 && p.minutes < t.reset);
  }

  /**
   * True while the market is shut (weekend, or flat_by until the reset, which
   * also covers the CME maintenance break), so no quotes are expected. This
   * ignores hold_mode and trade_weekends on purpose: they decide what the bot may
   * do, not whether the exchange is quoting.
   */
  sessionClosed(now) {
    const p = this.clock.local(now);
    if (this.isWeekend(p) || inWindow(p.minutes, this.times.flatBy, this.times.reset)) return true;
    const h = this.holiday(now);
    return Boolean(h && (h.closed || now >= h.times.closeTs));
  }

  /**
   * The holiday row for the trading day containing `now` ({ row, closed, times, endTs }), or
   * null when the calendar is off or the day is a normal one. `times` is set for an early
   * close; endTs is the session reset that ends the day.
   */
  holiday(now) {
    if (this.session.use_holiday_calendar === false) return null;
    const day = this.clock.tradingDay(now);
    const row = holidayFor(day.key);
    if (!row) return null;
    return { row, closed: row.type === 'closed', times: earlyCloseTimes(row), endTs: day.end };
  }

  /**
   * Turns input.dataHealth reasons ({ code, root?, since }) into entry blocks and
   * a flatten flag. A reason counts once it is block_entries_secs old and counts
   * towards flatten at flatten_secs. Quote staleness is not counted while the
   * market is shut, and never reaches back before the current session's reopen.
   */
  staleness(health, now, dayStart) {
    const out = { block: [], flatten: false };
    const blockMs = Number(this.stale.block_entries_secs) * 1000;
    const flattenMs = Number(this.stale.flatten_secs) * 1000;
    const closed = this.sessionClosed(now);
    for (const r of health?.reasons || []) {
      const quote = r.code === 'quote_stale';
      if (quote && closed) continue;
      const reported = Number(r.since);
      const since = quote ? Math.max(Number.isFinite(reported) ? reported : 0, dayStart) : (Number.isFinite(reported) ? reported : 0);
      const age = now - since;
      if (age < blockMs) continue;
      out.block.push(`${r.code}${r.root ? ` ${r.root}` : ''} ${Math.round(age / 1000)}s`);
      if (flattenMs > 0 && age >= flattenMs) out.flatten = true;
    }
    return out;
  }

  sessionFlags(now) {
    const p = this.clock.local(now);
    const t = this.times;
    const out = { blockEntries: [], flatten: [] };

    if (this.isWeekend(p) && !this.session.trade_weekends) {
      out.blockEntries.push('weekend');
      out.flatten.push('weekend');
      return out;
    }

    // A holiday acts like a weekend. An early close adds a tighter no-entry and flat-by time; it never
    // loosens the configured ones, which still apply below.
    const holiday = this.holiday(now);
    if (holiday?.closed) {
      out.blockEntries.push('holiday');
      out.flatten.push('holiday');
      return out;
    }

    if (inWindow(p.minutes, t.noEntryAfter, t.noEntryBefore)) out.blockEntries.push('no_entry_window');
    if (holiday && now >= holiday.times.noEntryTs && now < holiday.endTs && !out.blockEntries.includes('no_entry_window')) {
      out.blockEntries.push('no_entry_window');
    }
    if (t.windows.length && !t.windows.some((w) => inWindow(p.minutes, w.start, w.end))) out.blockEntries.push('outside_trading_windows');
    for (const w of t.news) {
      if (w.days.has(p.weekday) && inWindow(p.minutes, w.start, w.end)) {
        out.blockEntries.push(w.label ? `news_blackout:${w.label}` : 'news_blackout');
        if (w.flatten) out.flatten.push('news_blackout');
      }
    }
    if (this.session.hold_mode === 'intraday'
      && (inWindow(p.minutes, t.flatBy, t.reset) || (holiday && now >= holiday.times.flatTs && now < holiday.endTs))) {
      out.flatten.push('session_flat_by');
    }
    return out;
  }

  /**
   * @param input.balance       settled balance (realized, after fees)
   * @param input.unrealized    open P&L at current marks
   * @param input.dayRealized   net realized P&L since the session reset
   * @param input.closedResults net result of each close today, in order
   * @param input.entriesToday  entry fills today
   * @param input.legs          [{ root, contracts }] open positions + working entries
   * @param input.dataHealth    { reasons: [{ code, root?, since }] } stale or missing market/account data
   */
  evaluate(input) {
    const now = input.now ?? this.now();
    const s = this.state;
    const r = this.rules;
    const p = this.protection;
    const day = this.clock.tradingDay(now);
    const balance = Number(input.balance) || 0;
    const unrealized = Number(input.unrealized) || 0;
    const dayRealized = Number(input.dayRealized) || 0;
    const equity = balance + unrealized;
    let dirty = false; // changes that must reach disk before evaluate() returns
    let minorDirty = false; // high-water marks, which may be written a moment later

    // A new trading day began. If the previous one was never snapshotted (the
    // gateway was not running at its EOD), close it from what is known now.
    if (s.dayKey !== day.key) {
      if (s.dayKey && s.lastEodKey !== s.dayKey && !s.days[s.dayKey]) {
        const balanceEod = balance - dayRealized;
        s.days[s.dayKey] = { pnl: round2(s.lastDayRealized ?? 0), balanceEod: round2(balanceEod), late: true };
        s.hwmEod = Math.max(s.hwmEod ?? this.start, balanceEod);
        s.lastEodKey = s.dayKey;
      }
      s.dayKey = day.key;
      s.dayPeakPnl = 0;
      if (s.dayLock && s.dayLock.key !== day.key) s.dayLock = null;
      dirty = true;
    }
    s.lastDayRealized = round2(dayRealized);

    // End-of-day snapshot: feeds the EOD high-water mark, best day and winning days.
    if (now >= day.eodTs && s.lastEodKey !== day.key) {
      s.days[day.key] = { pnl: round2(dayRealized + unrealized), balanceEod: round2(equity) };
      s.hwmEod = Math.max(s.hwmEod ?? this.start, equity);
      s.lastEodKey = day.key;
      dirty = true;
    }

    const dayPnl = dayRealized + (r.daily_loss_type === 'intraday' ? unrealized : 0);
    if (dayPnl > s.dayPeakPnl) {
      s.dayPeakPnl = dayPnl;
      minorDirty = true;
    }
    const dayLoss = Math.max(0, -dayPnl);
    const totalProfit = balance - this.start;

    // Maximum Loss Limit floor.
    let hwm;
    if (r.max_loss_type === 'trailing_intraday') {
      const next = Math.max(s.hwmIntraday ?? this.start, this.start, equity);
      if (next !== s.hwmIntraday) {
        s.hwmIntraday = next;
        minorDirty = true;
      }
      hwm = next;
    } else if (r.max_loss_type === 'trailing_eod') {
      hwm = Math.max(s.hwmEod ?? this.start, this.start);
    } else {
      hwm = this.start;
    }
    let floor = hwm - r.max_loss_limit;
    if (r.max_loss_type !== 'static' && r.mll_lock_balance !== null && r.mll_lock_balance !== undefined) {
      floor = Math.min(floor, Number(r.mll_lock_balance));
    }
    const mllRoom = equity - floor;

    const pastDays = Object.entries(s.days).filter(([k]) => k !== day.key).map(([, d]) => d.pnl);
    const bestDay = Math.max(dayRealized, ...pastDays, 0);
    // cap_day stops entries for the day at pct x target; raise_target has no cap and lifts the target to
    // bestDay / pct instead (Topstep's rule); off ignores consistency. A pass needs totalProfit >= effectiveTarget
    // in cap_day too, which is the same as the best day staying within pct of the total profit.
    const mode = r.consistency_mode || 'cap_day';
    const pct = mode !== 'off' && r.consistency_pct ? r.consistency_pct / 100 : null;
    const consistencyCap = mode === 'cap_day' && pct && r.profit_target ? pct * r.profit_target : null;
    const consistencyOk = !pct || totalProfit <= 0 || bestDay <= pct * totalProfit;
    const effectiveTarget = r.profit_target ? Math.max(r.profit_target, pct ? bestDay / pct : 0) : null;

    const lastEod = s.lastEodKey ? s.days[s.lastEodKey]?.balanceEod : null;
    const scalingProfit = (Number.isFinite(lastEod) ? lastEod : balance) - this.start;
    const maxMini = maxMiniEquivalent(r, scalingProfit);
    const legs = input.legs || [];
    const exposure = this.lots.exposure(legs);

    let tail = 0;
    for (const result of [...(input.closedResults || [])].reverse()) {
      if (result < 0) tail += 1;
      else break;
    }

    const reasons = [];
    const add = (level, code, detail) => reasons.push({ level, code, detail });

    if (s.accountLock) add(STATUS.ACCOUNT_LOCKED, s.accountLock.reason, s.accountLock.detail);
    if (mllRoom <= p.mll_buffer) {
      this.lockAccount('mll_buffer', `equity ${round2(equity)} is ${round2(mllRoom)} above the MLL floor ${round2(floor)} (buffer ${p.mll_buffer})`, reasons);
      dirty = true;
    }
    if (r.profit_target && r.stop_on_target && totalProfit >= effectiveTarget) {
      const detail = effectiveTarget > r.profit_target
        ? `profit ${round2(totalProfit)} reached the raised target ${round2(effectiveTarget)} (best day ${round2(bestDay)})`
        : `profit ${round2(totalProfit)} reached target ${r.profit_target} with consistency met`;
      this.lockAccount('target_passed', detail, reasons);
      dirty = true;
    }

    if (s.dayLock?.key === day.key) add(STATUS.DAY_LOCKED, s.dayLock.reason, s.dayLock.detail);
    const dll = r.daily_loss_limit || null;
    if (dll && dayLoss >= dll * (p.dll_hard_pct / 100)) {
      this.lockDay(day.key, 'dll_hard', `day loss ${round2(dayLoss)} >= ${p.dll_hard_pct}% of DLL ${dll}`, reasons);
      dirty = true;
    }
    const lock = p.daily_profit_lock;
    if (lock?.enabled && s.dayPeakPnl >= lock.activate_at && s.dayPeakPnl - dayPnl >= (lock.giveback_pct / 100) * s.dayPeakPnl) {
      this.lockDay(day.key, 'profit_giveback', `day P&L ${round2(dayPnl)} gave back ${lock.giveback_pct}% of peak ${round2(s.dayPeakPnl)}`, reasons);
      dirty = true;
    }

    if (dll && dayLoss >= dll * (p.dll_soft_pct / 100)) add(STATUS.ENTRIES_BLOCKED, 'dll_soft', `day loss ${round2(dayLoss)} >= ${p.dll_soft_pct}% of DLL ${dll}`);
    if (consistencyCap && dayPnl >= consistencyCap) add(STATUS.ENTRIES_BLOCKED, 'consistency_cap', `day P&L ${round2(dayPnl)} >= consistency cap ${round2(consistencyCap)}`);
    if (p.max_trades_per_day && (input.entriesToday || 0) >= p.max_trades_per_day) add(STATUS.ENTRIES_BLOCKED, 'max_trades_per_day', `${input.entriesToday} entries today`);
    if (p.max_consecutive_losses && tail >= p.max_consecutive_losses) add(STATUS.ENTRIES_BLOCKED, 'max_consecutive_losses', `${tail} losses in a row`);
    if (maxMini - exposure < 1 / this.lots.microRatio - 1e-9) {
      add(STATUS.ENTRIES_BLOCKED, 'contract_limit', `exposure ${exposure} of ${maxMini} mini-equivalents`);
    }

    const session = this.sessionFlags(now);
    for (const code of session.blockEntries) add(STATUS.ENTRIES_BLOCKED, code, null);
    const stale = this.staleness(input.dataHealth, now, day.start);
    if (stale.block.length) add(STATUS.ENTRIES_BLOCKED, 'data_stale', stale.block.join('; '));

    const status = reasons.reduce((acc, x) => (RANK[x.level] > RANK[acc] ? x.level : acc), STATUS.ACTIVE);
    const flattenReasons = [...session.flatten];
    if (status === STATUS.DAY_LOCKED || status === STATUS.ACCOUNT_LOCKED) flattenReasons.unshift(status);
    // Flatten uses REST, which works without the hubs, so stale data with a position open closes it.
    if (stale.flatten && legs.some((l) => Math.abs(Number(l.contracts)) > 0)) flattenReasons.push('data_stale');

    const winningDays = r.payout
      ? Object.values(s.days).filter((d) => d.pnl >= r.payout.min_winning_day_amount).length
      : null;

    const result = {
      status,
      canEnter: status === STATUS.ACTIVE,
      flatten: flattenReasons.length > 0,
      flattenReasons,
      reasons,
      phase: this.resolved.phase,
      tradingDay: day.key,
      holiday: this.holidayInfo(now),
      sessionStart: day.start,
      eodTs: day.eodTs,
      metrics: {
        balance: round2(balance),
        unrealized: round2(unrealized),
        equity: round2(equity),
        startBalance: this.start,
        totalProfit: round2(totalProfit),
        dayRealized: round2(dayRealized),
        dayPnl: round2(dayPnl),
        dayPeakPnl: round2(s.dayPeakPnl),
        dailyLossLimit: dll,
        dayLossRemaining: dll ? round2(dll - dayLoss) : null,
        mllType: r.max_loss_type,
        mllFloor: round2(floor),
        mllRoom: round2(mllRoom),
        highWater: round2(hwm),
        profitTarget: r.profit_target ?? null,
        effectiveTarget: round2(effectiveTarget),
        targetProgressPct: effectiveTarget ? round2((totalProfit / effectiveTarget) * 100) : null,
        consistencyPct: r.consistency_pct ?? null,
        consistencyMode: mode,
        consistencyCap: round2(consistencyCap),
        consistencyOk,
        bestDay: round2(bestDay),
        maxMiniEquivalent: maxMini,
        exposureMini: exposure,
        remainingMini: round2(maxMini - exposure),
        maxRiskPerTrade: p.max_risk_per_trade ?? null,
        entriesToday: input.entriesToday || 0,
        consecutiveLosses: tail,
        winningDays,
        payoutMinWinningDays: r.payout?.min_winning_days ?? null,
      },
      at: now,
    };

    if (dirty) this.persist();
    else if (minorDirty) this.persistLater();
    this.last = result;

    const signature = `${status}|${reasons.map((x) => x.code).join(',')}|${flattenReasons.join(',')}`;
    if (signature !== this.lastSignature) {
      const previous = this.lastSignature;
      this.lastSignature = signature;
      this.emit('change', result, previous);
    }
    return result;
  }

  /** { date, name, type, closeEt } of today's holiday for status displays, or null. */
  holidayInfo(now) {
    const h = this.holiday(now);
    return h ? { date: h.row.date, name: h.row.name, type: h.row.type, closeEt: h.row.closeEt } : null;
  }

  lockAccount(reason, detail, reasons) {
    if (!this.state.accountLock) {
      this.state.accountLock = { reason, detail, at: this.now() };
      console.warn(`[guard] ACCOUNT LOCKED: ${reason} - ${detail}`);
    }
    if (!reasons.some((x) => x.code === reason)) reasons.push({ level: STATUS.ACCOUNT_LOCKED, code: reason, detail });
  }

  lockDay(key, reason, detail, reasons) {
    if (!this.state.dayLock || this.state.dayLock.key !== key) {
      this.state.dayLock = { key, reason, detail, at: this.now() };
      console.warn(`[guard] DAY LOCKED: ${reason} - ${detail}`);
    }
    if (!reasons.some((x) => x.code === reason)) reasons.push({ level: STATUS.DAY_LOCKED, code: reason, detail });
  }

  /** Manual reset. `scope` is "day" or "account". */
  reset(scope) {
    if (scope === 'account') this.state.accountLock = null;
    if (scope === 'day' || scope === 'account') this.state.dayLock = null;
    this.lastSignature = null;
    this.persist();
  }

  /**
   * Whether an entry of `contracts` on `root` is allowed right now, and the most
   * that would fit under the mini-equivalent cap.
   */
  canEnter({ root, contracts, legs }) {
    const res = this.last;
    if (!res) return { ok: false, reason: 'guard has not evaluated yet', maxContracts: 0 };
    if (!res.canEnter) {
      return { ok: false, reason: `${res.status}: ${res.reasons.map((x) => x.code).join(', ')}`, maxContracts: 0 };
    }
    if (!this.lots.info(root).known) {
      return { ok: false, reason: `unknown contract root ${root}: its mini/micro weight is not in the lot table (add it under topstep.lots.overrides)`, maxContracts: 0 };
    }
    const held = [...new Set(legs.filter((l) => Math.abs(l.contracts) > 0).map((l) => l.root))];
    const conflict = this.lots.overlapConflict(root, held);
    if (conflict) return { ok: false, reason: `mini/micro overlap: ${conflict} is already held in the ${this.lots.info(root).group} group`, maxContracts: 0 };
    const fit = this.lots.contractsThatFit(root, res.metrics.maxMiniEquivalent, legs);
    if (contracts > fit) {
      return { ok: false, reason: `contract limit: ${contracts} ${root} exceeds the ${fit} that fit under ${res.metrics.maxMiniEquivalent} mini-equivalents`, maxContracts: fit };
    }
    return { ok: true, reason: null, maxContracts: fit };
  }
}
