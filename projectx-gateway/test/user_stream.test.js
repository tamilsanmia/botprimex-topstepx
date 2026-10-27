import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PRIORITY } from '../src/limiter.js';
import { createMockUpstream } from '../src/mock.js';
import { ORDER_SIDE, ORDER_STATUS, ORDER_TYPE } from '../src/projectx.js';
import { UserStream } from '../src/userStream.js';
import {
  contractIdOf, fakeClient, fakeUser, orderRow, position, sleep, tradeRow, waitFor,
} from './helpers.js';

const protective = (root, over = {}) => orderRow(root, {
  id: 10,
  type: ORDER_TYPE.STOP,
  side: ORDER_SIDE.SELL,
  limitPrice: null,
  stopPrice: 5990,
  customTag: 'ft-sl-abc',
  ...over,
});

function setup(opts) {
  const client = fakeClient();
  const user = fakeUser(client, opts);
  return { client, user };
}

const quiet = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

/* ------------------------------------------------------------- reconcile -- */

test('reconcile replaces positions with the REST view and drops flat ones', async () => {
  const { client, user } = setup();
  user.onPosition(position('MES', { size: 3 }));
  client.positionRows = [position('ES', { size: 2, id: 2 }), position('MNQ', { size: 0, id: 3 })];

  let reconciled = 0;
  user.on('reconciled', () => { reconciled += 1; });
  await user.reconcile();

  assert.deepEqual([...user.positions.keys()], [contractIdOf('ES')]);
  assert.equal(reconciled, 1);
  assert.ok(user.lastReconcileAt > 0);
  const [positionsCall] = client.callsOf('searchOpenPositions');
  assert.equal(positionsCall.accountId, 7);
  assert.equal(positionsCall.priority, PRIORITY.BACKGROUND, 'reconcile reads yield to orders');
  assert.equal(client.callsOf('searchOpenOrders')[0].priority, PRIORITY.BACKGROUND);
});

test('reconcile merges open orders over the cached ones and keeps their extra fields', async () => {
  const { client, user } = setup();
  user.onOrder(orderRow('MES', { id: 1, customTag: 'ft-en-keep', limitPrice: 6000 }));
  client.orderRows = [
    { id: 1, accountId: 7, status: ORDER_STATUS.OPEN, limitPrice: 6001, contractId: contractIdOf('MES') },
    orderRow('ES', { id: 2 }),
  ];
  await user.reconcile();

  assert.equal(user.orders.get(1).limitPrice, 6001, 'REST values win');
  assert.equal(user.orders.get(1).customTag, 'ft-en-keep', 'fields REST omits are kept');
  assert.ok(user.orders.has(2), 'orders only REST knows are added');
  assert.equal(client.callsOf('searchOrders').length, 0, 'nothing vanished, no history lookup');
});

test('reconcile looks up orders that vanished from the open list', async () => {
  const { client, user } = setup();
  const created = new Date(Date.now() - 10 * 60_000).toISOString();
  user.onOrder(orderRow('MES', { id: 5, creationTimestamp: created }));
  user.onOrder(orderRow('MES', { id: 6, status: ORDER_STATUS.FILLED }));
  client.orderRows = [orderRow('MES', { id: 5, creationTimestamp: created, status: ORDER_STATUS.FILLED, fillVolume: 1, filledPrice: 6000 })];
  // searchOpenOrders returns open rows only, and the order is now filled, so it is absent there.

  const finals = [];
  user.on('order', (o) => { if (o.id === 5) finals.push(o.status); });
  await user.reconcile();

  assert.equal(user.orders.get(5).status, ORDER_STATUS.FILLED);
  assert.deepEqual(finals, [ORDER_STATUS.FILLED]);
  const [search] = client.callsOf('searchOrders');
  assert.equal(search.priority, PRIORITY.BACKGROUND);
  assert.equal(search.start, Date.parse(created) - 60_000, 'looks back a minute before the oldest vanished order');
  assert.equal(user.openOrders().length, 0);
});

