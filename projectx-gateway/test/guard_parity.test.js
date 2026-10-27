import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AccountGuard } from '../src/guard.js';
import { LotTable } from '../src/lots.js';
import { accountProduct } from '../src/projectx.js';
import { resolveRules } from '../src/rules.js';

/**
 * Runs tests/fixtures/guard_parity.json against AccountGuard, the reference for
 * projectx/backtest_guard.py. tests/test_guard_parity.py runs the same file, so
 * a rule changed on one side without the other fails there.
 */
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/guard_parity.json', import.meta.url), 'utf8'));

function close(actual, expected, label) {
  if (expected === null || expected === undefined) {
    assert.equal(actual ?? null, null, label);
  } else if (typeof expected === 'number') {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 0.01, `${label}: expected ${expected}, got ${actual}`);
  } else {
    assert.deepEqual(actual, expected, label);
  }
}

for (const scenario of fixture.scenarios) {
  test(`parity: ${scenario.name}`, () => {
    const topstep = { ...fixture.defaults.topstep, ...scenario.topstep };
    const account = scenario.account_name ? { id: 1, name: scenario.account_name, ...accountProduct(scenario.account_name) } : null;
    const resolved = resolveRules(topstep, account);
    const guard = new AccountGuard({ resolved, lots: new LotTable(resolved.lots), statePath: null });

    const closed = [];
    for (const [i, step] of scenario.steps.entries()) {
      for (const c of step.closed) closed.push({ at: Date.parse(c.at), net: c.net });
      const now = Date.parse(step.now);
      const sinceStart = closed.filter((c) => c.at >= guard.clock.sessionStart(now)).sort((a, b) => a.at - b.at);
      const res = guard.evaluate({
        now,
        balance: resolved.startBalance + closed.reduce((sum, c) => sum + c.net, 0),
        unrealized: step.unrealized,
        dayRealized: sinceStart.reduce((sum, c) => sum + c.net, 0),
        closedResults: sinceStart.map((c) => c.net),
        entriesToday: step.entries_today,
        legs: [],
      });

      const where = `step ${i + 1} (${step.now})`;
      const want = step.expect;
      assert.equal(res.status, want.status, `${where} status`);
      assert.deepEqual(res.reasons.map((r) => r.code), want.codes, `${where} reason codes`);
      assert.equal(res.flatten, want.flatten, `${where} flatten`);
      assert.deepEqual(res.flattenReasons, want.flattenReasons, `${where} flatten reasons`);
      for (const [key, value] of Object.entries(want.metrics || {})) close(res.metrics[key], value, `${where} metrics.${key}`);
    }
  });
}

test('the fixture covers every rule the Python guard must keep', () => {
  const names = fixture.scenarios.map((s) => s.name.toLowerCase()).join('\n');
  for (const topic of [
    'dll soft', 'daily_loss_type eod', 'trailing_eod', 'trailing_intraday', 'static', 'funded', 'giveback', 'cap_day',
    'raise_target', 'consistency off', 'counters', 'weekend', 'flat_by', 'news blackout', 'closed day', 'early close',
    'resolved from a 100k', 'express funded account name', 'dst fall back', 'dst spring forward',
  ]) assert.ok(names.includes(topic), `no scenario for "${topic}"`);
  const codes = new Set(fixture.scenarios.flatMap((s) => s.steps.flatMap((st) => st.expect.codes)));
  for (const code of [
    'dll_soft', 'dll_hard', 'mll_buffer', 'target_passed', 'profit_giveback', 'consistency_cap', 'max_trades_per_day',
    'max_consecutive_losses', 'weekend', 'no_entry_window', 'news_blackout', 'outside_trading_windows', 'holiday',
  ]) assert.ok(codes.has(code), `no step expects ${code}`);
});
