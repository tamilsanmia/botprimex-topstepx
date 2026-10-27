import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GatewayError } from '../src/errors.js';
import { ORDER_SIDE, ORDER_STATUS, ORDER_TYPE } from '../src/projectx.js';
import { GATEWAY_STOP_TAG } from '../src/router.js';
import {
  contractIdOf, makeMockApp, makeRouter, orderRow, position, sleep, stubGuard, waitFor,
} from './helpers.js';

const MES = contractIdOf('MES');
const T0 = 1_800_000_000_000;
const SEC = 1000;

/** Router in gateway-stop mode with the user hub "connected" and a 250 USD risk cap. */
function setup({ maxRisk = 250, mode = 'gateway', grace = 10, flatten = 30, specs, config = {}, dataOnly = false } = {}) {
  const notes = [];
  const ctx = makeRouter({
    guard: () => stubGuard({ maxRisk }),
    specs,
    config: { protective_stop: { mode, grace_secs: grace, flatten_after_secs: flatten }, ...config },
  });
  ctx.router.notify = (text) => notes.push(text);
  ctx.router.dataOnly = dataOnly;
  ctx.user.hub.state = 'connected';
  ctx.user.waitForFinal = async () => null;
  ctx.notes = notes;
  return ctx;
}

const stopRow = (id, over = {}) => orderRow('MES', {
  id, type: ORDER_TYPE.STOP, side: ORDER_SIDE.SELL, size: 2, limitPrice: null, stopPrice: 5975, customTag: 'ft-sl-abc', ...over,
});

const placed = (ctx) => ctx.client.callsOf('placeOrder');

/* ------------------------------------------------------------- watchdog -- */

test('a long position without a stop gets a gateway stop only after grace_secs', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));

  await ctx.router.protectPositions(T0);
  await ctx.router.protectPositions(T0 + 9 * SEC);
  assert.equal(placed(ctx).length, 0, 'inside the grace period Freqtrade may still place its own stop');

  await ctx.router.protectPositions(T0 + 10 * SEC);
  assert.equal(placed(ctx).length, 1);
  const body = placed(ctx)[0];
  assert.equal(body.type, ORDER_TYPE.STOP);
  assert.equal(body.side, ORDER_SIDE.SELL);
  assert.equal(body.size, 2);
  assert.equal(body.contractId, MES);
  assert.equal(body.stopPrice, 5975, '250 / (2 x 1.25) = 100 ticks x 0.25 below 6000');
  assert.equal(body.limitPrice, null);
  assert.match(body.customTag, /^ft-sl-gw-[0-9a-z]+$/);
  assert.ok(body.customTag.startsWith(GATEWAY_STOP_TAG));
  assert.equal(ctx.notes.length, 1);
  assert.match(ctx.notes[0], /MES had no stop for 10s: the gateway placed stop/);
  assert.equal(ctx.client.callsOf('closeContract').length, 0);
});

test('a short position gets a buy stop above the entry', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'short', size: 1, price: 6000 }));
  await ctx.router.protectPositions(T0);
  await ctx.router.protectPositions(T0 + 10 * SEC);
  const body = placed(ctx)[0];
  assert.equal(body.side, ORDER_SIDE.BUY);
  assert.equal(body.size, 1);
  assert.equal(body.stopPrice, 6050, '250 / 1.25 = 200 ticks x 0.25 above 6000');
});

test('the gateway places one stop, not one per check, while the order is not yet visible', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  await ctx.router.protectPositions(T0);
  await ctx.router.protectPositions(T0 + 10 * SEC);
  const orderId = 101; // the first id the fake exchange hands out
  await ctx.router.protectPositions(T0 + 12 * SEC);
  await ctx.router.protectPositions(T0 + 13 * SEC);
  assert.equal(placed(ctx).length, 1);
  assert.equal(ctx.client.callsOf('closeContract').length, 0, 'still inside the 5 s visibility window');

  // The hub reports the stop as working: all is well from here on.
  ctx.user.onOrder(stopRow(orderId, { customTag: placed(ctx)[0].customTag }));
  await ctx.router.protectPositions(T0 + 20 * SEC);
  await ctx.router.protectPositions(T0 + 40 * SEC);
  assert.equal(placed(ctx).length, 1);
  assert.equal(ctx.client.callsOf('closeContract').length, 0);
});