test('reconcile applies the account balance from the account search', async () => {
  const { client, user } = setup();
  client.searchAccounts = async () => [{ id: 99, balance: 1 }, { id: 7, name: 'X', balance: 51234.5 }];
  const seen = [];
  user.on('account', (a) => seen.push(a.balance));
  await user.reconcile();
  assert.equal(user.account.balance, 51234.5);
  assert.deepEqual(seen, [51234.5]);
});

test('reconcile survives a failing account search but not failing position or order reads', async () => {
  const { client, user } = setup();
  client.searchAccounts = async () => { throw new Error('accounts down'); };
  await user.reconcile();
  assert.ok(user.lastReconcileAt > 0);

  const before = user.lastReconcileAt;
  client.fail.searchOpenPositions = new Error('positions down');
  await assert.rejects(user.reconcile(), /positions down/);
  assert.equal(user.lastReconcileAt, before, 'a failed reconcile does not look fresh');
});

test('reconcile without a selected account does nothing', async () => {
  const { client, user } = setup();
  user.account = null;
  await user.reconcile();
  assert.equal(client.calls.length, 0);
});

/* -------------------------------------------------------- event handlers -- */

test('events from another account are ignored', () => {
  const { user } = setup();
  user.onOrder(orderRow('MES', { id: 1, accountId: 8 }));
  user.onPosition({ ...position('MES'), accountId: 8 });
  user.onTrade(tradeRow('MES', { accountId: 8 }));
  user.onAccount({ id: 8, balance: 1 });
  assert.equal(user.orders.size + user.positions.size + user.trades.size, 0);
  assert.equal(user.account.balance, 50000);
  user.onOrder(null);
  user.onOrder({});
  user.onPosition({});
  user.onTrade({});
});

test('order updates are merged, positions of size 0 are removed, trades are stored', () => {
  const { user } = setup();
  const events = [];
  for (const ev of ['order', 'position', 'trade', 'account']) user.on(ev, () => events.push(ev));

  user.onOrder(orderRow('MES', { id: 1, customTag: 'ft-en-1' }));
  user.onOrder({ id: 1, status: ORDER_STATUS.FILLED, fillVolume: 1 });
  assert.equal(user.orders.get(1).customTag, 'ft-en-1');
  assert.equal(user.orders.get(1).status, ORDER_STATUS.FILLED);

  user.onPosition(position('MES', { size: 2 }));
  assert.equal(user.positionFor(contractIdOf('MES')).size, 2);
  user.onPosition({ ...position('MES'), size: 0 });
  assert.equal(user.positionFor(contractIdOf('MES')), null);

  user.onTrade(tradeRow('MES', { id: 4 }));
  assert.ok(user.trades.has(4));
  user.onAccount({ id: 7, balance: '123.5' });
  assert.equal(user.account.balance, 123.5);
  assert.equal(user.account.kind, 'TC', 'account updates merge into the known account');
  assert.deepEqual(events, ['order', 'order', 'position', 'position', 'trade', 'account']);
});

test('hub payloads are unwrapped from objects, arrays and { action, data } envelopes', () => {
  const { user } = setup();
  const handlers = user.hub.handlers;

  handlers.GatewayUserOrder(orderRow('MES', { id: 1 }));
  handlers.GatewayUserOrder([orderRow('MES', { id: 2 }), orderRow('MES', { id: 3 })]);
  handlers.GatewayUserOrder({ action: 1, data: orderRow('MES', { id: 4 }) });
  handlers.GatewayUserOrder([{ action: 1, data: orderRow('MES', { id: 5 }) }]);
  handlers.GatewayUserOrder('ignored-first-arg', orderRow('MES', { id: 6 }));
  handlers.GatewayUserOrder(null);
  assert.deepEqual([...user.orders.keys()].sort(), [1, 2, 3, 4, 5, 6]);

  handlers.GatewayUserPosition({ action: 0, data: position('MES', { size: 1 }) });
  assert.equal(user.positions.size, 1);
  handlers.GatewayUserTrade([tradeRow('MES', { id: 77 })]);
  assert.ok(user.trades.has(77));
  handlers.GatewayUserAccount({ data: { id: 7, balance: 5 } });
  assert.equal(user.account.balance, 5);
});

