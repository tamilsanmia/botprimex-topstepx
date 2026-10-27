import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { after, before, test } from 'node:test';

import { WebSocket } from 'ws';

import { GatewayError } from '../src/errors.js';
import { validateSnapshot } from '../src/index.js';
import { createServer } from '../src/server.js';
import { SECRET, makeMockApp } from './helpers.js';

const calls = [];
const record = (name) => (...args) => {
  calls.push({ name, args });
  return { name };
};

/** App stub: every handler records its arguments so routing and parsing can be asserted. */
const routerStub = {
  balance: record('balance'),
  positions: record('positions'),
  openOrders: record('openOrders'),
  orders: record('orders'),
  getOrder: record('getOrder'),
  place: record('place'),
  cancel: record('cancel'),
  modify: record('modify'),
  myTrades: record('myTrades'),
  closePosition: record('closePosition'),
};
const app = {
  stake: 'USD',
  health: () => ({ ok: true, ready: true }),
  status: () => ({ ok: true, status: true }),
  markets: record('markets'),
  ohlcv: async (...args) => {
    calls.push({ name: 'ohlcv', args });
    return [[1, 2, 3, 4, 5, 6]];
  },
  ticker: async (symbol) => {
    if (symbol === 'BAD/USD:USD') throw new GatewayError('Unknown symbol', { status: 404, kind: 'BadSymbol' });
    return { symbol, last: 1 };
  },
  tickers: record('tickers'),
  orderbook: record('orderbook'),
  publicTrades: record('publicTrades'),
  orderflowFeatures: record('orderflowFeatures'),
  router: () => routerStub,
  guardState: () => ({ status: 'active' }),
  guardSnapshot: record('guardSnapshot'),
  guardReset: record('guardReset'),
};

let handle;
let base;
let port;
const sockets = [];

before(async () => {
  handle = createServer(app, { secret: SECRET, port: 0 });
  if (!handle.server.listening) await once(handle.server, 'listening');
  port = handle.server.address().port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  for (const ws of sockets) ws.terminate();
  handle.wss.close();
  handle.server.closeAllConnections?.();
  await new Promise((resolve) => handle.server.close(resolve));
});

async function call(method, route, { body, secret = SECRET, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['X-Gateway-Secret'] = secret;
  const res = await fetch(`${base}${route}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/* ----------------------------------------------------------------- auth -- */

test('the server listens on the port it was given (0 = ephemeral) and exposes it', () => {
  assert.ok(port > 0);
  assert.equal(handle.address().port, port);
});

test('/health needs no secret', async () => {
  const res = await call('GET', '/health', { secret: null });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, ready: true });
});

test('every other route is 401 without the secret or with a wrong one', async () => {
  for (const secret of [null, 'wrong', 'S', 'ss', '']) {
    const res = await call('GET', '/status', { secret });
    assert.equal(res.status, 401, `secret ${JSON.stringify(secret)}`);
    assert.equal(res.body.kind, 'AuthenticationError');
    assert.match(res.body.error, /X-Gateway-Secret/);
  }
  const post = await call('POST', '/order', { body: { symbol: 'MES/USD:USD' }, secret: 'nope' });
  assert.equal(post.status, 401);
});

test('the correct secret is accepted', async () => {
  const res = await call('GET', '/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, status: true });
});

/* ------------------------------------------------------- body and routing -- */

test('a body over 64 KB is refused with 400 BadRequest, or the connection is cut', async () => {
  const payload = JSON.stringify({ symbol: 'x'.repeat(70 * 1024) });
  const outcome = await new Promise((resolve) => {
    const req = http.request(`${base}/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Gateway-Secret': SECRET },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('error', (err) => resolve({ error: err.code }));
    });
    req.on('error', (err) => resolve({ error: err.code }));
    req.end(payload);
  });
  if (outcome.status !== undefined) {
    assert.equal(outcome.status, 400);
    assert.equal(JSON.parse(outcome.text).kind, 'BadRequest');
  } else {
    // The server answers 400 and closes; a client still writing the body may only see the reset.
    assert.ok(['ECONNRESET', 'EPIPE'].includes(outcome.error), `unexpected error ${outcome.error}`);
  }
  assert.equal(calls.filter((c) => c.name === 'place').length, 0, 'the handler never ran');
});

test('a body just under the limit is accepted', async () => {
  const res = await call('POST', '/order', { body: { symbol: 'MES/USD:USD', pad: 'x'.repeat(60 * 1024) } });
  assert.equal(res.status, 200);
  assert.equal(calls.filter((c) => c.name === 'place').length, 1);
});

