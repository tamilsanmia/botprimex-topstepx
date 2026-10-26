import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GatewayError } from '../src/errors.js';
import { ORDER_SIDE, ORDER_STATUS, ORDER_TYPE } from '../src/projectx.js';
import {
  contractIdOf, makeRouter, orderRow, position, sleep, stubGuard, tradeRow,
} from './helpers.js';

const MES = contractIdOf('MES');

/** Simulates the exchange: every placed order is filled at `price` and reported on the user hub. */
function autoFill(ctx, price) {
  ctx.client.onPlace = (body, id) => {
    setImmediate(() => {
      const row = orderRow('MES', {
        id,
        contractId: body.contractId,
        type: body.type,
        side: body.side,
        size: body.size,
        customTag: body.customTag,
        status: ORDER_STATUS.FILLED,
        fillVolume: body.size,
        filledPrice: price,
      });
      ctx.user.onTrade(tradeRow('MES', { id: id + 1000, orderId: id, contractId: body.contractId, side: body.side, size: body.size, price }));
      const signed = body.side === ORDER_SIDE.BUY ? body.size : -body.size;
      const held = ctx.user.positions.get(body.contractId);
      const current = held ? (held.type === 1 ? held.size : -held.size) : 0;
      const next = current + signed;
      ctx.user.onPosition(position('MES', { side: next >= 0 ? 'long' : 'short', size: Math.abs(next), price }));
      ctx.user.onOrder(row);
    });
  };
}

const lastBody = (ctx) => ctx.client.callsOf('placeOrder').at(-1);

async function rejects(promise, { kind, status, match }) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof GatewayError, `expected GatewayError, got ${err}`);
    if (kind) assert.equal(err.kind, kind);
    if (status) assert.equal(err.status, status);
    if (match) assert.match(err.message, match);
    return true;
  });
}

/* ---------------------------------------------------------------- place -- */

test('place: market entry sends the expected body, tags it ft-en- and returns the fill', async () => {
  const guard = stubGuard();
  const ctx = makeRouter({ guard: () => guard, config: { fill_wait_ms: 500 } });
  autoFill(ctx, 6001);

  const order = await ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 2 });

  const body = lastBody(ctx);
  assert.deepEqual({ ...body, customTag: undefined }, {
    accountId: 7,
    contractId: MES,
    type: ORDER_TYPE.MARKET,
    side: ORDER_SIDE.BUY,
    size: 2,
    limitPrice: null,
    stopPrice: null,
    trailPrice: null,
    customTag: undefined,
  });
  assert.match(body.customTag, /^ft-en-[0-9a-z]+$/);
  assert.equal('stopLossBracket' in body, false);
  assert.deepEqual(guard.calls, [{ root: 'MES', contracts: 2, legs: [] }]);

  assert.equal(order.status, 'closed');
  assert.equal(order.symbol, 'MES/USD:USD');
  assert.equal(order.type, 'market');
  assert.equal(order.side, 'buy');
  assert.equal(order.amount, 2);
  assert.equal(order.filled, 2);
  assert.equal(order.average, 6001);
  assert.equal(order.cost, 6001 * 2 * 5);
  assert.equal(order.reduceOnly, false);
  assert.equal(order.fee.cost, 0.62);
  assert.equal(order.trades.length, 1);
});