test('tradesForOrder returns the non-voided fills of that order only', () => {
  const { user } = setup();
  user.onTrade(tradeRow('MES', { id: 1, orderId: 5 }));
  user.onTrade(tradeRow('MES', { id: 2, orderId: 5, voided: true }));
  user.onTrade(tradeRow('MES', { id: 3, orderId: 6 }));
  assert.deepEqual(user.tradesForOrder(5).map((t) => t.id), [1]);
  assert.deepEqual(user.tradesForOrder(404), []);
});

/* ---------------------------------------------------------- waitForFinal -- */

test('waitForFinal resolves when the order reaches a final state', async () => {
  const { user } = setup();
  user.onOrder(orderRow('MES', { id: 5 }));
  const waiting = user.waitForFinal(5, 1000);
  const also = user.waitForFinal(5, 1000);
  user.onOrder({ id: 5, status: ORDER_STATUS.OPEN, fillVolume: 0 });
  user.onOrder({ id: 5, status: ORDER_STATUS.FILLED, fillVolume: 1, filledPrice: 6000 });
  const [a, b] = await Promise.all([waiting, also]);
  assert.equal(a.status, ORDER_STATUS.FILLED);
  assert.equal(a.filledPrice, 6000);
  assert.equal(a.customTag, null, 'the merged order is returned');
  assert.equal(b.id, 5);
  assert.equal(user.waiters.size, 0);
});

test('waitForFinal returns immediately for an order that is already final', async () => {
  const { user } = setup();
  user.onOrder(orderRow('MES', { id: 5, status: ORDER_STATUS.CANCELLED }));
  const started = Date.now();
  assert.equal((await user.waitForFinal(5, 5000)).status, ORDER_STATUS.CANCELLED);
  assert.ok(Date.now() - started < 100);
});

test('waitForFinal resolves null on timeout and leaves no waiter behind', async () => {
  const { user } = setup();
  user.onOrder(orderRow('MES', { id: 5 }));
  assert.equal(await user.waitForFinal(5, 30), null);
  assert.equal(user.waiters.size, 0);

  const slow = user.waitForFinal(8, 80);
  const quick = user.waitForFinal(8, 20);
  assert.equal(await quick, null);
  assert.equal(user.waiters.get(8).length, 1, 'only the timed-out waiter is removed');
  user.onOrder(orderRow('MES', { id: 8, status: ORDER_STATUS.REJECTED }));
  assert.equal((await slow).status, ORDER_STATUS.REJECTED);
});

/* ---------------------------------------------------------- sweepOrphans -- */

test('sweepOrphans cancels a protective order only after the position was gone on two sweeps', async (t) => {
  quiet(t);
  const { client, user } = setup();
  user.onOrder(protective('MES'));
  const cancelled = [];
  user.on('orphan-cancelled', (o, reason) => cancelled.push([o.id, reason]));

  await user.sweepOrphans();
  assert.equal(client.callsOf('cancelOrder').length, 0, 'one empty read is not enough');
  assert.equal(user.strikes.get(10), 1);

  await user.sweepOrphans();
  assert.deepEqual(client.callsOf('cancelOrder'), [{ accountId: 7, orderId: 10 }]);
  assert.deepEqual(cancelled, [[10, 'position is flat']]);
  assert.equal(user.strikes.has(10), false);
});

test('a position that reappears between sweeps clears the strike', async (t) => {
  quiet(t);
  const { client, user } = setup();
  user.onOrder(protective('MES'));
  await user.sweepOrphans();
  user.onPosition(position('MES', { side: 'long', size: 1 }));
  await user.sweepOrphans();
  assert.equal(user.strikes.has(10), false);
  user.onPosition({ ...position('MES'), size: 0 });
  await user.sweepOrphans();
  assert.equal(client.callsOf('cancelOrder').length, 0, 'the count starts over');
});

test('sweepOrphans leaves orders without the protective tag alone', async (t) => {
  quiet(t);
  const { client, user } = setup();
  user.onOrder(protective('MES', { id: 1, customTag: 'ft-ex-1' }));
  user.onOrder(protective('MES', { id: 2, customTag: null }));
  user.onOrder(protective('MES', { id: 3, customTag: 'ft-en-1' }));
  await user.sweepOrphans();
  await user.sweepOrphans();
  await user.sweepOrphans();
  assert.equal(client.callsOf('cancelOrder').length, 0);
});