test('no stop is placed when a stop is already working, however long the position has been open', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  ctx.user.onOrder(stopRow(300));
  for (const s of [0, 10, 30, 120]) await ctx.router.protectPositions(T0 + s * SEC);
  assert.equal(placed(ctx).length, 0);
  assert.equal(ctx.client.callsOf('closeContract').length, 0);
  assert.deepEqual(ctx.notes, []);
});

test('a stop on the wrong side, a limit order or a stop on another contract do not count as protection', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  ctx.user.onOrder(stopRow(300, { side: ORDER_SIDE.BUY }));
  ctx.user.onOrder(orderRow('MES', { id: 301, type: ORDER_TYPE.LIMIT, side: ORDER_SIDE.SELL }));
  ctx.user.onOrder(stopRow(302, { contractId: contractIdOf('ES') }));
  ctx.user.onOrder(stopRow(303, { status: ORDER_STATUS.CANCELLED }));
  await ctx.router.protectPositions(T0);
  await ctx.router.protectPositions(T0 + 10 * SEC);
  assert.equal(placed(ctx).length, 1);
});

test('the grace period restarts when a stop disappears', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  ctx.user.onOrder(stopRow(300));
  await ctx.router.protectPositions(T0);
  await ctx.router.protectPositions(T0 + 100 * SEC);
  ctx.user.onOrder(stopRow(300, { status: ORDER_STATUS.CANCELLED }));
  await ctx.router.protectPositions(T0 + 101 * SEC);
  await ctx.router.protectPositions(T0 + 105 * SEC);
  assert.equal(placed(ctx).length, 0, 'Freqtrade is moving its stop: 4 s without one is within grace');
  await ctx.router.protectPositions(T0 + 111 * SEC);
  assert.equal(placed(ctx).length, 1);
});

test('the position is flattened when the gateway cannot place the stop', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  ctx.user.onOrder(orderRow('MES', { id: 400, type: ORDER_TYPE.LIMIT, side: ORDER_SIDE.SELL, limitPrice: 6100 }));
  ctx.client.fail.placeOrder = new GatewayError('Stop price invalid', { status: 400, kind: 'InvalidOrder' });

  await ctx.router.protectPositions(T0);
  await ctx.router.protectPositions(T0 + 10 * SEC);

  assert.deepEqual(ctx.client.callsOf('cancelOrder'), [{ accountId: 7, orderId: 400 }], 'working orders are cancelled first');
  assert.deepEqual(ctx.client.callsOf('closeContract'), [{ accountId: 7, contractId: MES }]);
  assert.equal(ctx.notes.length, 1);
  assert.match(ctx.notes[0], /MES 2 contracts flattened by the gateway: the gateway could not place a stop \(Stop price invalid\)/);
  assert.equal(ctx.router.pendingFlattens.get('MES').contractId, MES, 'Freqtrade\'s own exit is answered with the real fill');
  assert.equal(ctx.router.watch.size, 0);
});

test('the position is flattened when the stop would risk more than max_risk_per_trade even at one tick', async () => {
  const ctx = setup({ maxRisk: 1 });
  ctx.user.onPosition(position('MES', { side: 'long', size: 1, price: 6000 }));
  await ctx.router.protectPositions(T0);
  await ctx.router.protectPositions(T0 + 10 * SEC);
  assert.equal(placed(ctx).length, 0);
  assert.equal(ctx.client.callsOf('closeContract').length, 1);
  assert.match(ctx.notes[0], /below one tick of risk/);
});