test('place: limit, stop and stop_limit map to ProjectX types and snap prices to the tick', async () => {
  const ctx = makeRouter({ guard: () => stubGuard() });
  ctx.user.waitForFinal = async () => null;
  const place = (args) => ctx.router.place({ symbol: 'MES/USD:USD', side: 'buy', amount: 1, ...args });

  await place({ type: 'limit', price: 6000.1 });
  assert.equal(lastBody(ctx).type, ORDER_TYPE.LIMIT);
  assert.equal(lastBody(ctx).limitPrice, 6000);
  assert.equal(lastBody(ctx).stopPrice, null);

  await place({ type: 'stop', params: { stopPrice: 5990.1 } });
  assert.equal(lastBody(ctx).type, ORDER_TYPE.STOP);
  assert.equal(lastBody(ctx).stopPrice, 5990);
  assert.equal(lastBody(ctx).limitPrice, null);

  await place({ type: 'market', params: { stopPrice: 5990.1 } });
  assert.equal(lastBody(ctx).type, ORDER_TYPE.STOP, 'market + stopPrice is a stop order');

  await place({ type: 'stop_limit', price: 6000, params: { stopPrice: 5999.9 } });
  assert.equal(lastBody(ctx).type, ORDER_TYPE.STOP_LIMIT);
  assert.equal(lastBody(ctx).limitPrice, 6000);
  assert.equal(lastBody(ctx).stopPrice, 6000);

  await place({ type: 'limit', price: 6001, params: { triggerPrice: 6002 } });
  assert.equal(lastBody(ctx).type, ORDER_TYPE.STOP_LIMIT, 'limit + trigger is a stop-limit order');

  await rejects(place({ type: 'limit' }), { kind: 'InvalidOrder', match: /needs a price/ });
  await rejects(place({ type: 'stop' }), { kind: 'InvalidOrder', match: /needs stopPrice/ });
  await rejects(place({ type: 'iceberg' }), { kind: 'InvalidOrder', match: /Unsupported order type/ });
  assert.equal(ctx.client.callsOf('placeOrder').length, 5);
});

test('place: a working limit order is returned open after the short wait', async () => {
  const ctx = makeRouter({ guard: () => stubGuard() });
  const order = await ctx.router.place({ symbol: 'MES/USD:USD', type: 'limit', side: 'sell', amount: 1, price: 6100 });
  assert.equal(order.status, 'open');
  assert.equal(order.side, 'sell');
  assert.equal(order.price, 6100);
  assert.equal(order.remaining, 1);
  assert.equal(order.average, null);
});

test('place: unknown symbol is a 404 BadSymbol', async () => {
  const ctx = makeRouter();
  await rejects(ctx.router.place({ symbol: 'ZZ/USD:USD', type: 'market', side: 'buy', amount: 1 }), { kind: 'BadSymbol', status: 404 });
  assert.equal(ctx.client.callsOf('placeOrder').length, 0);
});

test('place: no selected account is a 503 AuthenticationError', async () => {
  const ctx = makeRouter();
  ctx.user.account = null;
  ctx.user.accountError = 'No ProjectX account can trade.';
  await rejects(ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 1 }), {
    kind: 'AuthenticationError', status: 503, match: /No ProjectX account/,
  });
});

test('place: sizes must be positive whole numbers within max_order_size', async () => {
  const ctx = makeRouter({ guard: () => stubGuard(), config: { max_order_size: 5 } });
  for (const amount of [1.5, 0, -1, 'abc', undefined, 6]) {
    await rejects(ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount }), { kind: 'InvalidOrder', status: 400 });
  }
  assert.equal(ctx.client.callsOf('placeOrder').length, 0);
  autoFill(ctx, 6000);
  await ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: '5' });
  assert.equal(lastBody(ctx).size, 5, 'numeric strings are accepted');
});

test('place: entries are refused when account protection says no, exits are not asked', async () => {
  const guard = stubGuard({ ok: false, reason: 'day_locked: dll_hard' });
  const ctx = makeRouter({ guard: () => guard });

  await rejects(ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 1 }), {
    kind: 'InvalidOrder', match: /Refused by account protection: day_locked: dll_hard/,
  });
  assert.equal(ctx.client.callsOf('placeOrder').length, 0);

  ctx.user.onPosition(position('MES', { side: 'long', size: 2 }));
  guard.calls.length = 0;
  await ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'sell', amount: 1, params: { reduceOnly: true } });
  assert.equal(guard.calls.length, 0, 'reduceOnly never consults canEnter');
  assert.equal(ctx.client.callsOf('placeOrder').length, 1);
});

test('place: an entry that would offset an open position is refused', async () => {
  const ctx = makeRouter({ guard: () => stubGuard() });
  ctx.user.onPosition(position('MES', { side: 'long', size: 2 }));
  await rejects(ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'sell', amount: 1 }), {
    kind: 'InvalidOrder', match: /would offset the open MES position/,
  });
  assert.equal(ctx.client.callsOf('placeOrder').length, 0);
});