test('sweepOrphans cancels at once a protective order on the wrong side of the position', async (t) => {
  quiet(t);
  const { client, user } = setup();
  user.onPosition(position('MES', { side: 'long', size: 1 }));
  user.onOrder(protective('MES', { id: 20, side: ORDER_SIDE.BUY }));
  user.onPosition(position('ES', { side: 'short', size: 1, id: 2 }));
  user.onOrder(protective('ES', { id: 21, side: ORDER_SIDE.SELL }));
  user.onPosition(position('MNQ', { side: 'short', size: 1, id: 3 }));
  user.onOrder(protective('MNQ', { id: 22, side: ORDER_SIDE.BUY }));

  const reasons = [];
  user.on('orphan-cancelled', (o, reason) => reasons.push([o.id, reason]));
  await user.sweepOrphans();

  assert.deepEqual(client.callsOf('cancelOrder').map((c) => c.orderId).sort(), [20, 21]);
  assert.deepEqual(reasons.sort(), [[20, 'position flipped'], [21, 'position flipped']]);
});

test('sweepOrphans shrinks a protective order larger than the position', async (t) => {
  quiet(t);
  const { client, user } = setup();
  user.onPosition(position('MES', { side: 'long', size: 2 }));
  user.onOrder(protective('MES', { id: 30, size: 5 }));
  user.onOrder(protective('MES', { id: 31, size: 2 }));
  user.onOrder(protective('MES', { id: 32, size: 1 }));
  await user.sweepOrphans();
  assert.deepEqual(client.callsOf('modifyOrder'), [{ accountId: 7, orderId: 30, size: 2 }]);
  assert.equal(client.callsOf('cancelOrder').length, 0);
});

test('a failing shrink or cancel is logged and retried on the next sweep', async (t) => {
  quiet(t);
  const { client, user } = setup();
  user.onPosition(position('MES', { side: 'long', size: 1 }));
  user.onOrder(protective('MES', { id: 40, size: 3 }));
  client.fail.modifyOrder = new Error('modify down');
  await user.sweepOrphans();
  await user.sweepOrphans();
  assert.equal(client.callsOf('modifyOrder').length, 2);

  const flat = setup();
  flat.user.onOrder(protective('MES', { id: 41 }));
  flat.client.fail.cancelOrder = new Error('cancel down');
  const cancelled = [];
  flat.user.on('orphan-cancelled', (o) => cancelled.push(o.id));
  await flat.user.sweepOrphans();
  await flat.user.sweepOrphans();
  await flat.user.sweepOrphans();
  assert.equal(flat.client.callsOf('cancelOrder').length, 2, 'tries again once the strikes are in');
  assert.deepEqual(cancelled, []);
  flat.client.fail.cancelOrder = null;
  await flat.user.sweepOrphans();
  assert.deepEqual(cancelled, [41]);
});

test('sweepOrphans without an account does nothing', async () => {
  const { client, user } = setup();
  user.onOrder(protective('MES'));
  user.account = null;
  await user.sweepOrphans();
  assert.equal(client.calls.length, 0);
});

/* --------------------------------------------------------- selectAccount -- */

test('selectAccount: explicit selector by id (number or string) or by name', () => {
  const accounts = [
    { id: 1, name: '50KTC-A', canTrade: true },
    { id: 2, name: '50KTC-B', canTrade: false },
  ];
  const pick = (accountSelector) => new UserStream({
    client: fakeClient(), url: 'u', tokenFactory: () => 't', hubFactory: () => ({}), accountSelector,
  }).selectAccount(accounts);
  assert.equal(pick(2).id, 2, 'an explicit selector wins even if the account cannot trade');
  assert.equal(pick('2').id, 2);
  assert.equal(pick('50KTC-A').id, 1);
  assert.throws(() => pick('nope'), /account "nope" not found\. Available: 1=50KTC-A, 2=50KTC-B/);
});

