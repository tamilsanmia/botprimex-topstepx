import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ManagedHub, entries } from '../src/hub.js';
import { sleep, waitFor } from './helpers.js';

/** SignalR connection stand-in; the test drives its lifecycle callbacks directly. */
class FakeSignalR {
  constructor(registry, opts) {
    this.opts = opts;
    this.handlers = new Map();
    this.started = false;
    this.stopped = false;
    this.invocations = [];
    this.failStart = registry.failNext > 0 ? (registry.failNext -= 1, true) : false;
    registry.hubs.push(this);
  }

  on(event, fn) { this.handlers.set(event, fn); }
  emit(event, ...args) { return this.handlers.get(event)?.(...args); }
  onreconnecting(fn) { this.reconnectingCb = fn; }
  onreconnected(fn) { this.reconnectedCb = fn; }
  onclose(fn) { this.closeCb = fn; }

  async start() {
    if (this.failStart) throw new Error('negotiation failed');
    this.started = true;
  }

  async stop() { this.stopped = true; }

  async invoke(method, ...args) {
    this.invocations.push([method, ...args]);
    return `${method}:ok`;
  }
}

function setup({ steps = [5, 5], handlers = {}, onReady, failNext = 0 } = {}) {
  const registry = { hubs: [], failNext };
  const ready = [];
  const states = [];
  const hub = new ManagedHub({
    name: 'test-hub',
    url: 'http://hub.invalid',
    tokenFactory: () => 'token',
    handlers,
    onReady: onReady || (async (conn, info) => { ready.push({ conn, info }); }),
    onState: (state, info) => states.push(info ? [state, info] : state),
    factory: (opts) => new FakeSignalR(registry, opts),
    rebuildStepsMs: steps,
  });
  return { hub, registry, ready, states };
}

test('rebuild delays default to the production backoff and can be overridden', () => {
  const production = new ManagedHub({ name: 'p', url: 'u', tokenFactory: () => 't', handlers: {}, onReady: async () => {} });
  assert.deepEqual(production.rebuildStepsMs, [2000, 5000, 10000, 30000]);
  const custom = setup({ steps: [1, 2, 3] });
  assert.deepEqual(custom.hub.rebuildStepsMs, [1, 2, 3]);
});

test('start connects once, runs onReady with reconnected:false and reports status', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { hub, registry, ready, states } = setup({ handlers: { Ping: () => {} } });
  assert.equal(hub.state, 'idle');
  assert.deepEqual(hub.status(), { state: 'idle', lastMessageAt: null, ageMs: null, connectedAt: null, stateSince: null });

  await hub.start();

  assert.equal(registry.hubs.length, 1);
  assert.equal(registry.hubs[0].started, true);
  assert.equal(registry.hubs[0].opts.url, 'http://hub.invalid');
  assert.equal(registry.hubs[0].opts.tokenFactory(), 'token');
  assert.equal(ready.length, 1);
  assert.deepEqual(ready[0].info, { reconnected: false });
  assert.equal(ready[0].conn, registry.hubs[0]);
  assert.deepEqual(states, ['connecting', 'connected']);

  const status = hub.status();
  assert.equal(status.state, 'connected');
  assert.ok(status.connectedAt > 0);
  assert.equal(status.lastMessageAt, null);
  assert.equal(status.ageMs, null);
  assert.ok(status.stateSince > 0, 'the time of the last state change is exposed');

  registry.hubs[0].emit('Ping');
  assert.ok(hub.status().lastMessageAt > 0, 'any hub message refreshes lastMessageAt');
  assert.ok(hub.status().ageMs >= 0, 'ageMs counts from the last message');
  await hub.stop();
});

test('invoke forwards to the live connection and fails when there is none', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { hub, registry } = setup();
  await assert.rejects(hub.invoke('X'), /test-hub is not connected/);
  await hub.start();
  assert.equal(await hub.invoke('SubscribeAccounts', 7), 'SubscribeAccounts:ok');
  assert.deepEqual(registry.hubs[0].invocations, [['SubscribeAccounts', 7]]);
  await hub.stop();
  await assert.rejects(hub.invoke('X'), /not connected/);
});

test('onReady re-runs with reconnected:true when SignalR reconnects by itself', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { hub, registry, ready, states } = setup();
  await hub.start();

  registry.hubs[0].reconnectingCb(new Error('socket dropped'));
  assert.equal(hub.state, 'reconnecting');
  await registry.hubs[0].reconnectedCb();

  assert.equal(ready.length, 2);
  assert.deepEqual(ready[1].info, { reconnected: true });
  assert.equal(hub.state, 'connected');
  assert.deepEqual(states, ['connecting', 'connected', ['reconnecting', 'socket dropped'], 'connected']);
  assert.equal(registry.hubs.length, 1, 'no new connection is built for a built-in reconnect');
  await hub.stop();
});

