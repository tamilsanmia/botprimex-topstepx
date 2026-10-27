import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { StartupError, assertStartable, installProcessHandlers } from '../src/index.js';
import { tmpDir } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function setup({ guard } = {}) {
  const proc = new EventEmitter();
  const exits = [];
  const notes = [];
  const app = { notify: async (t) => { notes.push(t); }, guard };
  const remove = installProcessHandlers(app, { exit: (c) => exits.push(c), proc });
  return { proc, exits, notes, app, remove };
}

test('an unhandled rejection is logged and announced, and the process keeps running', (t) => {
  const err = t.mock.method(console, 'error', () => {});
  const { proc, exits, notes } = setup();
  proc.emit('unhandledRejection', new Error('lost promise'));
  proc.emit('unhandledRejection', 'a plain string');
  assert.deepEqual(exits, []);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /unhandled rejection.*lost promise/);
  assert.match(notes[1], /a plain string/);
  assert.equal(err.mock.callCount(), 2);
});

test('an uncaught exception flushes the guard and exits with code 1', (t) => {
  t.mock.method(console, 'error', () => {});
  const flushed = [];
  const { proc, exits, notes } = setup({ guard: { flush: () => flushed.push('flush') } });
  proc.emit('uncaughtException', new Error('kaboom'));
  assert.deepEqual(flushed, ['flush']);
  assert.deepEqual(exits, [1]);
  assert.match(notes[0], /uncaught exception.*kaboom/);
});

test('without flush() the guard state is persisted instead', (t) => {
  t.mock.method(console, 'error', () => {});
  const calls = [];
  const { proc, exits } = setup({ guard: { persist: () => calls.push('persist') } });
  proc.emit('uncaughtException', new Error('x'));
  assert.deepEqual(calls, ['persist']);
  assert.deepEqual(exits, [1]);
});

test('the process still exits when the guard flush or the notifier throws', (t) => {
  t.mock.method(console, 'error', () => {});
  const proc = new EventEmitter();
  const exits = [];
  installProcessHandlers({
    notify: () => { throw new Error('telegram down'); },
    guard: { flush: () => { throw new Error('disk full'); } },
  }, { exit: (c) => exits.push(c), proc });
  proc.emit('uncaughtException', new Error('x'));
  assert.deepEqual(exits, [1]);
});

test('an app without a guard (data-only) exits cleanly on an uncaught exception', (t) => {
  t.mock.method(console, 'error', () => {});
  const { proc, exits } = setup({ guard: null });
  proc.emit('uncaughtException', new Error('x'));
  assert.deepEqual(exits, [1]);
});

test('the returned function removes the handlers', () => {
  const { proc, remove } = setup();
  assert.equal(proc.listenerCount('unhandledRejection'), 1);
  assert.equal(proc.listenerCount('uncaughtException'), 1);
  remove();
  assert.equal(proc.listenerCount('unhandledRejection'), 0);
  assert.equal(proc.listenerCount('uncaughtException'), 0);
});

test('mock mode with dry_run false refuses to start', () => {
  const live = { FREQTRADE_CONFIG: '/nonexistent/config.json', PROJECTX_MOCK: '1', GATEWAY_SECRET: 's' };
  assert.doesNotThrow(() => assertStartable(loadConfig(live)), 'mock with the default dry_run (true) is fine');
  const cfg = { ...loadConfig(live), dryRun: false };
  assert.throws(() => assertStartable(cfg), (err) => err instanceof StartupError && /dry_run/.test(err.message));
  assert.doesNotThrow(() => assertStartable({ ...cfg, mock: false }), 'a real upstream with dry_run false is the normal live setup');
});

function runGateway(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: root,
      env: { PATH: process.env.PATH, FREQTRADE_CONFIG: '/nonexistent/config.json', ...env },
    });
    let output = '';
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`gateway did not exit: ${output}`)); }, 10_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test('the gateway process exits with code 2 and a message when GATEWAY_SECRET is empty', async () => {
  const { code, output } = await runGateway({ GATEWAY_SECRET: '' });
  assert.equal(code, 2);
  assert.match(output, /refusing to start.*GATEWAY_SECRET/s);
});

test('the gateway process exits with code 2 for mock mode with dry_run false', async () => {
  const tmp = tmpDir('gw-live-mock-');
  try {
    const cfg = path.join(tmp.dir, 'config.json');
    writeFileSync(cfg, JSON.stringify({ dry_run: false }));
    const { code, output } = await runGateway({ PROJECTX_MOCK: '1', GATEWAY_SECRET: 's', FREQTRADE_CONFIG: cfg });
    assert.equal(code, 2);
    assert.match(output, /dry_run/);
  } finally {
    tmp.remove();
  }
});