test('selectAccount: auto picks the only account that can trade, else explains', () => {
  const make = (accountSelector) => new UserStream({
    client: fakeClient(), url: 'u', tokenFactory: () => 't', hubFactory: () => ({}), accountSelector,
  });
  const one = [{ id: 1, name: 'A', canTrade: false }, { id: 2, name: 'B', canTrade: true }];
  for (const selector of ['auto', '', null, undefined]) {
    assert.equal(make(selector).selectAccount(one).id, 2, `selector ${JSON.stringify(selector)}`);
  }
  assert.throws(() => make('auto').selectAccount([{ id: 1, name: 'A', canTrade: false }]), /No ProjectX account can trade/);
  assert.throws(() => make('auto').selectAccount([]), /No ProjectX account can trade/);
  assert.throws(
    () => make('auto').selectAccount([{ id: 1, name: 'A', canTrade: true }, { id: 2, name: 'B', canTrade: true }]),
    /Several ProjectX accounts can trade; set projectx_gateway\.account to one of: 1 \(A\), 2 \(B\)/,
  );
});

/* ----------------------------------------------------------------- start -- */

test('start with an ambiguous account records the error and does not connect', async (t) => {
  quiet(t);
  t.mock.method(console, 'error', () => {});
  const client = fakeClient();
  client.searchAccounts = async () => [{ id: 1, name: 'A', canTrade: true }, { id: 2, name: 'B', canTrade: true }];
  const user = new UserStream({ client, url: 'u', tokenFactory: () => 't', hubFactory: () => { throw new Error('must not build a hub'); } });
  await user.start({ tradesSince: 0 });
  assert.equal(user.account, null);
  assert.match(user.accountError, /Several ProjectX accounts/);
  assert.equal(user.status().account, null);
  assert.equal(user.status().state, 'idle');
  await user.stop();
});

test('start against the mock: loads the account, follows fills over the hub and stops cleanly', async (t) => {
  quiet(t);
  const upstream = createMockUpstream({});
  const user = new UserStream({
    client: upstream.client, url: 'mock://user', tokenFactory: () => 't', hubFactory: upstream.userHubFactory, reconcileSecs: 30,
  });
  await user.start({ tradesSince: Date.now() - 3600_000 });
  try {
    assert.equal(user.accountId, 1001);
    assert.equal(user.accountError, null);
    assert.equal(user.hub.state, 'connected');

    const mes = upstream.client.exchange.contracts.find((c) => c.name === 'MESZ6');
    const { orderId } = await upstream.client.placeOrder({
      accountId: 1001, contractId: mes.id, type: ORDER_TYPE.MARKET, side: ORDER_SIDE.BUY, size: 2, customTag: 'ft-en-test',
    });
    const final = await user.waitForFinal(orderId, 2000);
    assert.equal(final.status, ORDER_STATUS.FILLED);
    assert.equal(final.fillVolume, 2);
    await waitFor(() => user.positions.size === 1 && user.tradesForOrder(orderId).length === 1);
    assert.equal(user.positionFor(mes.id).size, 2);
    assert.ok(user.account.balance < 50000, 'fees were booked on the account');

    const status = user.status();
    assert.equal(status.account.id, 1001);
    assert.equal(status.account.simulated, true);
    assert.equal(status.positions, 1);
    assert.equal(status.openOrders, 0);
    assert.ok(status.lastReconcileAt > 0);
    assert.equal(status.state, 'connected');
  } finally {
    await user.stop();
  }
  assert.equal(user.hub.state, 'stopped');
  await sleep(10);
});

test('start loads recent orders and trades into the cache before reconciling', async (t) => {
  quiet(t);
  const client = fakeClient();
  client.orderRows = [orderRow('MES', { id: 1, status: ORDER_STATUS.FILLED })];
  client.searchTrades = async () => [tradeRow('MES', { id: 9 })];
  const hubs = [];
  const user = new UserStream({
    client, url: 'u', tokenFactory: () => 't', reconcileSecs: 30,
    hubFactory: () => {
      const hub = {
        on() {}, onreconnecting() {}, onreconnected() {}, onclose() {},
        async start() {}, async stop() {}, async invoke(...args) { hubs.push(args); },
      };
      return hub;
    },
  });
  await user.start({ tradesSince: 0 });
  try {
    assert.ok(user.orders.has(1));
    assert.ok(user.trades.has(9));
    assert.deepEqual(hubs, [
      ['SubscribeAccounts'],
      ['SubscribeOrders', 7],
      ['SubscribePositions', 7],
      ['SubscribeTrades', 7],
    ], 'every stream is subscribed for the selected account');
  } finally {
    await user.stop();
  }
});