test('place: an entry in the position direction goes to the contract already held', async () => {
  const ctx = makeRouter({ guard: () => stubGuard() });
  const held = { ...position('MES', { side: 'long', size: 2 }), contractId: 'CON.F.US.MES.H26' };
  ctx.user.onPosition(held);
  await ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 1 });
  assert.equal(lastBody(ctx).contractId, 'CON.F.US.MES.H26');
  assert.match(lastBody(ctx).customTag, /^ft-en-/);
});

test('place: reduceOnly is clamped to the position and tagged ft-ex- (ft-sl- for stops)', async () => {
  const ctx = makeRouter();
  ctx.user.waitForFinal = async () => null;
  const held = { ...position('MES', { side: 'long', size: 3 }), contractId: 'CON.F.US.MES.H26' };
  ctx.user.onPosition(held);

  await ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'sell', amount: 5, params: { reduceOnly: true } });
  let body = lastBody(ctx);
  assert.equal(body.size, 3, 'clamped to the open size');
  assert.equal(body.contractId, 'CON.F.US.MES.H26', 'goes to the contract the position is in');
  assert.equal(body.side, ORDER_SIDE.SELL);
  assert.match(body.customTag, /^ft-ex-/);

  await ctx.router.place({ symbol: 'MES/USD:USD', type: 'stop', side: 'sell', amount: 2, price: 5990, params: { reduceOnly: 'true', stopPrice: 5990 } });
  body = lastBody(ctx);
  assert.equal(body.size, 2);
  assert.equal(body.type, ORDER_TYPE.STOP);
  assert.match(body.customTag, /^ft-sl-/);

  await ctx.router.place({ symbol: 'MES/USD:USD', type: 'limit', side: 'sell', amount: 1, price: 6100, params: { reduceOnly: true } });
  assert.match(lastBody(ctx).customTag, /^ft-ex-/);
});

test('place: reduceOnly waits for a position event that trails the entry fill', async () => {
  const ctx = makeRouter();
  ctx.user.waitForFinal = async () => null;
  setTimeout(() => ctx.user.onPosition(position('MES', { side: 'short', size: 1 })), 120);
  const order = await ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 1, params: { reduceOnly: true } });
  assert.equal(order.side, 'buy');
  assert.equal(lastBody(ctx).side, ORDER_SIDE.BUY);
  assert.equal(ctx.client.callsOf('searchOpenPositions').length, 0, 'no REST call needed when the event arrives in time');
});

test('place: reduceOnly with nothing to reduce asks REST once, then fails InvalidOrder', async () => {
  const ctx = makeRouter();
  await rejects(ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'sell', amount: 1, params: { reduceOnly: true } }), {
    kind: 'InvalidOrder', match: /No long MES position to reduce/,
  });
  assert.equal(ctx.client.callsOf('searchOpenPositions').length, 1);

  ctx.user.onPosition(position('MES', { side: 'long', size: 1 }));
  await rejects(ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 1, params: { reduceOnly: true } }), {
    kind: 'InvalidOrder', match: /No short MES position to reduce/,
  });
  assert.equal(ctx.client.callsOf('placeOrder').length, 0);
});

test('place: native brackets add stopLossBracket.ticks from max_risk_per_trade, separate does not', async () => {
  const native = makeRouter({ guard: () => stubGuard({ maxRisk: 250 }), config: { brackets: 'native' } });
  native.user.waitForFinal = async () => null;
  await native.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 2 });
  // floor(250 / (2 contracts * $1.25 per tick)) = 100 ticks
  assert.deepEqual(lastBody(native).stopLossBracket, { ticks: 100, type: ORDER_TYPE.STOP });

  const noRisk = makeRouter({ guard: () => stubGuard({ maxRisk: null }), config: { brackets: 'native' } });
  noRisk.user.waitForFinal = async () => null;
  await noRisk.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 1 });
  assert.equal('stopLossBracket' in lastBody(noRisk), false);

  const tooSmall = makeRouter({ guard: () => stubGuard({ maxRisk: 2 }), config: { brackets: 'native' } });
  tooSmall.user.waitForFinal = async () => null;
  await tooSmall.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 2 });
  assert.equal('stopLossBracket' in lastBody(tooSmall), false, 'under one tick of risk gets no bracket');

  const separate = makeRouter({ guard: () => stubGuard() });
  separate.user.waitForFinal = async () => null;
  await separate.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 1 });
  assert.equal('stopLossBracket' in lastBody(separate), false);

  native.user.onPosition(position('MES', { side: 'long', size: 2 }));
  await native.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'sell', amount: 1, params: { reduceOnly: true } });
  assert.equal('stopLossBracket' in lastBody(native), false, 'exits never carry a bracket');
});

