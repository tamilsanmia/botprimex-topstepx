import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CandleStore } from '../src/candles.js';
import { MarketStream } from '../src/marketStream.js';
import { createMockUpstream } from '../src/mock.js';
import { waitFor } from './helpers.js';

const quiet = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

/** MarketStream on the mock hub, keeping every hub it builds so a test can drop the connection. */
function setup() {
  const upstream = createMockUpstream({});
  const built = [];
  const contracts = {
    front: (root) => {
      const c = upstream.client.exchange.contracts.find((x) => x.name === `${root}Z6`);
      return c ? { contractId: c.id } : null;
    },
    rootForContract: (id) => String(id).split('.')[3],
  };
  const market = new MarketStream({
    url: 'mock://market',
    tokenFactory: () => 't',
    contracts,
    hubFactory: (opts) => {
      const hub = upstream.marketHubFactory(opts);
      built.push(hub);
      return hub;
    },
    rebuildStepsMs: [5],
  });
  return { market, built };
}

test('a rebuilt market hub emits reconnected with the wanted roots, the first connect does not', async (t) => {
  quiet(t);
  const { market, built } = setup();
  const seen = [];
  market.on('reconnected', (roots) => seen.push(roots));
  await market.start(['MES', 'MNQ']);
  try {
    assert.equal(market.hub.state, 'connected');
    assert.equal(seen.length, 0, 'a fresh start is not a reconnect');
    assert.deepEqual(market.status().live, ['MES', 'MNQ']);

    // SignalR gave up on the socket: the hub is rebuilt with new subscriptions.
    for (const fn of built[0].closeHandlers) fn(new Error('connection lost'));
    assert.equal(market.hub.state, 'disconnected');
    await waitFor(() => built.length === 2 && market.hub.state === 'connected');
    await waitFor(() => seen.length === 1);

    assert.deepEqual(seen[0].sort(), ['MES', 'MNQ']);
    assert.deepEqual(market.status().live, ['MES', 'MNQ'], 'the rebuilt hub was subscribed again');
  } finally {
    await market.stop();
  }
});

test('reconnected drives CandleStore.repair for every root, as index.js wires it', async (t) => {
  quiet(t);
  const { market, built } = setup();
  const repaired = [];
  const store = new CandleStore({ fetchBars: async () => [] });
  store.repair = async (root) => { repaired.push(root); };
  market.on('reconnected', (rs) => rs.forEach((r) => store.repair(r)));
  await market.start(['MES']);
  try {
    for (const fn of built[0].closeHandlers) fn(new Error('connection lost'));
    await waitFor(() => repaired.length === 1);
    assert.deepEqual(repaired, ['MES']);
  } finally {
    await market.stop();
    store.close();
  }
});

test('the hub goes down and up again with the state and age that dataHealth reads', async (t) => {
  quiet(t);
  const { market, built } = setup();
  await market.start(['MES']);
  try {
    const up = market.hub.stateAt;
    assert.ok(up > 0);
    for (const fn of built[0].closeHandlers) fn(new Error('connection lost'));
    assert.equal(market.hub.state, 'disconnected');
    assert.ok(market.hub.stateAt >= up);
    await waitFor(() => market.hub.state === 'connected');
    assert.ok(market.quoteAgeMs('MES') >= 0, 'the age restarts at the new subscription');
  } finally {
    await market.stop();
  }
});