/* ----------------------------------------------- reconcile on every connect -- */

/** A hub whose lifecycle callbacks the test can fire. */
function drivableHub(registry) {
  return () => {
    const hub = {
      invocations: [],
      on() {},
      onreconnecting() {},
      onreconnected(fn) { hub.reconnected = fn; },
      onclose(fn) { hub.closed = fn; },
      async start() {},
      async stop() {},
      async invoke(...args) { hub.invocations.push(args); },
    };
    registry.push(hub);
    return hub;
  };
}

test('every hub connect, including a SignalR reconnect, replaces the cached state with a REST reconcile', async (t) => {
  quiet(t);
  const client = fakeClient();
  const hubs = [];
  const user = new UserStream({ client, url: 'u', tokenFactory: () => 't', hubFactory: drivableHub(hubs), reconcileSecs: 3600 });
  await user.start({ tradesSince: 0 });
  try {
    const initial = client.callsOf('searchOpenPositions').length;
    assert.ok(initial >= 2, 'start() reconciles, and the first connect reconciles again');

    // The socket dropped for a while: a fill and a position change were missed.
    client.positionRows = [position('MES', { size: 2 })];
    client.orderRows = [orderRow('MES', { id: 77 })];
    assert.equal(user.positions.size, 0);

    await hubs[0].reconnected();

    assert.equal(client.callsOf('searchOpenPositions').length, initial + 1, 'a REST reconcile ran on the reconnect');
    assert.equal(user.positionFor(contractIdOf('MES')).size, 2, 'the missed position is picked up');
    assert.ok(user.orders.has(77), 'and the missed order');
    assert.deepEqual(hubs[0].invocations.map((i) => i[0]), [
      'SubscribeAccounts', 'SubscribeOrders', 'SubscribePositions', 'SubscribeTrades',
      'SubscribeAccounts', 'SubscribeOrders', 'SubscribePositions', 'SubscribeTrades',
    ], 'resubscribed first, then reconciled');
    assert.equal(user.hub.state, 'connected');
  } finally {
    await user.stop();
  }
});

test('a reconcile that fails after connecting only warns, the hub still counts as connected', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const client = fakeClient();
  const hubs = [];
  const user = new UserStream({ client, url: 'u', tokenFactory: () => 't', hubFactory: drivableHub(hubs), reconcileSecs: 3600 });
  await user.start({ tradesSince: 0 });
  try {
    client.fail.searchOpenPositions = new Error('REST is down');
    await hubs[0].reconnected();
    assert.equal(user.hub.state, 'connected');
    assert.ok(warn.mock.calls.some((c) => /reconcile after connect failed: REST is down/.test(c.arguments[0])));
  } finally {
    await user.stop();
  }
});

test('status reports how long ago the last successful reconcile was', async () => {
  const { user } = setup();
  assert.equal(user.status().reconcileAgeMs, null);
  await user.reconcile();
  const age = user.status().reconcileAgeMs;
  assert.ok(age >= 0 && age < 1000);
});

/* ------------------------------------------------------ pruning and indexing -- */

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n, now = Date.now()) => new Date(now - n * DAY).toISOString();

