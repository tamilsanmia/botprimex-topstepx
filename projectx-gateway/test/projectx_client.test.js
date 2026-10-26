import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RateLimiter } from '../src/limiter.js';
import {
  ProjectXClient, accountProduct, contractMonth, contractRoot, MAX_BARS_PER_REQUEST,
} from '../src/projectx.js';

const BASE = 'https://px.test';

const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const login = (token = 'tok-1') => json({ token, success: true, errorCode: 0 });

/**
 * Replaces globalThis.fetch. `respond(path, body, call)` returns a Response (or
 * throws to simulate a transport failure). Every request is recorded.
 */
function stubFetch(t, respond) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url).slice(BASE.length);
    const call = {
      path,
      body: JSON.parse(init.body),
      auth: init.headers.Authorization ?? null,
      signal: init.signal,
      method: init.method,
    };
    requests.push(call);
    return respond(path, call.body, call);
  });
  return {
    requests,
    to: (path) => requests.filter((r) => r.path === path),
  };
}

/** Limiter that runs jobs immediately and records back-off requests. */
function instantLimiter() {
  return {
    backoffs: [],
    scheduled: [],
    schedule(path, priority, fn) {
      this.scheduled.push({ path, priority });
      return Promise.resolve().then(fn);
    },
    backoff(path, ms) {
      this.backoffs.push({ path, ms });
    },
  };
}

function makeClient(limiter = instantLimiter(), over = {}) {
  return new ProjectXClient({ apiBase: BASE, username: 'user', apiKey: 'key', ...over }, limiter);
}

/* ---------------------------------------------------------------- token -- */

test('parallel getToken() callers share one login', async (t) => {
  const net = stubFetch(t, async () => {
    await new Promise((r) => setTimeout(r, 20));
    return login('shared');
  });
  const client = makeClient();
  const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => client.getToken()));
  assert.deepEqual(tokens, Array(5).fill('shared'));
  assert.equal(net.to('/api/Auth/loginKey').length, 1);
  assert.deepEqual(net.requests[0].body, { userName: 'user', apiKey: 'key' });
  assert.equal(net.requests[0].auth, null, 'login carries no bearer token');
});

test('the token is reused until its TTL, then minted again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  let n = 0;
  const net = stubFetch(t, () => login(`tok-${n += 1}`));
  const client = makeClient();

  assert.equal(await client.getToken(), 'tok-1');
  t.mock.timers.tick(22 * 60 * 60 * 1000);
  assert.equal(await client.getToken(), 'tok-1', 'still valid at 22 h');
  assert.equal(client.status().tokenValid, true);
  t.mock.timers.tick(2 * 60 * 60 * 1000);
  assert.equal(client.status().tokenValid, false);
  assert.equal(await client.getToken(), 'tok-2', 're-minted after 23 h');
  assert.equal(net.to('/api/Auth/loginKey').length, 2);
  assert.equal(await client.getToken({ force: true }), 'tok-3', 'force bypasses the cache');
});

test('a failed login does not stick: the next call logs in again', async (t) => {
  let n = 0;
  const net = stubFetch(t, () => (n++ === 0 ? json({ success: false, errorCode: 1, errorMessage: 'bad key' }) : login('ok')));
  const client = makeClient();
  await assert.rejects(client.getToken(), (err) => err.kind === 'ExchangeError' && /bad key/.test(err.message));
  assert.equal(await client.getToken(), 'ok');
  assert.equal(net.to('/api/Auth/loginKey').length, 2);
});

test('a login without a token is an AuthenticationError', async (t) => {
  stubFetch(t, () => json({ success: true }));
  await assert.rejects(makeClient().getToken(), (err) => err.kind === 'AuthenticationError' && /no token/.test(err.message));
});

test('an unconfigured client refuses with 503 AuthenticationError and never calls out', async (t) => {
  const net = stubFetch(t, () => login());
  const client = makeClient(instantLimiter(), { username: '', apiKey: '' });
  assert.equal(client.isConfigured(), false);
  assert.equal(client.status().configured, false);
  await assert.rejects(client.getToken(), (err) => err.status === 503 && err.kind === 'AuthenticationError');
  assert.equal(net.requests.length, 0);
});

/* ---------------------------------------------------------------- 401 -- */

