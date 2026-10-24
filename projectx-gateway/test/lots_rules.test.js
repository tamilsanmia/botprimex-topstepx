import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseLenientJson } from '../src/config.js';
import { estimateExpiry } from '../src/contracts.js';
import { LotTable } from '../src/lots.js';
import { accountProduct, contractMonth, contractRoot } from '../src/projectx.js';
import { RulesError, maxMiniEquivalent, resolveRules } from '../src/rules.js';

test('mini-equivalents: 3 ES + 20 MES = 5.0 and one more MES does not fit a 5-mini cap', () => {
  const lots = new LotTable();
  const legs = [{ root: 'ES', contracts: 3 }, { root: 'MES', contracts: 20 }];
  assert.equal(lots.exposure(legs), 5);
  assert.equal(lots.contractsThatFit('MES', 5, legs), 0);
  assert.equal(lots.contractsThatFit('MNQ', 5, [{ root: 'ES', contracts: 3 }]), 20);
  assert.equal(lots.contractsThatFit('NQ', 5, [{ root: 'ES', contracts: 3 }]), 2);
});

test('mini/micro overlap is blocked per underlying group, and can be turned off', () => {
  const lots = new LotTable();
  assert.equal(lots.overlapConflict('ES', ['MES']), 'MES');
  assert.equal(lots.overlapConflict('MNQ', ['MES', 'MGC']), null);
  assert.equal(new LotTable({ block_mini_micro_overlap: false }).overlapConflict('ES', ['MES']), null);
  assert.equal(new LotTable({ overrides: { MBT: { weight: 0.5 } } }).info('MBT').weight, 0.5);
  assert.equal(lots.info('SIL').class, 'micro');
  assert.equal(lots.overlapConflict('SI', ['SIL']), 'SIL');
  assert.equal(lots.overlapConflict('QM', ['MCL']), 'MCL');
  assert.equal(lots.info('M6E').group, lots.info('6E').group);
});

test('contract names, roots, months and expiry estimates', () => {
  assert.equal(contractRoot({ name: 'MNQU6' }), 'MNQ');
  assert.equal(contractRoot({ name: '6BU5' }), '6B');
  assert.deepEqual(contractMonth('MESZ5', new Date('2025-10-01')), { month: 12, year: 2025 });
  assert.deepEqual(contractMonth('MESH6', new Date('2025-12-20')), { month: 3, year: 2026 });
  // Third Friday of December 2025 is the 19th.
  assert.equal(new Date(estimateExpiry('MES', 'MESZ5', new Date('2025-10-01'))).toISOString().slice(0, 10), '2025-12-19');
  assert.equal(new Date(estimateExpiry('CL', 'CLZ5', new Date('2025-10-01'))).toISOString().slice(0, 10), '2025-11-20');
});

test('account product auto-detection', () => {
  assert.deepEqual(accountProduct('50KTC-V2-658045-28155706'), { sizeUsd: 50000, kind: 'TC' });
  assert.deepEqual(accountProduct('150KXFA-1'), { sizeUsd: 150000, kind: 'XFA' });
  assert.deepEqual(accountProduct('PRACTICE'), { sizeUsd: null, kind: null });
  assert.deepEqual(accountProduct('6KCHCR-LABS005-V2-684000-69917404'), { sizeUsd: null, kind: null });
  assert.deepEqual(accountProduct('50KTCX-1'), { sizeUsd: null, kind: null });
});

test('rules: auto phase and preset from a 50K combine', () => {
  const r = resolveRules({}, { name: '50KTC-V2-1', kind: 'TC', sizeUsd: 50000 });
  assert.equal(r.phase, 'evaluation');
  assert.equal(r.startBalance, 50000);
  assert.equal(r.rules.profit_target, 3000);
  assert.equal(r.rules.daily_loss_limit, 1000);
  assert.equal(r.rules.max_loss_limit, 2000);
  assert.equal(r.rules.max_mini_equivalent, 5);
  assert.equal(r.session.reset_time, '18:00');
});

test('rules: Express Funded starts at $0 and uses the scaling plan', () => {
  const r = resolveRules({}, { name: '100KXFA-9', kind: 'XFA', sizeUsd: 100000 });
  assert.equal(r.phase, 'funded');
  assert.equal(r.startBalance, 0);
  assert.equal(r.rules.mll_lock_balance, 0);
  assert.equal(maxMiniEquivalent(r.rules, 0), 3);
  assert.equal(maxMiniEquivalent(r.rules, 2500), 6);
  assert.equal(maxMiniEquivalent(r.rules, 99999), 10);
});

test('rules: user values override presets, null keeps the preset, sessions merge per phase', () => {
  const r = resolveRules({
    phase: 'evaluation', preset: '150k',
    session: { flat_by: '15:55' },
    phases: { evaluation: { daily_loss_limit: 2500, profit_target: null, session: { no_entry_after: '15:30' } } },
  }, null);
  assert.equal(r.rules.daily_loss_limit, 2500);
  assert.equal(r.rules.profit_target, 9000);
  assert.equal(r.session.flat_by, '15:55');
  assert.equal(r.session.no_entry_after, '15:30');
});

test('rules: invalid config fails fast with every problem listed', () => {
  assert.throws(() => resolveRules({
    phase: 'evaluation', preset: '50k', timezone: 'Mars/Olympus',
    session: { flat_by: '25:00', hold_mode: 'sometimes' },
    phases: { evaluation: { max_loss_type: 'weekly' } },
    protection: { dll_soft_pct: 95, dll_hard_pct: 90 },
  }, null), (err) => {
    assert.ok(err instanceof RulesError);
    assert.ok(err.problems.length >= 4, err.message);
    return true;
  });
  assert.throws(() => resolveRules({ phase: 'auto' }, { name: 'X', kind: null, sizeUsd: null }), RulesError);
});

test('config parser accepts comments and trailing commas like Freqtrade', () => {
  const cfg = parseLenientJson('{\n // c\n "a": "http://x//y", /* b */ "b": [1, 2,],\n}');
  assert.deepEqual(cfg, { a: 'http://x//y', b: [1, 2] });
});
