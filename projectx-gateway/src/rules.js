import { parseDays, parseHHMM } from './session.js';

/**
 * Topstep presets per account size.
 *
 * Starting points only: Topstep revises these, and the gateway API exposes none
 * of them, so every value can be overridden in the `topstep` config block.
 * docs/topstep-rules-sources.md lists each value with its source, the date it
 * was checked and whether it could be verified. Verified: DLL, MLL, the 5/10/15
 * mini caps and the 55% consistency target. Only secondary sources agree on the
 * profit targets and the 50K scaling tiers; the 100K and 150K funded tiers are
 * unverified, so check them against your dashboard.
 */
export const PRESETS = Object.freeze({
  50000: {
    evaluation: { profit_target: 3000, daily_loss_limit: 1000, max_loss_limit: 2000, max_mini_equivalent: 5 },
    funded: {
      daily_loss_limit: 1000, max_loss_limit: 2000, max_mini_equivalent: 5,
      scaling_plan: [
        { min_profit: 0, max_mini_equivalent: 2 },
        { min_profit: 1500, max_mini_equivalent: 3 },
        { min_profit: 2000, max_mini_equivalent: 5 },
      ],
    },
  },
  100000: {
    evaluation: { profit_target: 6000, daily_loss_limit: 2000, max_loss_limit: 3000, max_mini_equivalent: 10 },
    funded: {
      daily_loss_limit: 2000, max_loss_limit: 3000, max_mini_equivalent: 10,
      scaling_plan: [
        { min_profit: 0, max_mini_equivalent: 3 },
        { min_profit: 1500, max_mini_equivalent: 4 },
        { min_profit: 2000, max_mini_equivalent: 6 },
        { min_profit: 3000, max_mini_equivalent: 10 },
      ],
    },
  },
  150000: {
    evaluation: { profit_target: 9000, daily_loss_limit: 3000, max_loss_limit: 4500, max_mini_equivalent: 15 },
    funded: {
      daily_loss_limit: 3000, max_loss_limit: 4500, max_mini_equivalent: 15,
      scaling_plan: [
        { min_profit: 0, max_mini_equivalent: 3 },
        { min_profit: 1500, max_mini_equivalent: 4 },
        { min_profit: 2000, max_mini_equivalent: 5 },
        { min_profit: 3000, max_mini_equivalent: 10 },
        { min_profit: 4500, max_mini_equivalent: 15 },
      ],
    },
  },
});

const FUNDED_DEFAULTS = {
  profit_target: null, daily_loss_limit: null, max_loss_limit: null,
  max_loss_type: 'trailing_eod', daily_loss_type: 'intraday', mll_lock_balance: 0,
  consistency_pct: null, max_mini_equivalent: null, stop_on_target: false, scaling_plan: null,
  payout: { min_winning_days: 5, min_winning_day_amount: 150 },
};

const PHASE_DEFAULTS = Object.freeze({
  evaluation: {
    profit_target: null, daily_loss_limit: null, max_loss_limit: null,
    max_loss_type: 'trailing_eod', daily_loss_type: 'intraday', mll_lock_balance: null,
    consistency_pct: 55, max_mini_equivalent: null, stop_on_target: true, scaling_plan: null, payout: null,
  },
  funded: FUNDED_DEFAULTS,
  live_funded: { ...FUNDED_DEFAULTS },
});

export const SESSION_DEFAULTS = Object.freeze({
  reset_time: '18:00', eod_time: '16:10', no_entry_before: '18:05', no_entry_after: '15:45',
  flat_by: '16:05', hold_mode: 'intraday', trading_windows: [], trade_weekends: false, news_blackout: [],
});

export const PROTECTION_DEFAULTS = Object.freeze({
  dll_soft_pct: 70, dll_hard_pct: 90, mll_buffer: 300, max_risk_per_trade: 250,
  max_trades_per_day: 10, max_consecutive_losses: 3,
  daily_profit_lock: { enabled: true, activate_at: 800, giveback_pct: 40 },
});

const KIND_PHASE = Object.freeze({ TC: 'evaluation', XFA: 'funded', PA: 'funded', LFA: 'live_funded' });
/** An Express Funded Account builds its balance from $0; the others start at size. */
const STARTS_AT_ZERO = new Set(['XFA']);

const isAuto = (v) => v === undefined || v === null || v === 'auto';
const defined = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== null && v !== undefined));