test('invalid JSON is 400 BadRequest', async () => {
  const res = await call('POST', '/order', { raw: '{not json' });
  assert.equal(res.status, 400);
  assert.equal(res.body.kind, 'BadRequest');
  assert.match(res.body.error, /JSON/);
});

test('an empty POST body is treated as {}', async () => {
  calls.length = 0;
  const res = await call('POST', '/guard/reset');
  assert.equal(res.status, 200);
  assert.deepEqual(calls.at(-1), { name: 'guardReset', args: [undefined] });
});

test('an unknown route is 404 BadRequest, also for a known path with the wrong method', async () => {
  const unknown = await call('GET', '/nope');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.kind, 'BadRequest');
  assert.match(unknown.body.error, /No route GET \/nope/);

  const wrongMethod = await call('DELETE', '/order');
  assert.equal(wrongMethod.status, 404);
  const getOnPost = await call('GET', '/guard/reset');
  assert.equal(getOnPost.status, 404);
});

test('a handler that throws a plain Error is 500 ExchangeError', async (t) => {
  t.mock.method(console, 'error', () => {});
  const original = app.markets;
  app.markets = () => { throw new Error('boom'); };
  try {
    const res = await call('GET', '/markets');
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'boom', kind: 'ExchangeError' });
  } finally {
    app.markets = original;
  }
});

test('a GatewayError from a handler keeps its status, kind and code', async () => {
  const original = routerStub.place;
  routerStub.place = () => { throw new GatewayError('Refused', { status: 400, kind: 'InvalidOrder', errorCode: 4 }); };
  try {
    const res = await call('POST', '/order', { body: {} });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Refused', kind: 'InvalidOrder', errorCode: 4 });
  } finally {
    routerStub.place = original;
  }
});

test('an async handler rejection is mapped like a throw', async () => {
  const res = await call('GET', '/ticker?symbol=BAD/USD:USD');
  assert.equal(res.status, 404);
  assert.equal(res.body.kind, 'BadSymbol');
});

test('/ohlcv validates symbol and timeframe and passes parsed arguments', async () => {
  const missing = await call('GET', '/ohlcv?timeframe=1m');
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /symbol is required/);

  const badTf = await call('GET', '/ohlcv?symbol=MES/USD:USD&timeframe=7m');
  assert.equal(badTf.status, 400);
  assert.equal(badTf.body.kind, 'BadRequest');
  assert.match(badTf.body.error, /Unsupported timeframe 7m/);

  calls.length = 0;
  const ok = await call('GET', '/ohlcv?symbol=mes/USD:USD&timeframe=5m&since=1000&limit=7');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, [[1, 2, 3, 4, 5, 6]]);
  assert.deepEqual(calls.at(-1).args, ['MES', '5m', 1000, 7]);

  calls.length = 0;
  await call('GET', '/ohlcv?symbol=MES/USD:USD');
  assert.deepEqual(calls.at(-1).args, ['MES', '1m', null, 1000], 'defaults: 1m, no since, limit 1000');
});

test('order routes pass path ids, query and body to the router', async () => {
  calls.length = 0;
  await call('GET', '/order/12');
  await call('POST', '/order/12/cancel');
  await call('POST', '/order/12/modify', { body: { price: 6001 } });
  await call('POST', '/position/close', { body: { symbol: 'MES/USD:USD' } });
  await call('GET', '/orders?symbol=MES/USD:USD&since=5');
  await call('GET', '/orders/open');
  await call('GET', '/positions?symbols=MES/USD:USD,ES/USD:USD');
  await call('GET', '/mytrades?symbol=MES/USD:USD');
  await call('GET', '/balance');
  assert.deepEqual(calls.map((c) => [c.name, ...c.args]), [
    ['getOrder', '12'],
    ['cancel', '12'],
    ['modify', '12', { price: 6001 }],
    ['closePosition', 'MES/USD:USD'],
    ['orders', 'MES/USD:USD', 5],
    ['openOrders', null],
    ['positions', ['MES/USD:USD', 'ES/USD:USD']],
    ['myTrades', 'MES/USD:USD', null],
    ['balance', 'USD'],
  ]);
});

