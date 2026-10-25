import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { GatewayApp } from '../src/index.js';
import { ORDER_SIDE, ORDER_STATUS, ORDER_TYPE, POSITION_TYPE } from '../src/projectx.js';
import { OrderRouter } from '../src/router.js';
import { UserStream } from '../src/userStream.js';

export const SECRET = 's';

/** Polls `fn` until it returns a truthy value, or throws after `ms`. */
export async function waitFor(fn, ms = 3000, step = 10) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${ms} ms`);
    await new Promise((r) => setTimeout(r, step));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function tmpDir(prefix = 'gw-test-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Tick size / value per root, enough for the router's price maths. */
const SPECS = {
  MES: { tickSize: 0.25, tickValue: 1.25 },
  ES: { tickSize: 0.25, tickValue: 12.5 },
  MNQ: { tickSize: 0.25, tickValue: 0.5 },
};

export const contractIdOf = (root) => `CON.F.US.${root}.Z26`;

export function fakeContracts(specs = SPECS) {
  const info = (root) => (specs[root] ? { contractId: contractIdOf(root), ...specs[root] } : null);
  return {
    rootForContract: (id) => String(id).split('.')[3],
    contractInfo: (id) => info(String(id).split('.')[3]),
    front: (root) => info(root),
  };
}

/**
 * Scriptable ProjectXClient stand-in. Every call is recorded in `calls`;
 * set `client.fail.<method>` to an Error (or a function returning one) to make
 * that method throw, and `client.onPlace(body, id)` to simulate exchange events.
 */
export function fakeClient() {
  let nextId = 100;
  const client = {
    calls: [],
    fail: {},
    orderRows: [],
    positionRows: [],
    onPlace: null,
    record(name, args) {
      this.calls.push({ name, args });
      const f = this.fail[name];
      if (f) throw typeof f === 'function' ? f(args) : f;
    },
    callsOf(name) {
      return this.calls.filter((c) => c.name === name).map((c) => c.args);
    },
    async placeOrder(body) {
      this.record('placeOrder', body);
      nextId += 1;
      this.onPlace?.(body, nextId);
      return { orderId: nextId, success: true };
    },
    async cancelOrder(accountId, orderId) {
      this.record('cancelOrder', { accountId, orderId });
      return { success: true };
    },
    async modifyOrder(body) {
      this.record('modifyOrder', body);
      return { success: true };
    },
    async closeContract(accountId, contractId) {
      this.record('closeContract', { accountId, contractId });
      return { success: true };
    },
    async searchOrders(accountId, opts) {
      this.record('searchOrders', { accountId, ...opts });
      return this.orderRows.map((o) => ({ ...o }));
    },
    async searchOpenOrders(accountId, opts) {
      this.record('searchOpenOrders', { accountId, ...opts });
      return this.orderRows.filter((o) => o.status === ORDER_STATUS.OPEN).map((o) => ({ ...o }));
    },
    async searchOpenPositions(accountId, opts) {
      this.record('searchOpenPositions', { accountId, ...opts });
      return this.positionRows.map((p) => ({ ...p }));
    },
    async searchTrades(accountId) {
      this.record('searchTrades', { accountId });
      return [];
    },
    async searchAccounts() {
      this.record('searchAccounts', {});
      return [{ id: 7, name: '50KTC-V2-TEST', balance: 50000, canTrade: true, simulated: true, sizeUsd: 50000, kind: 'TC' }];
    },
    async getToken() {
      return 't';
    },
  };
  return client;
}

/**
 * A real UserStream that is never started: no hub, no timers. Its state maps are
 * filled by hand or through onOrder/onPosition/onTrade, which keeps waitForFinal
 * and tradesForOrder behaving exactly like production.
 */
export function fakeUser(client, { accountId = 7, kind = 'TC', sizeUsd = 50000, balance = 50000 } = {}) {
  const user = new UserStream({ client, url: 'http://hub.invalid/user', tokenFactory: () => 't', hubFactory: () => ({}) });
  user.account = { id: accountId, name: `${sizeUsd / 1000}K${kind}-TEST`, balance, kind, sizeUsd, simulated: true };
  return user;
}

export function position(root, { side = 'long', size = 1, price = 6000, id = 1 } = {}) {
  return {
    id,
    accountId: 7,
    contractId: contractIdOf(root),
    creationTimestamp: new Date().toISOString(),
    type: side === 'long' ? POSITION_TYPE.LONG : POSITION_TYPE.SHORT,
    size,
    averagePrice: price,
  };
}

export function orderRow(root, over = {}) {
  return {
    id: 500,
    accountId: 7,
    contractId: contractIdOf(root),
    creationTimestamp: new Date().toISOString(),
    updateTimestamp: new Date().toISOString(),
    status: ORDER_STATUS.OPEN,
    type: ORDER_TYPE.LIMIT,
    side: ORDER_SIDE.BUY,
    size: 1,
    limitPrice: 6000,
    stopPrice: null,
    fillVolume: 0,
    filledPrice: null,
    customTag: null,
    ...over,
  };
}

export function tradeRow(root, over = {}) {
  return {
    id: 900,
    accountId: 7,
    contractId: contractIdOf(root),
    creationTimestamp: new Date().toISOString(),
    price: 6000,
    profitAndLoss: null,
    fees: 0.37,
    commissions: 0.25,
    side: ORDER_SIDE.BUY,
    size: 1,
    voided: false,
    orderId: 500,
    ...over,
  };
}

/**
 * Router wired to fakes. `config` overrides the gateway defaults used by the
 * router. `marks` sets the latest price per root.
 */
export function makeRouter({ config = {}, guard = null, marks = { MES: 6010 }, specs } = {}) {
  const client = fakeClient();
  const user = fakeUser(client);
  const contracts = fakeContracts(specs);
  const market = { quoteFor: (root) => (marks[root] ? { last: marks[root] } : null) };
  const router = new OrderRouter({
    client,
    contracts,
    user,
    market,
    lots: null,
    guard,
    config: { flatten_grace_secs: 30, fill_wait_ms: 0, max_order_size: 50, balance_offset: 'auto', brackets: 'separate', ...config },
  });
  return { router, client, user, contracts, marks };
}

/** Stub guard thunk: `canEnter` is scriptable and records its inputs. */
export function stubGuard({ ok = true, reason = null, maxRisk = 250 } = {}) {
  const guard = {
    calls: [],
    verdict: { ok, reason },
    last: { metrics: { maxRiskPerTrade: maxRisk } },
    canEnter(input) {
      this.calls.push(input);
      return this.verdict;
    },
  };
  return guard;
}

/**
 * GatewayApp on the mock upstream, listening on an ephemeral port. The guard is
 * made time-independent (weekends allowed, no entry window, overnight hold) so
 * the tests do not depend on when they run.
 */
export async function makeMockApp({ topstep = {}, gateway = {}, whitelist = ['MES/USD:USD'], dataOnly = false } = {}) {
  const tmp = tmpDir('gw-app-');
  const configPath = path.join(tmp.dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    dry_run: true,
    stake_currency: 'USD',
    exchange: { pair_whitelist: whitelist },
    projectx_gateway: { account_source: 'projectx', ticks: { record: false }, ...gateway },
    topstep: {
      session: { trade_weekends: true, hold_mode: 'overnight', no_entry_before: '00:00', no_entry_after: '00:00' },
      ...topstep,
    },
  }));
  const cfg = loadConfig({
    FREQTRADE_CONFIG: configPath,
    PROJECTX_MOCK: '1',
    GATEWAY_SECRET: SECRET,
    GATEWAY_DATA_DIR: tmp.dir,
    GATEWAY_PORT: '0',
    ...(dataOnly ? { GATEWAY_DATA_ONLY: '1' } : {}),
  });
  const app = new GatewayApp(cfg);
  await app.start();
  const http = app.server.server;
  if (!http.listening) await once(http, 'listening');
  const port = http.address().port;
  const base = `http://127.0.0.1:${port}`;

  const request = async (method, route, body, { secret = SECRET } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (secret !== null) headers['X-Gateway-Secret'] = secret;
    const res = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return {
    app,
    port,
    base,
    get: (route, opts) => request('GET', route, undefined, opts),
    post: (route, body, opts) => request('POST', route, body, opts),
    async stop() {
      await app.stop();
      tmp.remove();
    },
  };
}