/* --------------------------------------------------------------- submit -- */

test('submit: a timeout is resolved by looking the order up by its customTag', async () => {
  const ctx = makeRouter();
  ctx.client.fail.placeOrder = new GatewayError('timed out', { status: 504, kind: 'RequestTimeout' });
  const body = { accountId: 7, contractId: MES, customTag: 'ft-en-abc' };
  ctx.client.orderRows = [orderRow('MES', { id: 41, customTag: 'other' }), orderRow('MES', { id: 42, customTag: 'ft-en-abc' })];

  const before = Date.now();
  const id = await ctx.router.submit(body);

  assert.equal(id, 42);
  assert.equal(ctx.user.orders.get(42).customTag, 'ft-en-abc', 'the found order is fed into the user state');
  const [search] = ctx.client.callsOf('searchOrders');
  assert.equal(search.accountId, 7);
  assert.ok(Math.abs(search.start - (before - 5 * 60 * 1000)) < 2000, 'looks back five minutes');
  assert.equal(ctx.client.callsOf('placeOrder').length, 1, 'never retries the placement');
});

test('submit: NetworkError is recovered the same way', async () => {
  const ctx = makeRouter();
  ctx.client.fail.placeOrder = new GatewayError('reset', { status: 504, kind: 'NetworkError' });
  ctx.client.orderRows = [orderRow('MES', { id: 9, customTag: 'ft-en-n' })];
  assert.equal(await ctx.router.submit({ accountId: 7, customTag: 'ft-en-n' }), 9);
});

test('submit: when the tag is not found the original timeout is rethrown', async () => {
  const ctx = makeRouter();
  const timeout = new GatewayError('timed out', { status: 504, kind: 'RequestTimeout' });
  ctx.client.fail.placeOrder = timeout;
  ctx.client.orderRows = [orderRow('MES', { id: 1, customTag: 'someone-else' })];
  await assert.rejects(ctx.router.submit({ accountId: 7, customTag: 'ft-en-missing' }), (err) => err === timeout);
});

test('submit: a failing lookup still reports the original error', async () => {
  const ctx = makeRouter();
  const timeout = new GatewayError('timed out', { status: 504, kind: 'RequestTimeout' });
  ctx.client.fail.placeOrder = timeout;
  ctx.client.fail.searchOrders = new Error('lookup down');
  await assert.rejects(ctx.router.submit({ accountId: 7, customTag: 'ft-en-x' }), (err) => err === timeout);
});

test('submit: other errors are not looked up and propagate unchanged', async () => {
  const ctx = makeRouter();
  const rejected = new GatewayError('rejected', { status: 400, kind: 'InvalidOrder' });
  ctx.client.fail.placeOrder = rejected;
  await assert.rejects(ctx.router.submit({ accountId: 7, customTag: 'ft-en-x' }), (err) => err === rejected);
  assert.equal(ctx.client.callsOf('searchOrders').length, 0);
});

test('place: a timeout recovered by tag returns the existing order, not a duplicate', async () => {
  const ctx = makeRouter({ guard: () => stubGuard() });
  ctx.client.fail.placeOrder = new GatewayError('timed out', { status: 504, kind: 'RequestTimeout' });
  ctx.client.searchOrders = async () => [orderRow('MES', { id: 77, customTag: lastBody(ctx).customTag, type: ORDER_TYPE.MARKET, status: ORDER_STATUS.FILLED, fillVolume: 1, filledPrice: 6003 })];
  const order = await ctx.router.place({ symbol: 'MES/USD:USD', type: 'market', side: 'buy', amount: 1 });
  assert.equal(order.id, '77');
  assert.equal(order.status, 'closed');
  assert.equal(order.average, 6003);
  assert.equal(ctx.client.callsOf('placeOrder').length, 1);
});