test('the position is flattened when the stop the gateway placed never shows up as a working order', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  await ctx.router.protectPositions(T0);
  await ctx.router.protectPositions(T0 + 10 * SEC);
  assert.equal(placed(ctx).length, 1);
  await ctx.router.protectPositions(T0 + 14 * SEC);
  assert.equal(ctx.client.callsOf('closeContract').length, 0);
  await ctx.router.protectPositions(T0 + 15 * SEC);
  assert.equal(ctx.client.callsOf('closeContract').length, 1);
  assert.match(ctx.notes.at(-1), /did not show up as a working order/);
});

test('flatten_after_secs is a hard deadline: no stop that long means flatten, without a new attempt', async () => {
  const ctx = setup({ grace: 10, flatten: 30 });
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  await ctx.router.protectPositions(T0);
  await ctx.router.protectPositions(T0 + 31 * SEC);
  assert.equal(placed(ctx).length, 0);
  assert.equal(ctx.client.callsOf('closeContract').length, 1);
  assert.match(ctx.notes[0], /no stop order was working 31s after the position opened/);
});

test('a failed flatten is reported once and retried on the next check', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  ctx.client.fail.placeOrder = new GatewayError('no', { status: 400, kind: 'InvalidOrder' });
  ctx.client.fail.closeContract = new GatewayError('down', { status: 502, kind: 'ExchangeError' });
  await ctx.router.protectPositions(T0);
  await ctx.router.protectPositions(T0 + 10 * SEC);
  await ctx.router.protectPositions(T0 + 12 * SEC);
  await ctx.router.protectPositions(T0 + 14 * SEC);
  assert.equal(ctx.client.callsOf('closeContract').length, 3, 'tried again every check');
  assert.equal(ctx.notes.length, 1, 'but announced once');
  assert.match(ctx.notes[0], /flatten FAILED: down\. Close it manually/);
  ctx.client.fail.closeContract = null;
  await ctx.router.protectPositions(T0 + 16 * SEC);
  assert.equal(ctx.notes.length, 2);
  assert.match(ctx.notes[1], /flattened by the gateway/);
});

test('state follows the position: flat clears it, a flip starts a new grace period', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  await ctx.router.protectPositions(T0);
  assert.equal(ctx.router.watch.size, 1);
  ctx.user.onPosition(position('MES', { side: 'long', size: 0 }));
  await ctx.router.protectPositions(T0 + 5 * SEC);
  assert.equal(ctx.router.watch.size, 0);

  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  await ctx.router.protectPositions(T0 + 6 * SEC);
  ctx.user.onPosition(position('MES', { side: 'short', size: 2, price: 6000 }));
  await ctx.router.protectPositions(T0 + 15 * SEC);
  assert.equal(placed(ctx).length, 0, 'the flipped position is new: its grace period just started');
  await ctx.router.protectPositions(T0 + 25 * SEC);
  assert.equal(placed(ctx).length, 1);
  assert.equal(placed(ctx)[0].side, ORDER_SIDE.BUY);
});

test('the watchdog does nothing in mode off or native, without a risk cap, on data-only, or without an account', async () => {
  for (const make of [
    () => setup({ mode: 'off' }),
    () => setup({ mode: 'native' }),
    () => setup({ maxRisk: null }),
    () => setup({ dataOnly: true }),
    () => { const c = setup(); c.user.account = null; return c; },
  ]) {
    const ctx = make();
    ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
    await ctx.router.protectPositions(T0);
    await ctx.router.protectPositions(T0 + 60 * SEC);
    assert.equal(placed(ctx).length, 0);
    assert.equal(ctx.client.callsOf('closeContract').length, 0);
  }
});

test('overlapping watchdog runs are skipped', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  await ctx.router.protectPositions(T0);
  const original = ctx.client.placeOrder.bind(ctx.client);
  ctx.client.placeOrder = async (body) => { await sleep(30); return original(body); };
  await Promise.all([ctx.router.protectPositions(T0 + 10 * SEC), ctx.router.protectPositions(T0 + 10 * SEC), ctx.router.protectPositions(T0 + 10 * SEC)]);
  assert.equal(placed(ctx).length, 1);
});