test('/guard routes call the app', async () => {
  const state = await call('GET', '/guard');
  assert.deepEqual(state.body, { status: 'active' });
  calls.length = 0;
  await call('POST', '/guard/snapshot', { body: { positions: [] } });
  assert.deepEqual(calls.at(-1), { name: 'guardSnapshot', args: [{ positions: [] }] });
  await call('POST', '/guard/reset', { body: { scope: 'day' } });
  assert.deepEqual(calls.at(-1), { name: 'guardReset', args: ['day'] });
});

/* ------------------------------------------------------------ websocket -- */

function connect({ secret = SECRET, path = '/ws' } = {}) {
  const headers = secret === null ? {} : { 'x-gateway-secret': secret };
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  sockets.push(ws);
  return ws;
}

const frame = async (ws) => JSON.parse((await once(ws, 'message'))[0].toString());

test('ws: an upgrade with a bad or missing secret, or the wrong path, gets 401', async () => {
  for (const opts of [{ secret: 'wrong' }, { secret: null }, { path: '/other' }]) {
    const ws = connect(opts);
    ws.on('error', () => {});
    const [, res] = await once(ws, 'unexpected-response');
    assert.equal(res.statusCode, 401, JSON.stringify(opts));
    res.resume();
  }
});

test('ws: subscribe sends an initial frame for ohlcv, ticker and guard', async () => {
  const ws = connect();
  await once(ws, 'open');

  ws.send(JSON.stringify({ op: 'subscribe', channel: 'ohlcv', symbol: 'MES/USD:USD', timeframe: '1m' }));
  assert.deepEqual(await frame(ws), { channel: 'ohlcv', symbol: 'MES/USD:USD', timeframe: '1m', data: [[1, 2, 3, 4, 5, 6]] });
  assert.deepEqual(calls.filter((c) => c.name === 'ohlcv').at(-1).args, ['MES', '1m', null, 3]);

  ws.send(JSON.stringify({ op: 'subscribe', channel: 'ticker', symbol: 'MES/USD:USD' }));
  assert.deepEqual(await frame(ws), { channel: 'ticker', symbol: 'MES/USD:USD', data: { symbol: 'MES/USD:USD', last: 1 } });

  ws.send(JSON.stringify({ op: 'subscribe', channel: 'guard' }));
  assert.deepEqual(await frame(ws), { channel: 'guard', data: { status: 'active' } });
  ws.close();
});

test('ws: subscription errors come back as an error frame', async () => {
  const ws = connect();
  await once(ws, 'open');
  ws.send(JSON.stringify({ op: 'subscribe', channel: 'ohlcv', symbol: 'MES/USD:USD', timeframe: '7m' }));
  const bad = await frame(ws);
  assert.equal(bad.channel, 'ohlcv');
  assert.equal(bad.kind, 'BadRequest');
  assert.match(bad.error, /Unsupported timeframe/);

  ws.send(JSON.stringify({ op: 'subscribe', channel: 'ticker', symbol: 'BAD/USD:USD' }));
  const unknown = await frame(ws);
  assert.equal(unknown.kind, 'BadSymbol');
  ws.close();
});

test('ws: garbage and unknown ops are ignored and the socket stays usable', async () => {
  const ws = connect();
  await once(ws, 'open');
  ws.send('not json');
  ws.send(JSON.stringify({ op: 'ping' }));
  ws.send(JSON.stringify({ op: 'subscribe', channel: 'guard' }));
  assert.equal((await frame(ws)).channel, 'guard');
  ws.close();
});

test('ws: broadcast reaches only sockets subscribed to that key, and unsubscribe stops it', async () => {
  const subscribed = connect();
  const other = connect();
  await Promise.all([once(subscribed, 'open'), once(other, 'open')]);

  subscribed.send(JSON.stringify({ op: 'subscribe', channel: 'ohlcv', symbol: 'MES/USD:USD', timeframe: '1m' }));
  other.send(JSON.stringify({ op: 'subscribe', channel: 'ohlcv', symbol: 'MES/USD:USD', timeframe: '5m' }));
  await Promise.all([frame(subscribed), frame(other)]);

  const received = { subscribed: [], other: [] };
  subscribed.on('message', (m) => received.subscribed.push(JSON.parse(m.toString())));
  other.on('message', (m) => received.other.push(JSON.parse(m.toString())));

  handle.broadcast('ohlcv|MES|1m', { channel: 'ohlcv', timeframe: '1m', data: [1] });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.subscribed.length, 1);
  assert.equal(received.other.length, 0);

  subscribed.send(JSON.stringify({ op: 'unsubscribe', channel: 'ohlcv', symbol: 'MES/USD:USD', timeframe: '1m' }));
  await new Promise((r) => setTimeout(r, 50));
  handle.broadcast('ohlcv|MES|1m', { channel: 'ohlcv', timeframe: '1m', data: [2] });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.subscribed.length, 1, 'no frame after unsubscribe');
  subscribed.close();
  other.close();
});