/* ------------------------------------------------------- cancel / modify -- */

test('cancel: a working order is cancelled and the final state is returned', async () => {
  const ctx = makeRouter();
  ctx.user.onOrder(orderRow('MES', { id: 60 }));
  ctx.client.cancelOrder = async (accountId, orderId) => {
    ctx.client.calls.push({ name: 'cancelOrder', args: { accountId, orderId } });
    setImmediate(() => ctx.user.onOrder({ id: orderId, status: ORDER_STATUS.CANCELLED }));
    return { success: true };
  };
  const order = await ctx.router.cancel('60');
  assert.deepEqual(ctx.client.callsOf('cancelOrder'), [{ accountId: 7, orderId: 60 }]);
  assert.equal(order.status, 'canceled');
  assert.equal(order.id, '60');
});

test('cancel: an order that is already final is returned without a cancel call', async () => {
  const ctx = makeRouter();
  ctx.user.onOrder(orderRow('MES', { id: 61, status: ORDER_STATUS.FILLED, fillVolume: 1, filledPrice: 6000 }));
  const order = await ctx.router.cancel(61);
  assert.equal(order.status, 'closed');
  assert.equal(ctx.client.callsOf('cancelOrder').length, 0);
});

test('cancel: if the cancel call fails but the order is final on lookup, that is not an error', async () => {
  const ctx = makeRouter();
  ctx.user.onOrder(orderRow('MES', { id: 62 }));
  ctx.client.fail.cancelOrder = new GatewayError('too late', { status: 400, kind: 'ExchangeError' });
  ctx.client.orderRows = [orderRow('MES', { id: 62, status: ORDER_STATUS.FILLED, fillVolume: 1, filledPrice: 6000 })];
  const order = await ctx.router.cancel(62);
  assert.equal(order.status, 'closed');
});

test('cancel: if the cancel call fails and the order is still working, the error propagates', async () => {
  const ctx = makeRouter();
  ctx.user.onOrder(orderRow('MES', { id: 63 }));
  const failure = new GatewayError('refused', { status: 400, kind: 'ExchangeError' });
  ctx.client.fail.cancelOrder = failure;
  ctx.client.orderRows = [orderRow('MES', { id: 63 })];
  await assert.rejects(ctx.router.cancel(63), (err) => err === failure);
});

test('cancel and modify: an unknown order is 404 OrderNotFound after searching 1 and 7 days', async () => {
  const ctx = makeRouter();
  await rejects(ctx.router.cancel(999), { kind: 'OrderNotFound', status: 404 });
  assert.equal(ctx.client.callsOf('searchOrders').length, 2);
  await rejects(ctx.router.modify(999, { price: 1 }), { kind: 'OrderNotFound', status: 404 });
});

test('modify: prices snap to the tick and only given fields are sent', async () => {
  const ctx = makeRouter();
  ctx.user.onOrder(orderRow('MES', { id: 70, type: ORDER_TYPE.STOP_LIMIT, limitPrice: 6000, stopPrice: 6001 }));

  const order = await ctx.router.modify('70', { amount: 2, price: 6000.1, stopPrice: 5990.12 });
  assert.deepEqual(ctx.client.callsOf('modifyOrder'), [{ accountId: 7, orderId: 70, size: 2, limitPrice: 6000, stopPrice: 5990 }]);
  assert.equal(order.id, '70');

  await ctx.router.modify(70, { price: 6002.9 });
  assert.deepEqual(ctx.client.callsOf('modifyOrder')[1], { accountId: 7, orderId: 70, limitPrice: 6003 });
});

/* ------------------------------------------------------------- getOrder -- */

test('getOrder: served from the user state without a REST call', async () => {
  const ctx = makeRouter();
  ctx.user.onOrder(orderRow('MES', { id: 80 }));
  const order = await ctx.router.getOrder('80');
  assert.equal(order.id, '80');
  assert.equal(ctx.client.callsOf('searchOrders').length, 0);
});