/* ---------------------------------------------- Freqtrade stop takes over -- */

test('the watchdog cancels its own stop once another stop protects the position', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  await ctx.router.protectPositions(T0);
  await ctx.router.protectPositions(T0 + 10 * SEC);
  const gwTag = placed(ctx)[0].customTag;
  ctx.user.onOrder(stopRow(101, { customTag: gwTag }));
  await ctx.router.protectPositions(T0 + 12 * SEC);
  assert.equal(ctx.client.callsOf('cancelOrder').length, 0, 'alone, the gateway stop stays');

  ctx.user.onOrder(stopRow(555, { customTag: 'ft-sl-freqtrade' }));
  await ctx.router.protectPositions(T0 + 14 * SEC);
  assert.deepEqual(ctx.client.callsOf('cancelOrder'), [{ accountId: 7, orderId: 101 }]);
});

test('accepting a Freqtrade ft-sl- stop cancels the gateway stop on that contract', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  ctx.user.onOrder(stopRow(101, { customTag: `${GATEWAY_STOP_TAG}abc` }));
  ctx.user.onOrder(stopRow(102, { customTag: `${GATEWAY_STOP_TAG}other`, contractId: contractIdOf('ES') }));

  const order = await ctx.router.place({
    symbol: 'MES/USD:USD', type: 'market', side: 'sell', amount: 2, params: { reduceOnly: true, stopPrice: 5970 },
  });

  assert.equal(order.type, 'stop');
  assert.match(placed(ctx)[0].customTag, /^ft-sl-[0-9a-z]+$/);
  assert.ok(!placed(ctx)[0].customTag.startsWith(GATEWAY_STOP_TAG));
  assert.deepEqual(ctx.client.callsOf('cancelOrder'), [{ accountId: 7, orderId: 101 }], 'only the stop on this contract goes');
});

test('a Freqtrade exit or an entry does not touch the gateway stop', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  ctx.user.onOrder(stopRow(101, { customTag: `${GATEWAY_STOP_TAG}abc` }));
  await ctx.router.place({ symbol: 'MES/USD:USD', type: 'limit', side: 'sell', amount: 1, price: 6100, params: { reduceOnly: true } });
  await ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 1 });
  assert.equal(ctx.client.callsOf('cancelOrder').length, 0);
});

test('a gateway stop that cannot be cancelled does not fail the Freqtrade stop', async () => {
  const ctx = setup();
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  ctx.user.onOrder(stopRow(101, { customTag: `${GATEWAY_STOP_TAG}abc` }));
  ctx.client.fail.cancelOrder = new GatewayError('late', { status: 502 });
  const order = await ctx.router.place({ symbol: 'MES/USD:USD', type: 'stop', side: 'sell', amount: 2, params: { reduceOnly: true, stopPrice: 5970 } });
  assert.equal(order.type, 'stop');
});

/* -------------------------------------------------- entries it cannot protect -- */

const entry = (ctx, amount = 1) => ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount });
const refused = (promise, match) => assert.rejects(promise, (err) => {
  assert.equal(err.kind, 'InvalidOrder');
  assert.match(err.message, /could not protect this entry/);
  assert.match(err.message, match);
  return true;
});

test('entries are accepted when the gateway can protect them', async () => {
  const ctx = setup();
  await entry(ctx, 2);
  assert.equal(placed(ctx).length, 1);
});

test('an entry is refused when max_risk_per_trade is under one tick of risk for its size', async () => {
  const ctx = setup({ maxRisk: 5 });
  await entry(ctx, 4); // 5 / (4 x 1.25) = 1 tick
  await refused(entry(ctx, 5), /below one tick of risk for 5 MES/); // 5 / 6.25 = 0
  assert.equal(placed(ctx).length, 1);
  assert.equal(ctx.router.reservations.size, 0);
});

