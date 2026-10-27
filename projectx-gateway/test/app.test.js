import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { makeMockApp, waitFor } from './helpers.js';

let env;

before(async () => {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    env = await makeMockApp();
  } finally {
    console.log = log;
    console.warn = warn;
  }
});

after(async () => {
  await env?.stop();
});

const MES = 'MES/USD:USD';
const buy = (amount, symbol = MES) => ({ symbol, type: 'market', side: 'buy', amount });

test('/health reports ready on the mock upstream, without needing the secret', async () => {
  const res = await env.get('/health', { secret: null });
  assert.equal(res.status, 200);
  const { marketHubAgeMs, userHubAgeMs, ...rest } = res.body;
  assert.deepEqual(rest, {
    ok: true, ready: true, mock: true, marketHub: 'connected', userHub: 'connected', dataHealth: { ok: true, reasons: [] }, startError: null,
  });
  for (const age of [marketHubAgeMs, userHubAgeMs]) assert.ok(age === null || age >= 0, 'hub message age is exposed');
});

test('/status exposes hub states, message ages, reconcile age and data health', async () => {
  const res = await env.get('/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.marketHub.state, 'connected');
  assert.ok(res.body.marketHub.stateSince > 0);
  assert.ok('ageMs' in res.body.marketHub && 'lastMessageAt' in res.body.marketHub);
  assert.equal(res.body.userHub.state, 'connected');
  assert.ok(res.body.userHub.reconcileAgeMs >= 0);
  assert.deepEqual(res.body.dataHealth, { ok: true, reasons: [] });
});

test('the user stream prunes only once the guard has rebuilt its history', () => {
  assert.equal(env.app.user.pruneArmed, true);
  assert.deepEqual(env.app.user.retention, { orders_days: 2, trades_days: 14 });
});

test('data health reports a stale quote and the guard blocks entries on it', async () => {
  const { app } = env;
  app.market.quoteSince = () => Date.now() - 20_000;
  try {
    const health = app.dataHealth();
    assert.equal(health.ok, false);
    assert.equal(health.reasons[0].code, 'quote_stale');
    assert.equal(health.reasons[0].root, 'MES');
    assert.ok(health.reasons[0].ageSecs >= 20);
    const verdict = app.evaluateGuard();
    // On a weekend or after flat_by the market is shut and quote staleness is not counted.
    if (!app.guard.sessionClosed(Date.now())) {
      assert.equal(verdict.canEnter, false);
      assert.ok(verdict.reasons.some((r) => r.code === 'data_stale'));
    }
  } finally {
    delete app.market.quoteSince;
  }
  assert.equal(app.evaluateGuard().reasons.some((r) => r.code === 'data_stale'), false, 'recovers when quotes are fresh');
});

test('other routes need the X-Gateway-Secret', async () => {
  assert.equal((await env.get('/status', { secret: null })).status, 401);
  assert.equal((await env.post('/order', buy(1), { secret: 'bad' })).status, 401);
});

test('/markets lists the mock front contracts including MES', async () => {
  const res = await env.get('/markets');
  assert.equal(res.status, 200);
  const mes = res.body.find((m) => m.symbol === MES);
  assert.ok(mes, 'MES is listed');
  assert.equal(mes.root, 'MES');
  assert.equal(mes.tickSize, 0.25);
  assert.equal(mes.tickValue, 1.25);
  assert.equal(mes.contractSize, 5);
  assert.equal(mes.contractId, 'CON.F.US.MES.Z26');
  assert.ok(res.body.length >= 10, 'every mock contract is listed, not only the whitelist');
});

test('the account and guard come up from the mock account name', async () => {
  const guard = await env.get('/guard');
  assert.equal(guard.status, 200);
  assert.equal(guard.body.status, 'active');
  assert.equal(guard.body.canEnter, true);
  assert.equal(guard.body.flatten, false);
  assert.deepEqual(guard.body.reasons, []);
  assert.equal(guard.body.phase, 'evaluation');
  assert.equal(guard.body.metrics.startBalance, 50000);
  assert.equal(guard.body.metrics.dailyLossLimit, 1000);
  assert.equal(guard.body.metrics.maxMiniEquivalent, 5);
  assert.equal(guard.body.metrics.profitTarget, 3000);
  for (const key of ['tradingDay', 'sessionStart', 'eodTs', 'at', 'flattenReasons']) assert.ok(key in guard.body, key);

  const balance = await env.get('/balance');
  assert.equal(balance.body.USD.total, 50000);
});

test('a market buy over HTTP fills, shows in /positions and moves the guard exposure', async () => {
  const placed = await env.post('/order', buy(1));
  assert.equal(placed.status, 200);
  const order = placed.body;
  assert.equal(order.status, 'closed');
  assert.equal(order.symbol, MES);
  assert.equal(order.side, 'buy');
  assert.equal(order.type, 'market');
  assert.equal(order.filled, 1);
  assert.ok(order.average > 0, 'closed with an average price');
  assert.match(order.clientOrderId, /^ft-en-/);
  assert.equal(order.fee.cost, 0.37 + 0.25);
  assert.equal(order.reduceOnly, false);

  const positions = await waitFor(async () => {
    const res = await env.get('/positions');
    return res.body.length && res.body[0].markPrice > 0 ? res.body : null;
  });
  assert.equal(positions.length, 1);
  assert.equal(positions[0].symbol, MES);
  assert.equal(positions[0].side, 'long');
  assert.equal(positions[0].contracts, 1);
  assert.equal(positions[0].entryPrice, order.average);
  assert.ok(positions[0].markPrice > 0, 'the mock market stream supplies a mark');

  const guard = await waitFor(async () => {
    const res = await env.get('/guard');
    return res.body.metrics.exposureMini === 0.1 ? res.body : null;
  });
  assert.equal(guard.canEnter, true);
  assert.equal(guard.metrics.entriesToday, 1);

  const fetched = await env.get(`/order/${order.id}`);
  assert.equal(fetched.body.id, order.id);
  assert.equal(fetched.body.status, 'closed');
  assert.deepEqual((await env.get('/orders/open')).body, []);
});

test('an entry in the opposite direction is refused while a position is open', async () => {
  const res = await env.post('/order', { symbol: MES, type: 'market', side: 'sell', amount: 1 });
  assert.equal(res.status, 400);
  assert.equal(res.body.kind, 'InvalidOrder');
  assert.match(res.body.error, /would offset/);
});

test('an entry beyond the mini-equivalent cap is refused by the guard', async () => {
  const res = await env.post('/order', buy(6, 'NQ/USD:USD'));
  assert.equal(res.status, 400);
  assert.equal(res.body.kind, 'InvalidOrder');
  assert.match(res.body.error, /Refused by account protection: contract limit/);

  const oversize = await env.post('/order', buy(51));
  assert.equal(oversize.status, 400);
  assert.match(oversize.body.error, /exceeds max_order_size 50/);
});

test('/ticker and /ohlcv are served from the mock market data', async () => {
  const ticker = await waitFor(async () => {
    const res = await env.get(`/ticker?symbol=${MES}`);
    return res.status === 200 && res.body.last > 0 ? res.body : null;
  });
  assert.equal(ticker.symbol, MES);
  assert.ok(ticker.bid > 0 && ticker.ask >= ticker.bid);

  const bars = await env.get(`/ohlcv?symbol=${MES}&timeframe=1m&limit=5`);
  assert.equal(bars.status, 200);
  assert.ok(bars.body.length > 0 && bars.body.length <= 5);
  assert.equal(bars.body[0].length, 6);

  const unknown = await env.get('/ticker?symbol=NOPE/USD:USD');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.kind, 'BadSymbol');
});