function sizeFromPreset(preset) {
  const match = /^(\d+)k$/i.exec(String(preset || '').trim());
  return match ? Number(match[1]) * 1000 : null;
}

export class RulesError extends Error {
  constructor(problems) {
    super(`Invalid topstep config:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

/**
 * Resolves the effective rule set: phase defaults <- preset for the size <- the
 * user's `topstep.phases[phase]` values (null means "use the preset").
 */
export function resolveRules(topstep = {}, account = null) {
  const problems = [];
  const warnings = [];

  let phase = topstep.phase;
  if (isAuto(phase)) {
    phase = KIND_PHASE[account?.kind] || null;
    if (!phase) problems.push(`topstep.phase is "auto" but the account name (${account?.name ?? 'none'}) has no recognised product code; set phase to evaluation, funded or live_funded`);
  }
  if (phase && !PHASE_DEFAULTS[phase]) problems.push(`topstep.phase must be evaluation, funded or live_funded, got "${phase}"`);

  let size = isAuto(topstep.preset) ? account?.sizeUsd ?? null : sizeFromPreset(topstep.preset);
  if (!isAuto(topstep.preset) && !size) problems.push(`topstep.preset must be "auto", "50k", "100k" or "150k", got "${topstep.preset}"`);
  if (size && !PRESETS[size]) {
    warnings.push(`no preset for a ${size / 1000}K account; every limit must be set explicitly`);
  }

  let startBalance = topstep.start_balance;
  if (isAuto(startBalance)) {
    if (account?.kind && STARTS_AT_ZERO.has(account.kind)) startBalance = 0;
    else startBalance = size;
  }
  startBalance = Number(startBalance);
  if (!Number.isFinite(startBalance)) problems.push('topstep.start_balance is "auto" but the account size is unknown; set it explicitly');

  const presetKey = phase === 'live_funded' ? 'funded' : phase;
  const preset = (size && PRESETS[size]?.[presetKey]) || {};
  const userPhase = topstep.phases?.[phase] || {};
  const rules = { ...(PHASE_DEFAULTS[phase] || {}), ...preset, ...defined(userPhase) };
  delete rules.session;

  const session = { ...SESSION_DEFAULTS, ...defined(topstep.session), ...defined(userPhase.session) };
  const protection = {
    ...PROTECTION_DEFAULTS,
    ...defined(topstep.protection),
    daily_profit_lock: { ...PROTECTION_DEFAULTS.daily_profit_lock, ...defined(topstep.protection?.daily_profit_lock) },
  };
  const lots = { micro_ratio: 10, block_mini_micro_overlap: true, overrides: {}, ...defined(topstep.lots) };
  const timezone = topstep.timezone || 'America/New_York';

  validate({ rules, session, protection, lots, timezone, problems });
  if (problems.length) throw new RulesError(problems);

  if (Array.isArray(rules.scaling_plan)) rules.scaling_plan = [...rules.scaling_plan].sort((a, b) => a.min_profit - b.min_profit);

  return {
    phase,
    size,
    startBalance,
    timezone,
    account: account ? { id: account.id, name: account.name, kind: account.kind, sizeUsd: account.sizeUsd } : null,
    rules,
    session,
    protection,
    lots,
    warnings,
  };
}

function validate({ rules, session, protection, lots, timezone, problems }) {
  const positive = (v, name, { nullable = false } = {}) => {
    if (v === null || v === undefined) {
      if (!nullable) problems.push(`${name} is required (no preset value for this account)`);
      return;
    }
    if (!(Number(v) > 0)) problems.push(`${name} must be a positive number, got ${v}`);
  };
  const pct = (v, name, { nullable = false } = {}) => {
    if ((v === null || v === undefined) && nullable) return;
    if (!(Number(v) > 0 && Number(v) <= 100)) problems.push(`${name} must be in (0, 100], got ${v}`);
  };

  // `false` or 0 turns the Daily Loss Limit off (some Topstep products have none).
  if (rules.daily_loss_limit !== false && rules.daily_loss_limit !== 0) positive(rules.daily_loss_limit, 'daily_loss_limit');
  positive(rules.max_loss_limit, 'max_loss_limit');
  positive(rules.profit_target, 'profit_target', { nullable: true });
  // 0 or false turns the consistency rule (and its daily profit cap) off.
  if (rules.consistency_pct !== 0 && rules.consistency_pct !== false) pct(rules.consistency_pct, 'consistency_pct', { nullable: true });
  if (!['trailing_eod', 'trailing_intraday', 'static'].includes(rules.max_loss_type)) {
    problems.push(`max_loss_type must be trailing_eod, trailing_intraday or static, got "${rules.max_loss_type}"`);
  }
  if (!['intraday', 'eod'].includes(rules.daily_loss_type)) {
    problems.push(`daily_loss_type must be intraday or eod, got "${rules.daily_loss_type}"`);
  }
  if (rules.mll_lock_balance !== null && rules.mll_lock_balance !== undefined && !Number.isFinite(Number(rules.mll_lock_balance))) {
    problems.push(`mll_lock_balance must be a number or null, got ${rules.mll_lock_balance}`);
  }
  if (rules.consistency_pct && !rules.profit_target) {
    problems.push('consistency_pct needs a profit_target to size the daily cap');
  }
  if (Array.isArray(rules.scaling_plan)) {
    for (const [i, tier] of rules.scaling_plan.entries()) {
      if (!Number.isFinite(Number(tier?.min_profit))) problems.push(`scaling_plan[${i}].min_profit must be a number`);
      positive(tier?.max_mini_equivalent, `scaling_plan[${i}].max_mini_equivalent`);
    }
  } else {
    positive(rules.max_mini_equivalent, 'max_mini_equivalent');
  }
  if (rules.payout) {
    positive(rules.payout.min_winning_days, 'payout.min_winning_days');
    positive(rules.payout.min_winning_day_amount, 'payout.min_winning_day_amount');
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    problems.push(`timezone "${timezone}" is not a valid IANA timezone`);
  }
  for (const key of ['reset_time', 'eod_time', 'no_entry_before', 'no_entry_after', 'flat_by']) {
    try {
      parseHHMM(session[key], `session.${key}`);
    } catch (err) {
      problems.push(err.message);
    }
  }
  if (!['intraday', 'overnight'].includes(session.hold_mode)) {
    problems.push(`session.hold_mode must be intraday or overnight, got "${session.hold_mode}"`);
  }
  for (const [i, w] of (session.trading_windows || []).entries()) {
    try {
      parseHHMM(w.start, `trading_windows[${i}].start`);
      parseHHMM(w.end, `trading_windows[${i}].end`);
    } catch (err) {
      problems.push(err.message);
    }
  }
  for (const [i, w] of (session.news_blackout || []).entries()) {
    try {
      parseDays(w.days);
      parseHHMM(w.start, `news_blackout[${i}].start`);
      parseHHMM(w.end, `news_blackout[${i}].end`);
    } catch (err) {
      problems.push(`news_blackout[${i}]: ${err.message}`);
    }
  }

  pct(protection.dll_soft_pct, 'protection.dll_soft_pct');
  pct(protection.dll_hard_pct, 'protection.dll_hard_pct');
  if (Number(protection.dll_soft_pct) > Number(protection.dll_hard_pct)) problems.push('protection.dll_soft_pct must be <= dll_hard_pct');
  if (!(Number(protection.mll_buffer) >= 0)) problems.push('protection.mll_buffer must be >= 0');
  // 0 or false turns these protections off.
  for (const key of ['max_risk_per_trade', 'max_trades_per_day', 'max_consecutive_losses']) {
    if (protection[key] !== 0 && protection[key] !== false) positive(protection[key], `protection.${key}`, { nullable: true });
  }
  const lock = protection.daily_profit_lock;
  if (lock?.enabled) {
    positive(lock.activate_at, 'protection.daily_profit_lock.activate_at');
    pct(lock.giveback_pct, 'protection.daily_profit_lock.giveback_pct');
  }
  if (!(Number(lots.micro_ratio) > 0)) problems.push('lots.micro_ratio must be > 0');
}

/** Contract cap now: the phase cap, or the scaling tier for profit so far. */
export function maxMiniEquivalent(rules, profit) {
  if (Array.isArray(rules.scaling_plan) && rules.scaling_plan.length) {
    let cap = rules.scaling_plan[0].max_mini_equivalent;
    for (const tier of rules.scaling_plan) if (profit >= tier.min_profit) cap = tier.max_mini_equivalent;
    if (rules.max_mini_equivalent) cap = Math.min(cap, rules.max_mini_equivalent);
    return cap;
  }
  return rules.max_mini_equivalent;
}