test('getOrder: a cache miss falls back to REST, a second miss is 404', async () => {
  const ctx = makeRouter();
  ctx.client.orderRows = [orderRow('MES', { id: 81, status: ORDER_STATUS.CANCELLED })];
  const order = await ctx.router.getOrder(81);
  assert.equal(order.status, 'canceled');
  assert.ok(ctx.user.orders.has(81), 'looked-up orders are cached');

  await rejects(ctx.router.getOrder(404), { kind: 'OrderNotFound', status: 404, match: /Order 404 not found/ });
});

/* ------------------------------------------------------------ positions -- */

test('positions: long and short are shaped with point value, mark and unrealized P&L', () => {
  const ctx = makeRouter({ marks: { MES: 6010 } });
  ctx.user.onPosition(position('MES', { side: 'long', size: 3, price: 6000, id: 1 }));
  ctx.user.onPosition(position('ES', { side: 'short', size: 2, price: 6020, id: 2 }));
  const out = ctx.router.positions([]);
  assert.equal(out.length, 2);

  const long = out.find((p) => p.symbol === 'MES/USD:USD');
  assert.equal(long.side, 'long');
  assert.equal(long.contracts, 3);
  assert.equal(long.contractSize, 5);
  assert.equal(long.entryPrice, 6000);
  assert.equal(long.markPrice, 6010);
  assert.equal(long.notional, 3 * 5 * 6010);
  assert.equal(long.unrealizedPnl, (6010 - 6000) * 3 * 5);
  assert.equal(long.id, '1');
  assert.equal(long.marginMode, 'isolated');

  ctx.marks.MES = 5990;
  assert.equal(ctx.router.positions(['MES/USD:USD'])[0].unrealizedPnl, (5990 - 6000) * 3 * 5);
});

test('positions: shorts earn when the mark falls, and a missing mark leaves price fields null', () => {
  const ctx = makeRouter({ marks: { MES: 5990 } });
  ctx.user.onPosition(position('MES', { side: 'short', size: 2, price: 6000 }));
  const [short] = ctx.router.positions();
  assert.equal(short.side, 'short');
  assert.equal(short.unrealizedPnl, (5990 - 6000) * 2 * 5 * -1);

  delete ctx.marks.MES;
  const [blind] = ctx.router.positions();
  assert.equal(blind.markPrice, null);
  assert.equal(blind.notional, null);
  assert.equal(blind.unrealizedPnl, null);
  assert.equal(blind.entryPrice, 6000);
});

test('positions: the symbols filter limits the result', () => {
  const ctx = makeRouter({ marks: { MES: 6000, ES: 6000 } });
  ctx.user.onPosition(position('MES', { size: 1, id: 1 }));
  ctx.user.onPosition(position('ES', { size: 1, id: 2 }));
  assert.deepEqual(ctx.router.positions(['ES/USD:USD']).map((p) => p.symbol), ['ES/USD:USD']);
  assert.equal(ctx.router.positions().length, 2);
});

test('closePosition: closes the contract held, reports when there is none', async () => {
  const ctx = makeRouter();
  assert.deepEqual(await ctx.router.closePosition('MES/USD:USD'), { closed: false, reason: 'no position' });
  ctx.user.onPosition(position('MES', { size: 2 }));
  assert.deepEqual(await ctx.router.closePosition('MES/USD:USD'), { closed: true, contractId: MES });
  assert.deepEqual(ctx.client.callsOf('closeContract'), [{ accountId: 7, contractId: MES }]);
});

/* ------------------------------------------------------------ order shape -- */

test('toCcxtOrder: ProjectX statuses map to ccxt statuses', () => {
  const { router } = makeRouter();
  const expected = { 0: 'open', 1: 'open', 2: 'closed', 3: 'canceled', 4: 'expired', 5: 'rejected', 6: 'open' };
  for (const [status, ccxt] of Object.entries(expected)) {
    assert.equal(router.toCcxtOrder(orderRow('MES', { status: Number(status) })).status, ccxt, `status ${status}`);
  }
  assert.equal(router.toCcxtOrder(orderRow('MES', { status: 42 })).status, 'open', 'unknown statuses stay open');
});

