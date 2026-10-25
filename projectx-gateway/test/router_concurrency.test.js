import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GatewayError } from '../src/errors.js';
import { AccountGuard } from '../src/guard.js';
import { LotTable } from '../src/lots.js';
import { ORDER_SIDE, ORDER_STATUS, ORDER_TYPE } from '../src/projectx.js';
import { Mutex } from '../src/router.js';
import { resolveRules } from '../src/rules.js';
import {
  contractIdOf, makeRouter, orderRow, position, sleep, stubGuard,
} from './helpers.js';

/** A real guard on a 50K Combine (5 mini-equivalents), time-independent. */
function realGuard() {
  const resolved = resolveRules({
    phase: 'evaluation',
    preset: '50k',
    session: { trade_weekends: true, hold_mode: 'overnight', no_entry_before: '00:00', no_entry_after: '00:00' },
  }, null);
  const guard = new AccountGuard({ resolved, lots: new LotTable(), statePath: null });
  guard.evaluate({ balance: 50000, unrealized: 0, dayRealized: 0, closedResults: [], entriesToday: 0, legs: [] });
  return guard;
}

/** The exchange accepts the order after `delay` ms but the hub shows nothing yet, like a lagging user hub. */
function slowAccept(ctx, delay = 30) {
  const original = ctx.client.placeOrder.bind(ctx.client);
  ctx.client.placeOrder = async (body) => {
    await sleep(delay);
    return original(body);
  };
}

const entry = (ctx, symbol, amount) => ctx.router.place({ symbol, type: 'market', side: 'buy', amount });

test('Mutex runs holders strictly one after another and survives a holder that throws', async () => {
  const mutex = new Mutex();
  const log = [];
  const hold = async (name, ms, fail = false) => {
    const release = await mutex.acquire();
    try {
      log.push(`${name}:in`);
      await sleep(ms);
      if (fail) throw new Error('boom');
      log.push(`${name}:out`);
    } finally {
      release();
    }
  };
  await Promise.allSettled([hold('a', 20), hold('b', 5, true), hold('c', 1)]);
  assert.deepEqual(log, ['a:in', 'a:out', 'b:in', 'c:in', 'c:out']);
});

test('two parallel entries cannot exceed the mini-equivalent cap', async () => {
  const guard = realGuard();
  const ctx = makeRouter({ guard: () => guard, config: { fill_wait_ms: 200 } });
  slowAccept(ctx);
  // The fill wait keeps place() (and so the reservation) alive while the hub has not reported the order yet.
  ctx.user.waitForFinal = async () => { await sleep(100); return null; };

  const results = await Promise.allSettled([entry(ctx, 'ES/USD:USD', 3), entry(ctx, 'ES/USD:USD', 3)]);

  const ok = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'one entry fits the 5-mini cap');
  assert.equal(refused.length, 1);
  assert.ok(refused[0].reason instanceof GatewayError);
  assert.equal(refused[0].reason.kind, 'InvalidOrder');
  assert.match(refused[0].reason.message, /contract limit: 3 ES exceeds the 2 that fit/);
  assert.equal(ctx.client.callsOf('placeOrder').length, 1);
});

test('an in-flight entry is a leg for the cap check but not for the guard input', async () => {
  const guard = realGuard();
  const ctx = makeRouter({ guard: () => guard });
  slowAccept(ctx, 60);
  ctx.user.waitForFinal = async () => null;
  const first = entry(ctx, 'ES/USD:USD', 3);
  await sleep(15);
  assert.deepEqual(ctx.router.legs(), [{ root: 'ES', contracts: 3 }], 'the in-flight entry is a leg');
  assert.deepEqual(ctx.router.legs({ reserved: false }), [], 'the guard input leaves reservations out');
  await first;
});

test('entries are serialized: the second cap check runs after the first submit', async () => {
  const log = [];
  const guard = stubGuard();
  const check = guard.canEnter.bind(guard);
  guard.canEnter = (input) => { log.push('check'); return check(input); };
  const ctx = makeRouter({ guard: () => guard });
  ctx.user.waitForFinal = async () => null;
  ctx.client.onPlace = () => log.push('submit');
  slowAccept(ctx, 20);

  await Promise.all([entry(ctx, 'MES/USD:USD', 1), entry(ctx, 'MES/USD:USD', 1), entry(ctx, 'MES/USD:USD', 1)]);

  assert.deepEqual(log, ['check', 'submit', 'check', 'submit', 'check', 'submit']);
});