test('a failing resubscribe after a reconnect is logged and leaves the state not connected', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const { hub, registry } = setup({
    onReady: async () => { calls += 1; if (calls === 2) throw new Error('invoke failed'); },
  });
  await hub.start();
  registry.hubs[0].reconnectingCb();
  await registry.hubs[0].reconnectedCb();
  assert.equal(hub.state, 'reconnecting');
  assert.match(warn.mock.calls[0].arguments[0], /resubscribe failed: invoke failed/);
  await hub.stop();
});

test('after SignalR gives up (close) the hub is rebuilt and onReady runs again', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { hub, registry, ready, states } = setup({ steps: [5, 5] });
  await hub.start();

  registry.hubs[0].closeCb(new Error('gave up'));
  assert.equal(hub.state, 'disconnected');
  assert.equal(hub.connection, null);
  assert.ok(hub.rebuildTimer, 'a rebuild is scheduled');

  await waitFor(() => registry.hubs.length === 2 && hub.state === 'connected');
  assert.equal(registry.hubs[1].started, true);
  assert.equal(ready.length, 2);
  assert.deepEqual(ready[1].info, { reconnected: false }, 'a rebuild is a fresh connect, not a reconnect');
  assert.equal(hub.rebuildAttempt, 0, 'backoff resets after a successful connect');
  assert.deepEqual(states.slice(0, 4), ['connecting', 'connected', ['disconnected', 'gave up'], 'connecting']);
  await hub.stop();
});

test('a close from a connection that was already replaced is ignored', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { hub, registry } = setup({ steps: [5] });
  await hub.start();
  const first = registry.hubs[0];
  first.closeCb(new Error('first lost'));
  await waitFor(() => registry.hubs.length === 2 && hub.state === 'connected');

  first.closeCb(new Error('late echo'));
  await sleep(40);
  assert.equal(registry.hubs.length, 2, 'no extra rebuild');
  assert.equal(hub.state, 'connected');
  await hub.stop();
});

test('rebuild keeps backing off through failures, then recovers', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { hub, registry, ready } = setup({ steps: [5, 10], failNext: 0 });
  await hub.start();

  registry.failNext = 2;
  registry.hubs[0].closeCb();
  await waitFor(() => registry.hubs.length === 4 && hub.state === 'connected', 2000);

  assert.equal(registry.hubs[1].started, false);
  assert.equal(registry.hubs[2].started, false);
  assert.equal(registry.hubs[3].started, true);
  assert.equal(ready.length, 2, 'onReady only ran for the successful connects');
  assert.equal(hub.rebuildAttempt, 0);
  await hub.stop();
});

test('an initial connect failure schedules a rebuild instead of throwing', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const { hub, registry, ready } = setup({ steps: [5], failNext: 1 });
  await hub.start();
  assert.equal(hub.state, 'disconnected');
  assert.match(warn.mock.calls[0].arguments[0], /connect failed: negotiation failed/);
  assert.equal(ready.length, 0);

  await waitFor(() => hub.state === 'connected');
  assert.equal(registry.hubs.length, 2);
  assert.equal(ready.length, 1);
  await hub.stop();
});

test('stop() cancels a pending rebuild and closes the connection', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { hub, registry } = setup({ steps: [30] });
  await hub.start();
  registry.hubs[0].closeCb();
  assert.ok(hub.rebuildTimer);

  await hub.stop();
  assert.equal(hub.rebuildTimer, null);
  assert.equal(hub.state, 'stopped');
  await sleep(80);
  assert.equal(registry.hubs.length, 1, 'no rebuild after stop');

  await hub.stop();
  assert.equal(hub.state, 'stopped', 'stop is idempotent');
});

test('stop() stops the live connection and a close afterwards does not rebuild', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { hub, registry } = setup({ steps: [5] });
  await hub.start();
  const conn = registry.hubs[0];
  await hub.stop();
  assert.equal(conn.stopped, true);
  conn.closeCb(new Error('closed by stop'));
  await sleep(40);
  assert.equal(registry.hubs.length, 1);
});

test('connect() again stops the previous connection first', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { hub, registry } = setup();
  await hub.start();
  await hub.connect();
  assert.equal(registry.hubs.length, 2);
  assert.equal(registry.hubs[0].stopped, true);
  assert.equal(hub.connection, registry.hubs[1]);
  await hub.stop();
});

test('an exception in an event handler is logged and does not break the hub', async (t) => {
  t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const seen = [];
  const { hub, registry } = setup({
    handlers: {
      Boom: () => { throw new Error('bad payload'); },
      Good: (x) => seen.push(x),
    },
  });
  await hub.start();
  const conn = registry.hubs[0];

  assert.doesNotThrow(() => conn.emit('Boom', 1));
  conn.emit('Good', 2);
  conn.emit('Boom', 3);
  conn.emit('Good', 4);

  assert.deepEqual(seen, [2, 4]);
  assert.equal(error.mock.calls.length, 2);
  assert.match(error.mock.calls[0].arguments[0], /handler Boom failed/);
  assert.equal(hub.state, 'connected');
  await hub.stop();
});

test('entries() normalises single objects, arrays and empty payloads', () => {
  assert.deepEqual(entries([1, 2]), [1, 2]);
  assert.deepEqual(entries({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(entries(null), []);
  assert.deepEqual(entries(undefined), []);
});
