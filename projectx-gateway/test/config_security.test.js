import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { GatewayApp, StartupError, assertStartable } from '../src/index.js';
import { pickBindAddress } from '../src/server.js';

const ifaces = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [
    { address: '172.20.0.5', family: 'IPv4', internal: false },
    { address: 'fe80::1', family: 'IPv6', internal: false },
  ],
  eth1: [{ address: '192.168.16.2', family: 'IPv4', internal: false }],
};

test('pickBindAddress: no subnet means the bind address as given, 0.0.0.0 by default', () => {
  assert.equal(pickBindAddress('0.0.0.0', '', ifaces), '0.0.0.0');
  assert.equal(pickBindAddress('127.0.0.1', undefined, ifaces), '127.0.0.1');
  assert.equal(pickBindAddress('', '', ifaces), '0.0.0.0');
});

test('pickBindAddress: a subnet selects the interface address inside it', () => {
  assert.equal(pickBindAddress('0.0.0.0', '172.20.0.0/16', ifaces), '172.20.0.5');
  assert.equal(pickBindAddress('0.0.0.0', '192.168.16.0/24', ifaces), '192.168.16.2');
  assert.equal(pickBindAddress('0.0.0.0', '172.20.0.5/32', ifaces), '172.20.0.5');
  assert.equal(pickBindAddress('0.0.0.0', '172.20.0.5', ifaces), '172.20.0.5', 'a bare address is a /32');
  assert.equal(pickBindAddress('0.0.0.0', '127.0.0.0/8', ifaces), '127.0.0.1');
});

test('pickBindAddress: the subnet wins over bind, and numeric family 4 is understood', () => {
  assert.equal(pickBindAddress('0.0.0.0', '10.1.0.0/16', { eth: [{ address: '10.1.2.3', family: 4 }] }), '10.1.2.3');
  assert.equal(pickBindAddress('127.0.0.1', '172.20.0.0/16', ifaces), '172.20.0.5');
});

test('pickBindAddress fails closed when no interface is inside the subnet', () => {
  assert.throws(() => pickBindAddress('0.0.0.0', '10.9.0.0/16', ifaces), /matches no network interface/);
  assert.throws(() => pickBindAddress('0.0.0.0', '172.21.0.0/16', ifaces), /matches no network interface/);
  assert.throws(() => pickBindAddress('0.0.0.0', '172.20.0.0/16', {}), /matches no network interface/);
  // IPv6 addresses never satisfy an IPv4 CIDR.
  assert.throws(() => pickBindAddress('0.0.0.0', '10.0.0.0/8', { x: [{ address: 'fe80::1', family: 'IPv6' }] }), /matches no network interface/);
});

test('pickBindAddress rejects a malformed subnet', () => {
  for (const bad of ['nonsense', '172.20.0.0/33', '172.20.0/16', '300.1.1.1/8', '172.20.0.0/x', 'fe80::/10']) {
    assert.throws(() => pickBindAddress('0.0.0.0', bad, ifaces), /IPv4 CIDR/, bad);
  }
});

test('pickBindAddress with /0 matches the first IPv4 interface', () => {
  assert.equal(pickBindAddress('0.0.0.0', '0.0.0.0/0', ifaces), '127.0.0.1');
});

test('loadConfig reads bind, subnet and the two opt-in flags, all off by default', () => {
  const base = { FREQTRADE_CONFIG: '/nonexistent/config.json' };
  const off = loadConfig(base);
  assert.equal(off.bind, '0.0.0.0');
  assert.equal(off.bindSubnet, '');
  assert.equal(off.allowQuerySecret, false);
  assert.equal(off.dataOnly, false);
  const on = loadConfig({ ...base, GATEWAY_BIND: '127.0.0.1', GATEWAY_BIND_SUBNET: '172.20.0.0/16', GATEWAY_ALLOW_QUERY_SECRET: '1', GATEWAY_DATA_ONLY: '1' });
  assert.equal(on.bind, '127.0.0.1');
  assert.equal(on.bindSubnet, '172.20.0.0/16');
  assert.equal(on.allowQuerySecret, true);
  assert.equal(on.dataOnly, true);
  assert.equal(loadConfig({ ...base, GATEWAY_DATA_ONLY: '0' }).dataOnly, false);
});

test('an empty GATEWAY_SECRET refuses to start unless PROJECTX_MOCK is set', () => {
  const base = { FREQTRADE_CONFIG: '/nonexistent/config.json' };
  assert.throws(() => assertStartable(loadConfig(base)), StartupError);
  assert.throws(() => new GatewayApp(loadConfig(base)), /GATEWAY_SECRET is empty/);
  assert.doesNotThrow(() => assertStartable(loadConfig({ ...base, GATEWAY_SECRET: 'x' })));
  assert.doesNotThrow(() => assertStartable(loadConfig({ ...base, PROJECTX_MOCK: '1' })));
});