test('prune drops finished orders older than orders_days and keeps working and recent ones', () => {
  const { user } = setup();
  user.onOrder(orderRow('MES', { id: 1, status: ORDER_STATUS.FILLED, creationTimestamp: daysAgo(5), updateTimestamp: daysAgo(5) }));
  user.onOrder(orderRow('MES', { id: 2, status: ORDER_STATUS.CANCELLED, creationTimestamp: daysAgo(3), updateTimestamp: daysAgo(3) }));
  user.onOrder(orderRow('MES', { id: 3, status: ORDER_STATUS.FILLED, creationTimestamp: daysAgo(1), updateTimestamp: daysAgo(1) }));
  user.onOrder(orderRow('MES', { id: 4, status: ORDER_STATUS.OPEN, creationTimestamp: daysAgo(30), updateTimestamp: daysAgo(30) }));
  user.onOrder(orderRow('MES', { id: 5, status: ORDER_STATUS.REJECTED, creationTimestamp: daysAgo(10), updateTimestamp: null }));
  user.onOrder(orderRow('MES', { id: 6, status: ORDER_STATUS.FILLED, creationTimestamp: 'garbage', updateTimestamp: undefined }));

  const dropped = user.prune();

  assert.deepEqual([...user.orders.keys()].sort(), [3, 4, 6]);
  assert.equal(dropped.orders, 3);
  assert.deepEqual(user.openOrders().map((o) => o.id), [4], 'a working order is kept however old it is');
});

test('prune drops fills older than trades_days and keeps the index in step', () => {
  const { user } = setup();
  user.onTrade(tradeRow('MES', { id: 1, orderId: 10, creationTimestamp: daysAgo(20) }));
  user.onTrade(tradeRow('MES', { id: 2, orderId: 10, creationTimestamp: daysAgo(20) }));
  user.onTrade(tradeRow('MES', { id: 3, orderId: 11, creationTimestamp: daysAgo(20) }));
  user.onTrade(tradeRow('MES', { id: 4, orderId: 11, creationTimestamp: daysAgo(1) }));
  user.onTrade(tradeRow('MES', { id: 5, orderId: 12, creationTimestamp: daysAgo(13) }));

  const dropped = user.prune();

  assert.equal(dropped.trades, 3);
  assert.deepEqual([...user.trades.keys()].sort(), [4, 5]);
  assert.deepEqual(user.tradesForOrder(10), [], 'an order whose fills all went has no index entry');
  assert.equal(user.tradesByOrder.has(10), false);
  assert.deepEqual(user.tradesForOrder(11).map((t) => t.id), [4]);
  assert.deepEqual(user.tradesForOrder(12).map((t) => t.id), [5]);
});

test('retention comes from the constructor and falls back to 2 and 14 days', () => {
  const client = fakeClient();
  const make = (retention) => new UserStream({ client, url: 'u', tokenFactory: () => 't', hubFactory: () => ({}), retention });
  assert.deepEqual(make(undefined).retention, { orders_days: 2, trades_days: 14 });
  assert.deepEqual(make({ orders_days: 0, trades_days: 'x' }).retention, { orders_days: 2, trades_days: 14 });
  assert.deepEqual(make({ orders_days: 7, trades_days: 30 }).retention, { orders_days: 7, trades_days: 30 });

  const wide = make({ orders_days: 7, trades_days: 30 });
  wide.account = { id: 7 };
  wide.onOrder(orderRow('MES', { id: 1, status: ORDER_STATUS.FILLED, creationTimestamp: daysAgo(5), updateTimestamp: daysAgo(5) }));
  wide.onTrade(tradeRow('MES', { id: 1, creationTimestamp: daysAgo(20) }));
  wide.prune();
  assert.ok(wide.orders.has(1) && wide.trades.has(1));
});

test('tradesForOrder is served by the index and returns what the old scan returned', () => {
  const { user } = setup();
  const rows = [];
  for (let i = 1; i <= 200; i += 1) rows.push(tradeRow('MES', { id: i, orderId: i % 20, voided: i % 7 === 0 }));
  rows.forEach((r) => user.onTrade(r));

  for (let order = 0; order < 20; order += 1) {
    const scan = rows.filter((t) => t.orderId === order && !t.voided).map((t) => t.id);
    assert.deepEqual(user.tradesForOrder(order).map((t) => t.id).sort((a, b) => a - b), scan, `order ${order}`);
  }
  assert.equal(user.tradesByOrder.size, 20);
});