test('toCcxtOrder: ProjectX order types map to ccxt types', () => {
  const { router } = makeRouter();
  const expected = { 1: 'limit', 2: 'market', 3: 'stop_limit', 4: 'stop', 5: 'trailing_stop', 6: 'limit', 7: 'limit' };
  for (const [type, ccxt] of Object.entries(expected)) {
    assert.equal(router.toCcxtOrder(orderRow('MES', { type: Number(type) })).type, ccxt, `type ${type}`);
  }
});

test('toCcxtOrder: fee is the sum of fees and commissions over the order fills', () => {
  const { router, user } = makeRouter();
  user.onOrder(orderRow('MES', { id: 5, size: 3, status: ORDER_STATUS.FILLED, fillVolume: 3, filledPrice: 6001 }));
  user.onTrade(tradeRow('MES', { id: 1, orderId: 5, size: 1, price: 6000, fees: 0.37, commissions: 0.25 }));
  user.onTrade(tradeRow('MES', { id: 2, orderId: 5, size: 2, price: 6002, fees: 0.74, commissions: 0.5 }));
  user.onTrade(tradeRow('MES', { id: 3, orderId: 5, size: 1, price: 1, fees: 99, commissions: 99, voided: true }));
  user.onTrade(tradeRow('MES', { id: 4, orderId: 6, size: 1, price: 1, fees: 99, commissions: 99 }));

  const order = router.toCcxtOrder(user.orders.get(5));
  assert.equal(order.trades.length, 2);
  assert.ok(Math.abs(order.fee.cost - 1.86) < 1e-9);
  assert.equal(order.fee.currency, 'USD');
  assert.equal(order.average, 6001, 'the order filledPrice wins over the fill average');
  assert.equal(order.cost, 6001 * 3 * 5);
  assert.equal(order.remaining, 0);
});

test('toCcxtOrder: average falls back to the volume-weighted fills, fee is absent without fills', () => {
  const { router, user } = makeRouter();
  user.onTrade(tradeRow('MES', { id: 1, orderId: 5, size: 1, price: 6000 }));
  user.onTrade(tradeRow('MES', { id: 2, orderId: 5, size: 3, price: 6004 }));
  const filled = router.toCcxtOrder(orderRow('MES', { id: 5, size: 4, status: ORDER_STATUS.FILLED, fillVolume: 0, filledPrice: null }));
  assert.equal(filled.filled, 4, 'filled falls back to the fills size');
  assert.equal(filled.average, 6003);

  const bare = router.toCcxtOrder(orderRow('MES', { id: 6, size: 2, fillVolume: 1 }));
  assert.equal(bare.fee, undefined);
  assert.equal(bare.average, null);
  assert.equal(bare.remaining, 1, 'open orders report amount - filled');
  assert.equal(bare.cost, 0);
});

test('toCcxtOrder: tags drive reduceOnly and stop prices are exposed', () => {
  const { router } = makeRouter();
  const stop = router.toCcxtOrder(orderRow('MES', { type: ORDER_TYPE.STOP, side: ORDER_SIDE.SELL, limitPrice: null, stopPrice: 5990, customTag: 'ft-sl-1' }));
  assert.equal(stop.reduceOnly, true);
  assert.equal(stop.stopPrice, 5990);
  assert.equal(stop.triggerPrice, 5990);
  assert.equal(stop.price, 5990);
  assert.equal(stop.clientOrderId, 'ft-sl-1');
  assert.equal(router.toCcxtOrder(orderRow('MES', { customTag: 'ft-ex-1' })).reduceOnly, true);
  assert.equal(router.toCcxtOrder(orderRow('MES', { customTag: 'ft-en-1' })).reduceOnly, false);
  assert.equal(router.toCcxtOrder(orderRow('MES', { customTag: null })).clientOrderId, null);
});

/* ------------------------------------------------------- lists and trades -- */