test('a 401 forces a fresh login and retries the call once with the new token', async (t) => {
  let logins = 0;
  const net = stubFetch(t, (path, body, call) => {
    if (path === '/api/Auth/loginKey') return login(`tok-${logins += 1}`);
    return call.auth === 'Bearer tok-2' ? json({ success: true, accounts: [] }) : json({}, 401);
  });
  const client = makeClient();
  const accounts = await client.searchAccounts();
  assert.deepEqual(accounts, []);
  assert.deepEqual(net.requests.map((r) => [r.path, r.auth]), [
    ['/api/Auth/loginKey', null],
    ['/api/Account/search', 'Bearer tok-1'],
    ['/api/Auth/loginKey', null],
    ['/api/Account/search', 'Bearer tok-2'],
  ]);
});

test('a second 401 is reported as AuthenticationError instead of looping', async (t) => {
  const net = stubFetch(t, (path) => (path === '/api/Auth/loginKey' ? login() : json({}, 401)));
  await assert.rejects(makeClient().searchAccounts(), (err) => err.status === 401 && err.kind === 'AuthenticationError');
  assert.equal(net.to('/api/Account/search').length, 2);
});

/* ---------------------------------------------------------------- 429 -- */

test('reads retry a 429 with growing back-off and succeed', async (t) => {
  let attempts = 0;
  const net = stubFetch(t, (path) => {
    if (path === '/api/Auth/loginKey') return login();
    attempts += 1;
    return attempts < 3 ? json({}, 429) : json({ success: true, orders: [{ id: 1 }] });
  });
  const limiter = instantLimiter();
  const client = makeClient(limiter);
  assert.deepEqual(await client.searchOpenOrders(7), [{ id: 1 }]);
  assert.equal(net.to('/api/Order/searchOpen').length, 3);
  assert.deepEqual(limiter.backoffs, [
    { path: '/api/Order/searchOpen', ms: 1000 },
    { path: '/api/Order/searchOpen', ms: 2000 },
  ]);
});

test('reads give up after the retries and surface RateLimitExceeded', async (t) => {
  const net = stubFetch(t, (path) => (path === '/api/Auth/loginKey' ? login() : json({}, 429)));
  await assert.rejects(makeClient().searchOpenPositions(7), (err) => err.status === 429 && err.kind === 'RateLimitExceeded');
  assert.equal(net.to('/api/Position/searchOpen').length, 3, 'first try plus two retries');
});

test('a request shed by the gateway limiter is not retried and does not pause the bucket', async (t) => {
  const net = stubFetch(t, (path) => (path === '/api/Auth/loginKey' ? login() : json({})));
  // The login and the first read use the two stamps of the window.
  const limiter = new RateLimiter({ bars_per_30s: 5, other_per_60s: 2, order_reserve: 0, max_queue: 1 });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const client = makeClient(limiter);
    // Fill the window and the queue; the next read is rejected by the limiter itself.
    await client.searchOpenPositions(7);
    const queued = client.searchOpenPositions(7).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(client.searchOpenPositions(7), (err) => err.status === 429 && err.kind === 'RateLimitExceeded' && err.shed === true);
    assert.equal(limiter.status().other.throttled429, 0, 'no back-off was requested');
    assert.equal(net.to('/api/Position/searchOpen').length, 1, 'the shed call never reached the network');
    void queued;
  } finally {
    clearInterval(keepAlive);
  }
});

test('order calls are retried once on 429 and no more', async (t) => {
  const net = stubFetch(t, (path) => (path === '/api/Auth/loginKey' ? login() : json({}, 429)));
  const client = makeClient();
  await assert.rejects(client.placeOrder({ accountId: 7 }), (err) => err.kind === 'RateLimitExceeded');
  assert.equal(net.to('/api/Order/place').length, 2);
  await assert.rejects(client.cancelOrder(7, 1), (err) => err.kind === 'RateLimitExceeded');
  assert.equal(net.to('/api/Order/cancel').length, 2);
  await assert.rejects(client.closeContract(7, 'C'), (err) => err.kind === 'RateLimitExceeded');
  assert.equal(net.to('/api/Position/closeContract').length, 2);
});

test('an order recovers when the retry after a 429 succeeds', async (t) => {
  let placed = 0;
  const net = stubFetch(t, (path) => {
    if (path === '/api/Auth/loginKey') return login();
    placed += 1;
    return placed === 1 ? json({}, 429) : json({ success: true, orderId: 55 });
  });
  const res = await makeClient().placeOrder({ accountId: 7, contractId: 'C', size: 1 });
  assert.equal(res.orderId, 55);
  assert.equal(net.to('/api/Order/place').length, 2);
});