test('a reduceOnly sell closes the position and the fills are listed', async () => {
  const res = await env.post('/order', { symbol: MES, type: 'market', side: 'sell', amount: 1, params: { reduceOnly: true } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'closed');
  assert.equal(res.body.side, 'sell');
  assert.ok(res.body.average > 0);
  assert.match(res.body.clientOrderId, /^ft-ex-/);
  assert.equal(res.body.reduceOnly, true);

  await waitFor(async () => (await env.get('/positions')).body.length === 0);

  const trades = (await env.get(`/mytrades?symbol=${MES}`)).body;
  assert.equal(trades.length, 2);
  assert.deepEqual(trades.map((t) => t.side), ['buy', 'sell']);

  const closedOrders = (await env.get(`/orders?symbol=${MES}`)).body;
  assert.equal(closedOrders.length, 2);

  const guard = await waitFor(async () => {
    const g = await env.get('/guard');
    return g.body.metrics.exposureMini === 0 ? g.body : null;
  });
  assert.equal(guard.metrics.entriesToday, 1);
});

test('reduceOnly with no position is InvalidOrder', async () => {
  const res = await env.post('/order', { symbol: MES, type: 'market', side: 'sell', amount: 1, params: { reduceOnly: true } });
  assert.equal(res.status, 400);
  assert.equal(res.body.kind, 'InvalidOrder');
});

test('a reduce-only stop already through the market fills on placement, and a second one is refused', async () => {
  const entry = await env.post('/order', { symbol: MES, type: 'market', side: 'sell', amount: 1 });
  assert.equal(entry.status, 200);
  assert.equal(entry.body.status, 'closed');
  await waitFor(async () => (await env.get('/positions')).body.some((p) => p.side === 'short'));

  const last = env.app.client.exchange.price('MES');
  // 10 ticks below last: through the market for a buy stop (the mock's noise is +-2 ticks per second).
  const stopPrice = Math.round((last - 2.5) / 0.25) * 0.25;
  const stop = await env.post('/order', { symbol: MES, type: 'stop', side: 'buy', amount: 1, price: null, params: { stopPrice, reduceOnly: true } });
  assert.equal(stop.status, 200);
  assert.equal(stop.body.status, 'closed', 'POST /order answers with the fill');
  assert.equal(stop.body.filled, 1);

  await waitFor(async () => (await env.get('/positions')).body.length === 0);
  const again = await env.post('/order', { symbol: MES, type: 'stop', side: 'buy', amount: 1, price: null, params: { stopPrice: stopPrice + 5, reduceOnly: true } });
  assert.equal(again.status, 400);
  assert.equal(again.body.kind, 'InvalidOrder');
  assert.match(again.body.error, /No short MES position to reduce/);
});

test('a resting limit order can be modified and cancelled over HTTP', async () => {
  const placed = await env.post('/order', { symbol: MES, type: 'limit', side: 'buy', amount: 1, price: 1000 });
  assert.equal(placed.status, 200);
  assert.equal(placed.body.status, 'open');
  const { id } = placed.body;

  const open = (await env.get('/orders/open')).body;
  assert.deepEqual(open.map((o) => o.id), [id]);

  const modified = await env.post(`/order/${id}/modify`, { price: 1001.1 });
  assert.equal(modified.status, 200);
  assert.equal(modified.body.price, 1001);

  const cancelled = await env.post(`/order/${id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'canceled');
  assert.deepEqual((await env.get('/orders/open')).body, []);

  const missing = await env.get('/order/999999');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.kind, 'OrderNotFound');
});

test('/status exposes upstream, limiter, hub, candle and tick state', async () => {
  const res = await env.get('/status');
  assert.equal(res.status, 200);
  const s = res.body;
  assert.equal(s.ok, true);
  assert.equal(s.ready, true);
  assert.equal(s.mock, true);
  assert.equal(s.dryRun, true);
  assert.equal(s.guardSource, 'projectx');
  assert.equal(s.upstream.mock, true);
  assert.deepEqual(Object.keys(s.rateLimits).sort(), ['bars', 'other']);
  assert.equal(s.marketHub.state, 'connected');
  assert.deepEqual(s.marketHub.wanted, ['MES']);
  assert.equal(s.userHub.state, 'connected');
  assert.equal(s.userHub.account.id, 1001);
  assert.ok(s.userHub.lastReconcileAt > 0);
  assert.ok(s.candles);
  assert.ok(Array.isArray(s.rolls));
});

test('/guard/reset validates the scope and snapshots are refused outside dry-run sourcing', async () => {
  const bad = await env.post('/guard/reset', { scope: 'week' });
  assert.equal(bad.status, 400);
  const ok = await env.post('/guard/reset', { scope: 'day' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'active');

  const snapshot = await env.post('/guard/snapshot', { positions: [] });
  assert.equal(snapshot.status, 409);
});

test('stop() can be called more than once', async () => {
  // The suite-level after() hook stops the app a second time.
  const probe = await makeMockApp();
  await probe.app.stop();
  await probe.app.stop();
  await probe.stop();
});
test('topstep.account_name resolves phase and size for a dry-run guard that has no ProjectX account', async () => {
  const dry = await makeMockApp({
    gateway: { account_source: 'freqtrade' },
    topstep: { phase: 'auto', preset: 'auto', start_balance: 'auto', account_name: '100KTC-DRY-1' },
  });
  try {
    const res = await dry.post('/guard/snapshot', { realized_total: 0, day_realized: 0, entries_today: 0, closed_results: [], positions: [] });
    assert.equal(res.status, 200);
    assert.equal(res.body.metrics.startBalance, 100000);
    assert.equal(res.body.metrics.dailyLossLimit, 2000);
    assert.equal(res.body.metrics.profitTarget, 6000);
  } finally {
    await dry.stop();
  }
});