test('a trade re-sent with the same id replaces itself in the index, also when its order changes', () => {
  const { user } = setup();
  user.onTrade(tradeRow('MES', { id: 1, orderId: 10, size: 1 }));
  user.onTrade(tradeRow('MES', { id: 1, orderId: 10, size: 2 }));
  assert.deepEqual(user.tradesForOrder(10).map((t) => t.size), [2], 'no duplicate');
  user.onTrade(tradeRow('MES', { id: 1, orderId: 11, size: 2 }));
  assert.deepEqual(user.tradesForOrder(10), []);
  assert.equal(user.tradesForOrder(11).length, 1);
  assert.equal(user.tradesByOrder.has(10), false);
});

test('fills loaded at start and fills without an order id are indexed or skipped correctly', async (t) => {
  quiet(t);
  const client = fakeClient();
  client.searchTrades = async () => [tradeRow('MES', { id: 1, orderId: 5 }), tradeRow('MES', { id: 2, orderId: null })];
  const user = new UserStream({ client, url: 'u', tokenFactory: () => 't', hubFactory: () => ({}) });
  user.account = { id: 7 };
  await user.loadHistory(0);
  assert.deepEqual(user.tradesForOrder(5).map((x) => x.id), [1]);
  assert.equal(user.trades.size, 2);
  assert.equal(user.tradesByOrder.size, 1);
});

test('prune drops strike counters and empty waiter lists of orders that are gone', () => {
  const { user } = setup();
  user.onOrder(orderRow('MES', { id: 1, status: ORDER_STATUS.OPEN }));
  user.onOrder(orderRow('MES', { id: 2, status: ORDER_STATUS.FILLED }));
  user.strikes.set(1, 1);
  user.strikes.set(2, 1);
  user.strikes.set(99, 1);
  user.waiters.set(1, [() => {}]);
  user.waiters.set(2, []);
  user.prune();
  assert.deepEqual([...user.strikes.keys()], [1], 'only the strike on a still-working order is kept');
  assert.deepEqual([...user.waiters.keys()], [1]);
});

test('pruning waits for armPruning(), then runs after every reconcile', async () => {
  const { client, user } = setup();
  client.orderRows = [];
  user.onOrder(orderRow('MES', { id: 1, status: ORDER_STATUS.FILLED, creationTimestamp: daysAgo(9), updateTimestamp: daysAgo(9) }));
  user.onTrade(tradeRow('MES', { id: 1, creationTimestamp: daysAgo(60) }));

  await user.reconcile();
  assert.equal(user.orders.size + user.trades.size, 2, 'nothing is pruned before the guard has used the history');

  user.armPruning();
  assert.equal(user.orders.size + user.trades.size, 0, 'arming prunes right away');

  user.onTrade(tradeRow('MES', { id: 2, creationTimestamp: daysAgo(40) }));
  await user.reconcile();
  assert.equal(user.trades.size, 0, 'and every reconcile prunes again');
});

test('memory stays bounded: 10k synthetic fills over 40 days leave only the retained window', () => {
  const { user } = setup();
  const now = Date.now();
  for (let i = 0; i < 10_000; i += 1) {
    const age = (i / 10_000) * 40; // days
    const stamp = daysAgo(age, now);
    user.onOrder(orderRow('MES', { id: 100_000 + i, status: ORDER_STATUS.FILLED, creationTimestamp: stamp, updateTimestamp: stamp }));
    user.onTrade(tradeRow('MES', { id: i + 1, orderId: 100_000 + i, creationTimestamp: stamp }));
  }
  assert.equal(user.trades.size, 10_000);

  user.prune(now);

  // 14 of 40 days of fills and 2 of 40 days of orders remain.
  assert.ok(user.trades.size <= 10_000 * (14 / 40) + 5 && user.trades.size >= 10_000 * (14 / 40) - 5, `trades ${user.trades.size}`);
  assert.ok(user.orders.size <= 10_000 * (2 / 40) + 5, `orders ${user.orders.size}`);
  assert.equal(user.tradesByOrder.size, user.trades.size, 'the index holds exactly the retained fills');
  let indexed = 0;
  for (const byId of user.tradesByOrder.values()) indexed += byId.size;
  assert.equal(indexed, user.trades.size);
  for (const [id] of user.trades) assert.ok(user.tradesForOrder(100_000 + id - 1).length === 1);
});