test('ws: the guard channel key is "guard"', async () => {
  const ws = connect();
  await once(ws, 'open');
  ws.send(JSON.stringify({ op: 'subscribe', channel: 'guard' }));
  await frame(ws);
  const next = frame(ws);
  handle.broadcast('guard', { channel: 'guard', data: { status: 'day_locked' } });
  assert.deepEqual(await next, { channel: 'guard', data: { status: 'day_locked' } });
  ws.close();
});

/* ----------------------------------------------- hardening (H7 / L4 / H6) -- */

/** Starts a second server with other options; returns helpers and a close(). */
async function startServer(opts) {
  const h = createServer(app, { port: 0, ...opts });
  if (!h.server.listening) await once(h.server, 'listening');
  const url = `http://127.0.0.1:${h.server.address().port}`;
  const open = [];
  return {
    h,
    url,
    async get(route, headers = {}) {
      const res = await fetch(`${url}${route}`, { headers });
      return { status: res.status, body: await res.json() };
    },
    async post(route, body, headers = {}) {
      const res = await fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
      return { status: res.status, body: await res.json() };
    },
    ws(path = '/ws', headers = {}) {
      const w = new WebSocket(`ws://127.0.0.1:${h.server.address().port}${path}`, { headers });
      w.on('error', () => {});
      open.push(w);
      return w;
    },
    async close() {
      for (const w of open) w.terminate();
      h.wss.close();
      h.server.closeAllConnections?.();
      await new Promise((resolve) => h.server.close(resolve));
    },
  };
}

test('an empty secret fails closed: every route but /health is 401, even with an empty header', async () => {
  const s = await startServer({ secret: '' });
  try {
    assert.equal((await s.get('/health')).status, 200);
    assert.equal((await s.get('/status')).status, 401);
    assert.equal((await s.get('/status', { 'X-Gateway-Secret': '' })).status, 401);
    assert.equal((await s.post('/order', {})).status, 401);
    const ws = s.ws();
    const [, res] = await once(ws, 'unexpected-response');
    assert.equal(res.statusCode, 401);
    res.resume();
  } finally {
    await s.close();
  }
});

test('allowOpen (mock mode) lets an empty secret through, but a configured secret is still enforced', async () => {
  const open = await startServer({ secret: '', allowOpen: true });
  try {
    assert.equal((await open.get('/status')).status, 200);
  } finally {
    await open.close();
  }
  const guarded = await startServer({ secret: SECRET, allowOpen: true });
  try {
    assert.equal((await guarded.get('/status')).status, 401);
    assert.equal((await guarded.get('/status', { 'X-Gateway-Secret': SECRET })).status, 200);
  } finally {
    await guarded.close();
  }
});

test('/ws?secret= is rejected by default and accepted only with allowQuerySecret', async () => {
  const strict = await startServer({ secret: SECRET });
  try {
    const ws = strict.ws(`/ws?secret=${SECRET}`);
    const [, res] = await once(ws, 'unexpected-response');
    assert.equal(res.statusCode, 401);
    res.resume();
    const header = strict.ws('/ws', { 'x-gateway-secret': SECRET });
    await once(header, 'open');
  } finally {
    await strict.close();
  }
  const lax = await startServer({ secret: SECRET, allowQuerySecret: true });
  try {
    const ws = lax.ws(`/ws?secret=${SECRET}`);
    await once(ws, 'open');
    const bad = lax.ws('/ws?secret=nope');
    const [, res] = await once(bad, 'unexpected-response');
    assert.equal(res.statusCode, 401);
    res.resume();
  } finally {
    await lax.close();
  }
});

test('a non-numeric since or limit is 400 BadRequest instead of NaN', async () => {
  for (const route of ['/ohlcv?symbol=MES/USD:USD&since=abc', '/ohlcv?symbol=MES/USD:USD&limit=NaN', '/trades?symbol=MES/USD:USD&limit=Infinity', '/orders?since=1e999', '/mytrades?since=x', '/orderflow/features?symbol=MES/USD:USD&since=zz']) {
    calls.length = 0;
    const res = await call('GET', route);
    assert.equal(res.status, 400, route);
    assert.equal(res.body.kind, 'BadRequest', route);
    assert.equal(calls.length, 0, `${route}: the handler never ran`);
  }
  const ok = await call('GET', '/ohlcv?symbol=MES/USD:USD&since=&limit=5');
  assert.equal(ok.status, 200, 'an empty value still means "not given"');
});

