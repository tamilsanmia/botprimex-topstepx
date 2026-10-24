import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cycleFor, rollAt } from '../src/contracts.js';
import { ContinuousHistory, contractChain } from '../src/history.js';
import { BAR_UNIT } from '../src/projectx.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 24, 12);

test('roll schedule: index rolls 8 days before the third Friday', () => {
  assert.equal(cycleFor('MES'), 'HMUZ');
  assert.equal(cycleFor('MCL'), 'FGHJKMNQUVXZ');
  assert.equal(cycleFor('MGC'), 'GJMQVZ');
  // Sep 2026 third Friday is the 18th -> roll on the 10th.
  assert.equal(new Date(rollAt('MES', 9, 2026)).toISOString().slice(0, 10), '2026-09-10');
});

test('contract chain walks back along the cycle to the retention limit', () => {
  const chain = contractChain({ contractId: 'CON.F.US.MES.Z26', name: 'MESZ6' }, {
    root: 'MES', start: NOW - 365 * DAY, end: NOW, now: NOW, retentionDays: 400,
  });
  assert.deepEqual(chain.map((c) => c.contractId), [
    'CON.F.US.MES.Z25', 'CON.F.US.MES.H26', 'CON.F.US.MES.M26', 'CON.F.US.MES.U26', 'CON.F.US.MES.Z26',
  ]);
  for (let i = 1; i < chain.length; i += 1) assert.equal(chain[i].from, chain[i - 1].to, 'segments are contiguous');
  assert.equal(chain.at(-1).to, Infinity);

  const crude = contractChain({ contractId: 'CON.F.US.MCLE.Z26', name: 'MCLZ6' }, {
    root: 'MCL', start: NOW - 60 * DAY, end: NOW, now: NOW,
  });
  assert.deepEqual(crude.map((c) => c.contractId).slice(-3), ['CON.F.US.MCLE.V26', 'CON.F.US.MCLE.X26', 'CON.F.US.MCLE.Z26']);
  assert.equal(contractChain({ contractId: 'CON.F.US.MES.Z26', name: 'MESZ6' }, {
    root: 'MES', start: NOW - DAY, end: NOW, now: NOW,
  }).length, 1, 'recent windows need only the front');
});

test('stitched history is back-adjusted by the gap at each roll', async () => {
  const H = 60 * 60 * 1000;
  // Older contract trades 10 points below the newer one at every timestamp.
  const priceOf = (id, ts) => (id.endsWith('Z26') ? 110 : 100) + (ts % (24 * H)) / H / 100;
  const requests = [];
  const client = {
    retrieveBars: async ({ contractId, unit, startTime, endTime }) => {
      requests.push(contractId);
      const step = unit === BAR_UNIT.HOUR ? H : DAY;
      const out = [];
      for (let t = Math.ceil(startTime / step) * step; t < endTime; t += step) {
        const p = priceOf(contractId, t);
        out.push([t, p, p, p, p, 1]);
      }
      return out;
    },
  };
  const contracts = { front: () => ({ contractId: 'CON.F.US.MES.Z26', name: 'MESZ6' }) };
  const history = new ContinuousHistory({ client, contracts, adjust: 'back', now: () => NOW });
  const roll = rollAt('MES', 9, 2026);
  const bars = await history.fetch({
    root: 'MES', spec: { unit: BAR_UNIT.HOUR, unitNumber: 1 }, startTime: roll - 2 * DAY, endTime: roll + 2 * DAY, limit: 20000,
  });
  const before = bars.filter((b) => b[0] < roll);
  const after = bars.filter((b) => b[0] >= roll);
  assert.ok(before.length > 0 && after.length > 0);
  assert.equal(before.at(-1)[4] - priceOf('CON.F.US.MES.U26', before.at(-1)[0]), 10, 'older bars shifted up by the 10-point gap');
  assert.equal(after[0][4], priceOf('CON.F.US.MES.Z26', after[0][0]), 'current contract unchanged');
  assert.equal(new Set(bars.map((b) => b[0])).size, bars.length, 'no duplicate timestamps');

  const raw = await new ContinuousHistory({ client, contracts, adjust: 'none', now: () => NOW }).fetch({
    root: 'MES', spec: { unit: BAR_UNIT.HOUR, unitNumber: 1 }, startTime: roll - DAY, endTime: roll + DAY, limit: 20000,
  });
  assert.equal(raw.find((b) => b[0] < roll)[4] < 105, true, 'none: raw older prices');

  requests.length = 0;
  const old = await history.fetch({
    root: 'MES', spec: { unit: BAR_UNIT.MINUTE, unitNumber: 5 }, startTime: NOW - 200 * DAY, endTime: NOW - 100 * DAY, limit: 20000,
  });
  assert.deepEqual(old, [], 'minute bars older than ProjectX keeps are not requested');
  assert.equal(requests.length, 0);
});
