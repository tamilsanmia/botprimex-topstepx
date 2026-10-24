import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OrderRouter } from '../src/router.js';
import { computeFeatures, valueArea } from '../src/orderflow.js';
import { SessionClock } from '../src/session.js';

function fakes() {
  const closed = [];
  const cancelled = [];
  const user = {
    accountId: 7,
    account: { id: 7, balance: 0, kind: 'XFA', sizeUsd: 50000 },
    positions: new Map([['CON.F.US.MES.Z26', { contractId: 'CON.F.US.MES.Z26', type: 1, size: 3, averagePrice: 6000 }]]),
    trades: new Map(),
    orders: new Map(),
    openOrders: () => [{ id: 11, contractId: 'CON.F.US.MES.Z26', customTag: 'ft-sl-x', status: 1 }],
    tradesForOrder: () => [],
    onPosition() {},
  };
  const client = {
    closeContract: async (accountId, contractId) => closed.push(contractId),
    cancelOrder: async (accountId, id) => cancelled.push(id),
    searchOpenPositions: async () => [],
  };
  const contracts = {
    rootForContract: (id) => id.split('.')[3],
    contractInfo: () => ({ tickSize: 0.25, tickValue: 1.25 }),
    front: () => ({ contractId: 'CON.F.US.MES.Z26', tickSize: 0.25, tickValue: 1.25 }),
  };
  const router = new OrderRouter({
    client, contracts, user, market: { quoteFor: () => ({ last: 6010 }) }, lots: null, guard: null,
    config: { flatten_grace_secs: 30, fill_wait_ms: 0, max_order_size: 50, balance_offset: 'auto' },
  });
  return { router, user, closed, cancelled };
}

test('flatten fallback waits out the grace period, then closes and cancels', async () => {
  const { router, closed, cancelled } = fakes();
  const verdict = { flatten: true, flattenReasons: ['day_locked'] };
  await router.enforceFlatten(verdict, 1_000_000);
  assert.deepEqual(closed, []);
  await router.enforceFlatten(verdict, 1_000_000 + 29_000);
  assert.deepEqual(closed, []);
  await router.enforceFlatten(verdict, 1_000_000 + 31_000);
  assert.deepEqual(closed, ['CON.F.US.MES.Z26']);
  assert.deepEqual(cancelled, [11]);
  assert.ok(router.pendingFlattens.has('MES'));
});

test('Freqtrade exit after a gateway flatten gets the real fill back', async () => {
  const { router, user } = fakes();
  router.pendingFlattens.set('MES', { at: 0, contractId: 'CON.F.US.MES.Z26', side: 1, size: 3 });
  user.positions.clear();
  user.trades.set(1, { id: 1, orderId: 99, contractId: 'CON.F.US.MES.Z26', side: 1, size: 3, price: 6005, fees: 1, commissions: 0.5, creationTimestamp: new Date().toISOString() });
  const order = await router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'sell', amount: 3, params: { reduceOnly: true } });
  assert.equal(order.status, 'closed');
  assert.equal(order.average, 6005);
  assert.equal(order.filled, 3);
  assert.equal(router.pendingFlattens.has('MES'), false);
});

test('unrealized P&L uses the point value and direction', () => {
  const { router } = fakes();
  assert.equal(router.unrealized(), (6010 - 6000) * 3 * 5);
});

test('Express Funded balance gets the account size as a sizing offset', () => {
  const { router } = fakes();
  assert.equal(router.balance('USD').USD.total, 50000);
});

test('value area grows from the POC to 70% of volume', () => {
  const va = valueArea(new Map([[1, 5], [2, 10], [3, 50], [4, 20], [5, 15]]), 70);
  // 50 at the POC, then the larger neighbour (20 at 4) reaches 70 of 100.
  assert.deepEqual(va, { poc: 3, vah: 4, val: 3 });
  assert.deepEqual(valueArea(new Map([[1, 30], [2, 10], [3, 40], [4, 20]]), 70), { poc: 3, vah: 4, val: 2 });
});

test('order flow features: delta, session CVD reset and block prints', () => {
  const clock = new SessionClock({ timezone: 'America/New_York', reset_time: '18:00', eod_time: '16:10' });
  const start = clock.sessionStart(Date.UTC(2026, 9, 20, 15));
  const ticks = [];
  for (let i = 0; i < 300; i += 1) ticks.push([start + 1000 + i * 100, 100, 1, i % 2]);
  ticks.push([start + 61_000, 101, 60, 0]);
  ticks.push([start + 24 * 3600 * 1000 + 1000, 99, 5, 1]);
  const rows = computeFeatures({ ticks, tfMs: 60_000, since: start, clock, blockMultiple: 25 });
  assert.equal(rows[0].delta, 0);
  assert.equal(rows[1].block_count, 1);
  assert.equal(rows[1].block_delta, 60);
  assert.equal(rows[1].cvd_session, 60);
  assert.equal(rows.at(-1).cvd_session, -5, 'CVD resets at the next session');
});