test('data-only mode: order routes are 403 PermissionDenied and never reach the router, reads still work', async () => {
  const s = await startServer({ secret: SECRET, dataOnly: true });
  const h = { 'X-Gateway-Secret': SECRET };
  try {
    calls.length = 0;
    for (const [route, body] of [['/order', { symbol: 'MES/USD:USD' }], ['/order/12/cancel', {}], ['/order/12/modify', { price: 1 }], ['/position/close', { symbol: 'MES/USD:USD' }]]) {
      const res = await s.post(route, body, h);
      assert.equal(res.status, 403, route);
      assert.equal(res.body.kind, 'PermissionDenied', route);
    }
    assert.equal(calls.length, 0, 'no router method ran');
    assert.equal((await s.get('/markets', h)).status, 200);
    assert.equal((await s.get('/ticker?symbol=MES/USD:USD', h)).status, 200);
    assert.equal((await s.post('/order', {}, {})).status, 401, 'auth still comes first');
  } finally {
    await s.close();
  }
});

test('validateSnapshot accepts the Python payload and keeps only known fields', () => {
  const body = {
    realized_total: 120.5, day_realized: -20, entries_today: 3, closed_results: [10, -5.5],
    positions: [{ pair: 'MES/USD:USD', side: 'long', contracts: 2, entry_price: 6000.25, extra: 'dropped' }],
    unexpected: true,
  };
  assert.deepEqual(validateSnapshot(body), {
    realized_total: 120.5, day_realized: -20, entries_today: 3, closed_results: [10, -5.5],
    positions: [{ pair: 'MES/USD:USD', side: 'long', contracts: 2, entry_price: 6000.25 }],
  });
  const withMark = validateSnapshot({ ...body, positions: [{ ...body.positions[0], mark: 6001 }] });
  assert.equal(withMark.positions[0].mark, 6001);
});

test('validateSnapshot rejects malformed bodies with 400 BadRequest', () => {
  const good = { realized_total: 0, day_realized: 0, entries_today: 0, closed_results: [], positions: [] };
  const position = { pair: 'MES/USD:USD', side: 'long', contracts: 1, entry_price: 6000 };
  const cases = {
    'not an object': null,
    'array body': [],
    'missing realized_total': { ...good, realized_total: undefined },
    'string number': { ...good, day_realized: '5' },
    'NaN total': { ...good, realized_total: Number.NaN },
    'fractional entries_today': { ...good, entries_today: 1.5 },
    'negative entries_today': { ...good, entries_today: -1 },
    'closed_results not an array': { ...good, closed_results: 'x' },
    'closed_results with a string': { ...good, closed_results: [1, '2'] },
    'closed_results too long': { ...good, closed_results: new Array(5001).fill(1) },
    'positions missing': { ...good, positions: undefined },
    'too many positions': { ...good, positions: new Array(101).fill(position) },
    'position not an object': { ...good, positions: ['x'] },
    'position without pair': { ...good, positions: [{ ...position, pair: '' }] },
    'position with a huge pair': { ...good, positions: [{ ...position, pair: 'x'.repeat(100) }] },
    'bad side': { ...good, positions: [{ ...position, side: 'flat' }] },
    'negative contracts': { ...good, positions: [{ ...position, contracts: -1 }] },
    'zero entry price': { ...good, positions: [{ ...position, entry_price: 0 }] },
    'bad mark': { ...good, positions: [{ ...position, mark: 'x' }] },
  };
  for (const [name, body] of Object.entries(cases)) {
    assert.throws(() => validateSnapshot(body), (err) => err instanceof GatewayError && err.status === 400 && err.kind === 'BadRequest', name);
  }
});

test('POST /guard/snapshot on the real app: a bad shape is 400, a good one is evaluated', async () => {
  const gw = await makeMockApp({ gateway: { account_source: 'freqtrade' } });
  try {
    const bad = await gw.post('/guard/snapshot', { realized_total: 'lots' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.kind, 'BadRequest');
    const good = await gw.post('/guard/snapshot', { realized_total: 0, day_realized: 0, entries_today: 0, closed_results: [], positions: [] });
    assert.equal(good.status, 200);
    assert.ok(good.body.status);
  } finally {
    await gw.stop();
  }
});