test('the size of the position already held counts toward the risk check', async () => {
  const ctx = setup({ maxRisk: 5 });
  ctx.user.onPosition(position('MES', { side: 'long', size: 3, price: 6000 }));
  await refused(entry(ctx, 2), /for 5 MES/);
  await entry(ctx, 1);
});

test('an entry is refused when tick size or value is unknown', async () => {
  const ctx = setup({ specs: { MES: { tickSize: 0, tickValue: 0 } } });
  await refused(entry(ctx), /no tick size or tick value known for MES/);
  assert.equal(placed(ctx).length, 0);
});

test('an entry is refused while the user hub is not connected', async () => {
  const ctx = setup();
  ctx.user.hub.state = 'reconnecting';
  await refused(entry(ctx), /user hub is not connected/);
  ctx.user.hub.state = 'connected';
  await entry(ctx);
  assert.equal(placed(ctx).length, 1);
});

test('without a risk cap, or in mode off or native, nothing is refused', async () => {
  for (const make of [() => setup({ maxRisk: null }), () => setup({ mode: 'off' }), () => setup({ mode: 'native' })]) {
    const ctx = make();
    ctx.user.hub.state = 'idle';
    await entry(ctx, 3);
    assert.equal(placed(ctx).length, 1);
  }
});

test('mode native attaches the stopLossBracket without brackets: native; separate and gateway do not', async () => {
  const native = setup({ mode: 'native' });
  await entry(native, 2);
  assert.deepEqual(placed(native)[0].stopLossBracket, { ticks: 100, type: ORDER_TYPE.STOP });

  const gateway = setup({ mode: 'gateway' });
  await entry(gateway, 2);
  assert.equal('stopLossBracket' in placed(gateway)[0], false);

  const both = setup({ mode: 'gateway', config: { brackets: 'native' } });
  await entry(both, 2);
  assert.deepEqual(placed(both)[0].stopLossBracket, { ticks: 100, type: ORDER_TYPE.STOP }, 'brackets: native keeps its meaning');
});

test('exits are never refused for protection reasons', async () => {
  const ctx = setup({ maxRisk: 1 });
  ctx.user.hub.state = 'idle';
  ctx.user.onPosition(position('MES', { side: 'long', size: 2, price: 6000 }));
  await ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'sell', amount: 2, params: { reduceOnly: true } });
  assert.equal(placed(ctx).length, 1);
});

/* ------------------------------------------------------------ data-only -- */

test('a data-only router refuses every order-changing call with 403 PermissionDenied and touches nothing', async () => {
  const ctx = setup({ dataOnly: true });
  const calls = [
    () => entry(ctx),
    () => ctx.router.cancel(5),
    () => ctx.router.modify(5, { price: 1 }),
    () => ctx.router.closePosition('MES/USD:USD'),
  ];
  for (const call of calls) {
    await assert.rejects(call(), (err) => err instanceof GatewayError && err.status === 403 && err.kind === 'PermissionDenied');
  }
  assert.equal(ctx.client.calls.length, 0);
});

/* ------------------------------------------------- end to end on the mock -- */

test('mock: brackets native creates the stop at the fill, which can be modified and is cancelled when the position closes', async () => {
  const gw = await makeMockApp({ gateway: { brackets: 'native', protective_stop: { mode: 'off' } } });
  try {
    const order = (await gw.post('/order', { symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 2 })).body;
    assert.equal(order.status, 'closed');
    const stop = await waitFor(async () => (await gw.get('/orders/open')).body.find((o) => o.type === 'stop'));
    assert.equal(stop.side, 'sell');
    assert.equal(stop.amount, 2);
    assert.ok(stop.stopPrice > 0 && stop.stopPrice < order.average, 'the stop sits below a long entry');
    assert.equal(stop.clientOrderId, null, 'a bracket stop carries no ft- tag');

    const moved = await gw.post(`/order/${stop.id}/modify`, { stopPrice: stop.stopPrice - 5 });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.stopPrice, stop.stopPrice - 5);

    await gw.post('/order', { symbol: 'MES/USD:USD', type: 'market', side: 'sell', amount: 2, params: { reduceOnly: true } });
    await waitFor(async () => (await gw.get('/positions')).body.length === 0);
    await waitFor(async () => (await gw.get('/orders/open')).body.length === 0);
  } finally {
    await gw.stop();
  }
});