test('the reservation is released when the submit fails', async () => {
  const guard = realGuard();
  const ctx = makeRouter({ guard: () => guard });
  ctx.user.waitForFinal = async () => null;
  ctx.client.fail.placeOrder = new GatewayError('rejected', { status: 400, kind: 'InvalidOrder' });
  await assert.rejects(entry(ctx, 'ES/USD:USD', 5), /rejected/);
  assert.equal(ctx.router.reservations.size, 0);
  assert.deepEqual(ctx.router.legs(), []);

  ctx.client.fail.placeOrder = null;
  await entry(ctx, 'ES/USD:USD', 5);
  assert.equal(ctx.client.callsOf('placeOrder').length, 2, 'the failed 5-lot did not block the next one');
});

test('the reservation is released when the cap check refuses, and when the entry succeeds', async () => {
  const guard = stubGuard({ ok: false, reason: 'nope' });
  const ctx = makeRouter({ guard: () => guard });
  await assert.rejects(entry(ctx, 'MES/USD:USD', 1), /Refused by account protection: nope/);
  assert.equal(ctx.router.reservations.size, 0);

  guard.verdict = { ok: true, reason: null };
  ctx.user.waitForFinal = async () => null;
  await entry(ctx, 'MES/USD:USD', 1);
  assert.equal(ctx.router.reservations.size, 0);
});

test('the reservation covers the fill wait and counts once the order is working', async () => {
  const guard = realGuard();
  const ctx = makeRouter({ guard: () => guard, config: { fill_wait_ms: 200 } });
  let seen;
  ctx.client.onPlace = (body, id) => {
    // The order shows up on the hub as working, but has not filled yet.
    setImmediate(() => ctx.user.onOrder(orderRow('ES', { id, size: body.size, customTag: body.customTag, type: ORDER_TYPE.MARKET })));
  };
  ctx.user.waitForFinal = async () => {
    await sleep(40);
    seen = { legs: ctx.router.legs(), reservations: ctx.router.reservations.size };
    return null;
  };
  await entry(ctx, 'ES/USD:USD', 2);
  assert.equal(seen.reservations, 1, 'still reserved while waiting for the fill');
  assert.deepEqual(seen.legs, [{ root: 'ES', contracts: 2 }], 'counted once, as the working order, not twice');
  assert.equal(ctx.router.reservations.size, 0);
});

test('a reservation whose order already filled but whose position has not arrived is still counted', async () => {
  const ctx = makeRouter({ guard: () => stubGuard() });
  ctx.router.reservations.set('ft-en-x', { root: 'ES', contracts: 2, orderId: 900 });
  ctx.user.onOrder(orderRow('ES', { id: 900, status: ORDER_STATUS.FILLED, customTag: 'ft-en-x' }));
  assert.deepEqual(ctx.router.legs(), [{ root: 'ES', contracts: 2 }]);
});

test('exits are never serialized behind an entry', async () => {
  const ctx = makeRouter({ guard: () => stubGuard() });
  ctx.user.waitForFinal = async () => null;
  ctx.user.onPosition(position('MES', { side: 'long', size: 1 }));
  let unblock;
  const gate = new Promise((r) => { unblock = r; });
  const original = ctx.client.placeOrder.bind(ctx.client);
  ctx.client.placeOrder = async (body) => {
    if (body.customTag.startsWith('ft-en-')) await gate;
    return original(body);
  };

  const slowEntry = entry(ctx, 'MES/USD:USD', 1);
  await sleep(10);
  const exit = await ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'sell', amount: 1, params: { reduceOnly: true } });
  assert.equal(exit.reduceOnly, true, 'the exit went through while the entry was stuck');
  assert.equal(ctx.client.callsOf('placeOrder').length, 1);
  unblock();
  await slowEntry;
  assert.equal(ctx.client.callsOf('placeOrder').length, 2);
});

test('an entry offset by the other side is refused inside the lock and releases it', async () => {
  const ctx = makeRouter({ guard: () => stubGuard() });
  ctx.user.waitForFinal = async () => null;
  ctx.user.onPosition(position('MES', { side: 'short', size: 1 }));
  await assert.rejects(entry(ctx, 'MES/USD:USD', 1), /would offset/);
  ctx.user.onPosition(position('MES', { side: 'short', size: 0 }));
  await entry(ctx, 'MES/USD:USD', 1);
  assert.equal(ctx.client.callsOf('placeOrder').length, 1);
  assert.equal(ctx.client.callsOf('placeOrder')[0].contractId, contractIdOf('MES'));
  assert.equal(ctx.client.callsOf('placeOrder')[0].side, ORDER_SIDE.BUY);
});