test('with the real limiter a 429 pauses the bucket', async (t) => {
  let hits = 0;
  stubFetch(t, (path) => {
    if (path === '/api/Auth/loginKey') return login();
    hits += 1;
    return hits === 1 ? json({}, 429) : json({ success: true, orders: [] });
  });
  const limiter = new RateLimiter({ bars_per_30s: 40, other_per_60s: 180 });
  const client = makeClient(limiter);
  const started = Date.now();
  const keepAlive = setInterval(() => {}, 50); // limiter timers are unref'd
  try {
    await client.searchOpenOrders(7);
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(Date.now() - started >= 900, 'waited out the 1 s back-off');
  assert.equal(limiter.status().other.throttled429, 1);
});

/* ----------------------------------------------------- envelope and HTTP -- */

test('success:false on /api/Order/place maps errorCode to a ccxt kind', async (t) => {
  const cases = { 1: 'AuthenticationError', 2: 'InvalidOrder', 3: 'InsufficientFunds', 4: 'InvalidOrder', 5: 'InvalidOrder', 6: 'ExchangeError', 7: 'ExchangeError', 8: 'BadSymbol', 9: 'InvalidOrder', 10: 'InvalidOrder', 99: 'ExchangeError' };
  let code = 0;
  stubFetch(t, (path) => (path === '/api/Auth/loginKey' ? login() : json({ success: false, errorCode: code, errorMessage: `code ${code}` })));
  const client = makeClient();
  for (const [errorCode, kind] of Object.entries(cases)) {
    code = Number(errorCode);
    await assert.rejects(client.placeOrder({}), (err) => {
      assert.equal(err.kind, kind, `errorCode ${errorCode}`);
      assert.equal(err.status, 400);
      assert.equal(err.errorCode, code);
      assert.equal(err.message, `code ${code}`);
      assert.equal(err.payload.success, false);
      return true;
    });
  }
});

test('success:false on other endpoints is a plain ExchangeError, with a fallback message', async (t) => {
  stubFetch(t, (path) => (path === '/api/Auth/loginKey' ? login() : json({ success: false, errorCode: 2 })));
  await assert.rejects(makeClient().cancelOrder(7, 1), (err) => err.kind === 'ExchangeError' && /rejected the request \(code 2\)/.test(err.message));
});

test('HTTP errors: 5xx is ExchangeNotAvailable, 4xx is BadRequest with the server message', async (t) => {
  let status = 500;
  stubFetch(t, (path) => (path === '/api/Auth/loginKey' ? login() : json({ errorMessage: 'nope', errorCode: 3 }, status)));
  const client = makeClient();
  await assert.rejects(client.searchTrades(7, { start: 0 }), (err) => err.kind === 'ExchangeNotAvailable' && err.status === 502);
  status = 400;
  await assert.rejects(client.searchTrades(7, { start: 0 }), (err) => err.kind === 'BadRequest' && err.message === 'nope' && err.errorCode === 3);
});

test('a non-JSON success body is treated as an empty payload', async (t) => {
  stubFetch(t, (path) => (path === '/api/Auth/loginKey' ? login() : new Response('<html>', { status: 200 })));
  assert.deepEqual(await makeClient().searchOpenOrders(7), []);
});

/* ---------------------------------------------------- timeout / network -- */

test('a request timeout is RequestTimeout (504) and is not retried', async (t) => {
  const net = stubFetch(t, (path) => {
    if (path === '/api/Auth/loginKey') return login();
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  });
  await assert.rejects(makeClient().placeOrder({}), (err) => err.kind === 'RequestTimeout' && err.status === 504 && /timed out/.test(err.message));
  assert.equal(net.to('/api/Order/place').length, 1);
});

test('a transport failure is NetworkError (504) and is not retried', async (t) => {
  const net = stubFetch(t, (path) => {
    if (path === '/api/Auth/loginKey') return login();
    throw new TypeError('fetch failed');
  });
  await assert.rejects(makeClient().searchOpenOrders(7), (err) => err.kind === 'NetworkError' && err.status === 504 && /fetch failed/.test(err.message));
  assert.equal(net.to('/api/Order/searchOpen').length, 1);
});

test('every request carries an abort signal; orders use a shorter timeout than reads', async (t) => {
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  stubFetch(t, (path) => (path === '/api/Auth/loginKey' ? login() : json({ success: true, orders: [] })));
  const client = makeClient();
  await client.searchOpenOrders(7);
  await client.cancelOrder(7, 1);
  // login (read timeout), read, order
  assert.deepEqual(timeouts, [15_000, 15_000, 8_000]);
});

/* ------------------------------------------------------------ priorities -- */

test('orders go through the limiter at ORDER priority, reads at READ, background at BACKGROUND', async (t) => {
  stubFetch(t, (path) => (path === '/api/Auth/loginKey' ? login() : json({ success: true, orders: [], positions: [] })));
  const limiter = instantLimiter();
  const client = makeClient(limiter);
  await client.placeOrder({});
  await client.searchOpenOrders(7);
  await client.searchOpenPositions(7, { priority: 2 });
  const byPath = Object.fromEntries(limiter.scheduled.map((s) => [s.path, s.priority]));
  assert.equal(byPath['/api/Auth/loginKey'], 0);
  assert.equal(byPath['/api/Order/place'], 0);
  assert.equal(byPath['/api/Order/searchOpen'], 1);
  assert.equal(byPath['/api/Position/searchOpen'], 2);
});

/* ------------------------------------------------------------- endpoints -- */

test('searchAccounts maps accounts and derives size and kind from the name', async (t) => {
  const net = stubFetch(t, (path) => (path === '/api/Auth/loginKey' ? login() : json({
    success: true,
    accounts: [
      { id: 1, name: '50KTC-V2-1', balance: '49000.5', canTrade: true, isVisible: true },
      { id: 2, name: 'PRACTICE', balance: 1, canTrade: false, simulated: false },
      { id: 3 },
    ],
  })));
  const rows = await makeClient().searchAccounts({ onlyActive: false });
  assert.deepEqual(net.to('/api/Account/search')[0].body, { onlyActiveAccounts: false });
  assert.deepEqual(rows[0], { id: 1, name: '50KTC-V2-1', balance: 49000.5, canTrade: true, visible: true, simulated: true, sizeUsd: 50000, kind: 'TC' });
  assert.equal(rows[1].simulated, false);
  assert.equal(rows[1].canTrade, false);
  assert.equal(rows[1].sizeUsd, null);
  assert.equal(rows[2].name, '3', 'a missing name falls back to the id');
  assert.equal(rows[2].canTrade, true);
  assert.equal(rows[2].simulated, true, 'absent means demo, never real money');
});

test('accountProduct reads the product code from the account name', () => {
  assert.deepEqual(accountProduct('50KTC-V2-123'), { sizeUsd: 50000, kind: 'TC' });
  assert.deepEqual(accountProduct('100KTC'), { sizeUsd: 100000, kind: 'TC' });
  assert.deepEqual(accountProduct('150KXFA-8-1'), { sizeUsd: 150000, kind: 'XFA' });
  assert.deepEqual(accountProduct('50KLFA-1'), { sizeUsd: 50000, kind: 'LFA' });
  assert.deepEqual(accountProduct('50KPA-1'), { sizeUsd: 50000, kind: 'PA' });
  assert.deepEqual(accountProduct(' 50ktc-lower '), { sizeUsd: 50000, kind: 'TC' }, 'trimmed and case-insensitive');
  assert.deepEqual(accountProduct('6KCHCR-LABS005-1'), { sizeUsd: 6000, kind: 'LABS' }, 'Topstep Labs Challenge');
  for (const bad of ['XFA', '6KCHCRX-LABS005-1', '50KTCX', '50K-TC', 'ABC', '', null, undefined]) {
    assert.deepEqual(accountProduct(bad), { sizeUsd: null, kind: null }, `name ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(accountProduct('0KTC'), { sizeUsd: null, kind: 'TC' }, 'a zero size is not a size');
});

test('contractRoot and contractMonth parse CME month-year suffixes', () => {
  assert.equal(contractRoot({ name: 'MESZ6' }), 'MES');
  assert.equal(contractRoot({ name: 'mnqu25' }), 'MNQ');
  assert.equal(contractRoot({ name: '6EH6' }), '6E');
  assert.deepEqual(contractMonth('MESZ25'), { month: 12, year: 2025 });
  assert.deepEqual(contractMonth('MESZ5', new Date(Date.UTC(2025, 5, 1))), { month: 12, year: 2025 });
  assert.deepEqual(contractMonth('MESH6', new Date(Date.UTC(2025, 11, 1))), { month: 3, year: 2026 });
  assert.equal(contractMonth('NOSUFFIX_'), null);
});

test('availableContracts caches non-empty lists, coalesces callers and never caches an empty list', async (t) => {
  let rows = [];
  const net = stubFetch(t, async (path) => {
    if (path === '/api/Auth/loginKey') return login();
    await new Promise((r) => setTimeout(r, 10));
    return json({ success: true, contracts: rows });
  });
  const client = makeClient(instantLimiter(), { live: true });
  t.mock.method(console, 'warn', () => {});

  assert.deepEqual(await client.availableContracts(), []);
  assert.deepEqual(await client.availableContracts(), []);
  assert.equal(net.to('/api/Contract/available').length, 2, 'an empty list is not cached');
  assert.deepEqual(net.to('/api/Contract/available')[0].body, { live: true });

  rows = [
    { id: 'CON.F.US.MES.Z26', name: 'MESZ6', tickSize: 0.25, tickValue: 1.25, symbolId: 'F.US.MES' },
    { id: 'bad-no-name' },
  ];
  const [a, b] = await Promise.all([client.availableContracts(), client.availableContracts()]);
  assert.equal(net.to('/api/Contract/available').length, 3, 'parallel callers share one request');
  assert.deepEqual(a, b);
  assert.deepEqual(a, [{
    contractId: 'CON.F.US.MES.Z26', name: 'MESZ6', root: 'MES', symbolId: 'F.US.MES',
    description: 'MESZ6', tickSize: 0.25, tickValue: 1.25, activeContract: true,
  }]);
  await client.availableContracts();
  assert.equal(net.to('/api/Contract/available').length, 3, 'served from cache');
  await client.availableContracts({ force: true });
  assert.equal(net.to('/api/Contract/available').length, 4);
});

test('retrieveBars sends an ISO window, caps the limit, drops bad rows and returns oldest first', async (t) => {
  const net = stubFetch(t, (path) => (path === '/api/Auth/loginKey' ? login() : json({
    success: true,
    bars: [
      { t: '2026-03-02T10:02:00Z', o: 3, h: 4, l: 2, c: 3.5, v: 10 },
      { t: '2026-03-02T10:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5 },
      { t: '2026-03-02T10:01:00Z', o: 0, h: 2, l: 1, c: 1, v: 5 },
      { t: '2026-03-02T10:03:00Z', o: 2, h: 1, l: 3, c: 2, v: 5 },
      { t: 'garbage', o: 1, h: 1, l: 1, c: 1 },
    ],
  })));
  const bars = await makeClient().retrieveBars({
    contractId: 'C', unit: 2, unitNumber: 1, startTime: 0, endTime: 60_000, limit: 99_999,
  });
  assert.deepEqual(bars, [
    [Date.parse('2026-03-02T10:00:00Z'), 1, 2, 0.5, 1.5, 0],
    [Date.parse('2026-03-02T10:02:00Z'), 3, 4, 2, 3.5, 10],
  ]);
  const body = net.to('/api/History/retrieveBars')[0].body;
  assert.equal(body.limit, MAX_BARS_PER_REQUEST);
  assert.equal(body.startTime, '1970-01-01T00:00:00.000Z');
  assert.equal(body.endTime, '1970-01-01T00:01:00.000Z');
  assert.equal(body.includePartialBar, true);
  assert.equal(body.live, false);
});

test('order endpoint bodies', async (t) => {
  const net = stubFetch(t, (path) => (path === '/api/Auth/loginKey' ? login() : json({ success: true, orderId: 1 })));
  const client = makeClient();
  await client.cancelOrder(7, 11);
  await client.modifyOrder({ accountId: 7, orderId: 11, size: 2 });
  await client.closeContract(7, 'C');
  await client.partialCloseContract(7, 'C', 2);
  assert.deepEqual(net.to('/api/Order/cancel')[0].body, { accountId: 7, orderId: 11 });
  assert.deepEqual(net.to('/api/Order/modify')[0].body, { accountId: 7, orderId: 11, size: 2 });
  assert.deepEqual(net.to('/api/Position/closeContract')[0].body, { accountId: 7, contractId: 'C' });
  assert.deepEqual(net.to('/api/Position/partialCloseContract')[0].body, { accountId: 7, contractId: 'C', size: 2 });
});

test('latency is recorded per request', async (t) => {
  stubFetch(t, () => login());
  const client = makeClient();
  await client.getToken();
  const { latency } = client.status();
  assert.equal(latency.samples, 1);
  assert.ok(latency.lastMs >= 0);
});