test('mock: a bracket stop can be cancelled over HTTP', async () => {
  const gw = await makeMockApp({ gateway: { brackets: 'native', protective_stop: { mode: 'off' } } });
  try {
    await gw.post('/order', { symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 1 });
    const stop = await waitFor(async () => (await gw.get('/orders/open')).body.find((o) => o.type === 'stop'));
    const cancelled = await gw.post(`/order/${stop.id}/cancel`, {});
    assert.equal(cancelled.body.status, 'canceled');
  } finally {
    await gw.stop();
  }
});

test('mock: the watchdog stops an unprotected position, and a Freqtrade stop replaces it', async () => {
  const gw = await makeMockApp({ gateway: { protective_stop: { mode: 'gateway', grace_secs: 1, flatten_after_secs: 20 } } });
  try {
    assert.equal(gw.app.router().protectiveStop().mode, 'gateway');
    const order = (await gw.post('/order', { symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 1 })).body;
    assert.equal(order.status, 'closed');

    const stop = await waitFor(async () => (await gw.get('/orders/open')).body.find((o) => o.type === 'stop'), 9000, 100);
    assert.match(stop.clientOrderId, /^ft-sl-gw-/);
    assert.equal(stop.side, 'sell');
    assert.equal(stop.amount, 1);
    assert.equal(stop.stopPrice, Math.round((order.average - 200 * 0.25) / 0.25) * 0.25, '250 / 1.25 = 200 ticks below the entry');

    const ft = await gw.post('/order', { symbol: 'MES/USD:USD', type: 'market', side: 'sell', amount: 1, params: { reduceOnly: true, stopPrice: stop.stopPrice - 1 } });
    assert.equal(ft.status, 200);
    assert.match(ft.body.clientOrderId, /^ft-sl-[0-9a-z]+$/);
    await waitFor(async () => {
      const open = (await gw.get('/orders/open')).body.filter((o) => o.type === 'stop');
      return open.length === 1 && !open[0].clientOrderId.startsWith('ft-sl-gw-');
    }, 5000, 50);
    assert.equal((await gw.get('/positions')).body.length, 1, 'the position was not closed');
  } finally {
    await gw.stop();
  }
});

test('mock: with the default protective stop config a normal entry is accepted', async () => {
  const gw = await makeMockApp();
  try {
    assert.equal(gw.app.cfg.gateway.protective_stop.mode, 'gateway');
    const order = (await gw.post('/order', { symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 1 })).body;
    assert.equal(order.status, 'closed');
  } finally {
    await gw.stop();
  }
});

test('mock: on a data-only gateway the order routes answer 403 and reads still work', async () => {
  const gw = await makeMockApp({ dataOnly: true });
  try {
    for (const [route, body] of [['/order', { symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 1 }], ['/order/1/cancel', {}], ['/order/1/modify', { price: 1 }], ['/position/close', { symbol: 'MES/USD:USD' }]]) {
      const res = await gw.post(route, body);
      assert.equal(res.status, 403, route);
      assert.equal(res.body.kind, 'PermissionDenied');
    }
    assert.equal((await gw.get('/markets')).status, 200);
    const ohlcv = await gw.get('/ohlcv?symbol=MES/USD:USD&timeframe=1m&limit=5');
    assert.equal(ohlcv.status, 200);
    assert.ok(ohlcv.body.length > 0);
    const health = (await gw.get('/health')).body;
    assert.equal(health.ready, true);
    assert.equal(gw.app.user.accountId, null, 'no account was selected');
    assert.equal(gw.app.guard, null, 'no guard');
    assert.equal(gw.app.protectTimer, undefined, 'no watchdog');
  } finally {
    await gw.stop();
  }
});