test('openOrders: only non-final orders, filtered by symbol', () => {
  const ctx = makeRouter();
  ctx.user.onOrder(orderRow('MES', { id: 1 }));
  ctx.user.onOrder(orderRow('ES', { id: 2 }));
  ctx.user.onOrder(orderRow('MES', { id: 3, status: ORDER_STATUS.FILLED }));
  assert.deepEqual(ctx.router.openOrders().map((o) => o.id).sort(), ['1', '2']);
  assert.deepEqual(ctx.router.openOrders('MES/USD:USD').map((o) => o.id), ['1']);
});

test('orders(since): a recent window is served from state, an old one asks REST first', async () => {
  const ctx = makeRouter();
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const recent = new Date(Date.now() - 3600 * 1000).toISOString();
  ctx.user.onOrder(orderRow('MES', { id: 1, creationTimestamp: recent }));
  ctx.client.orderRows = [orderRow('MES', { id: 2, creationTimestamp: old }), orderRow('ES', { id: 3, creationTimestamp: old })];

  const fresh = await ctx.router.orders('MES/USD:USD', Date.now() - 2 * 3600 * 1000);
  assert.deepEqual(fresh.map((o) => o.id), ['1']);
  assert.equal(ctx.client.callsOf('searchOrders').length, 0);

  const since = Date.now() - 4 * 24 * 3600 * 1000;
  const all = await ctx.router.orders('MES/USD:USD', since);
  assert.equal(ctx.client.callsOf('searchOrders')[0].start, since);
  assert.deepEqual(all.map((o) => o.id), ['2', '1'], 'oldest first, other symbols excluded');
});

test('myTrades: voided fills are dropped, symbol and since filter apply, oldest first', () => {
  const ctx = makeRouter();
  const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  ctx.user.onTrade(tradeRow('MES', { id: 1, creationTimestamp: at(30) }));
  ctx.user.onTrade(tradeRow('MES', { id: 2, creationTimestamp: at(10) }));
  ctx.user.onTrade(tradeRow('MES', { id: 3, creationTimestamp: at(5), voided: true }));
  ctx.user.onTrade(tradeRow('ES', { id: 4, creationTimestamp: at(5) }));
  assert.deepEqual(ctx.router.myTrades('MES/USD:USD').map((t) => t.id), ['1', '2']);
  assert.deepEqual(ctx.router.myTrades('MES/USD:USD', Date.now() - 20 * 60_000).map((t) => t.id), ['2']);
  const [trade] = ctx.router.myTrades('MES/USD:USD', Date.now() - 20 * 60_000);
  assert.equal(trade.cost, 6000 * 1 * 5);
  assert.equal(trade.order, '500');
  assert.equal(trade.fee.cost, 0.62);
});

test('balance: the Express Funded account size is added as a sizing offset, other kinds are not', async () => {
  const xfa = makeRouter();
  xfa.user.account = { id: 7, name: '50KXFA-1', balance: 0, kind: 'XFA', sizeUsd: 50000 };
  assert.equal(xfa.router.balance('USD').total.USD, 50000);
  assert.equal(xfa.router.balance('USD').info.balanceOffset, 50000);

  const tc = makeRouter();
  assert.equal(tc.router.balance('USD').USD.total, 50000);
  assert.equal(tc.router.balance('USD').info.balanceOffset, 0);

  const fixed = makeRouter({ config: { balance_offset: 1000 } });
  assert.equal(fixed.router.balance('USD').USD.total, 51000);

  const labsAccount = { id: 27790619, name: '6KCHCR-LABS005-V2-684000-69917404', balance: 1446, kind: 'LABS', sizeUsd: 6000 };
  const labs = makeRouter();
  labs.user.account = { ...labsAccount };
  assert.equal(labs.router.balance('USD').total.USD, 7446, 'a Labs balance is profit only, so the size is added');
  assert.equal(labs.router.balance('USD').info.balanceOffset, 6000);
  const labsOff = makeRouter({ config: { balance_offset: 0 } });
  labsOff.user.account = { ...labsAccount };
  assert.equal(labsOff.router.balance('USD').total.USD, 1446);
  assert.equal(labsOff.router.balance('USD').info.balanceOffset, 0);

  const none = makeRouter();
  none.user.account = null;
  assert.throws(() => none.router.balance('USD'), (err) => err.kind === 'ExchangeNotAvailable' && err.status === 503);
  await sleep(0);
});
