import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';

import { WebSocketServer } from 'ws';

import { rootOf } from './config.js';
import { GatewayError, badRequest, permissionDenied } from './errors.js';
import { TIMEFRAMES } from './timeframes.js';

const MAX_BODY = 64 * 1024;

/**
 * Fails closed: with no secret configured nothing is authorised, unless the caller
 * explicitly opted in with `allowOpen` (mock mode only).
 */
function secretOk(expected, given, allowOpen = false) {
  if (!expected) return allowOpen === true;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        // Answer 400 and close the connection instead of destroying the socket,
        // which left the client with a reset and no explanation.
        reject(Object.assign(badRequest('Request body too large'), { closeConnection: true }));
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(badRequest('Body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`Expected a number, got "${String(v).slice(0, 40)}"`);
  return n;
}

function ipv4ToInt(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4 || parts.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return parts.reduce((acc, x) => acc * 256 + Number(x), 0);
}

/**
 * Address to listen on. Without a subnet it is `bind` as given. With a subnet
 * (IPv4 CIDR, e.g. 172.20.0.0/16) it is the address of the interface inside it, so
 * the gateway can listen on the internal Docker network only. Throws when no
 * interface matches: starting on a wider address than asked for would be unsafe.
 */
export function pickBindAddress(bind, subnet, interfaces = os.networkInterfaces()) {
  const wanted = String(subnet || '').trim();
  if (!wanted) return bind || '0.0.0.0';
  const [net, bitsText = '32'] = wanted.split('/');
  const base = ipv4ToInt(net);
  const bits = Number(bitsText);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new Error(`GATEWAY_BIND_SUBNET must be an IPv4 CIDR like 172.20.0.0/16, got "${wanted}"`);
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  for (const addrs of Object.values(interfaces || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      const ip = ipv4ToInt(a.address);
      if (ip !== null && ((ip & mask) >>> 0) === ((base & mask) >>> 0)) return a.address;
    }
  }
  throw new Error(`GATEWAY_BIND_SUBNET ${wanted} matches no network interface; refusing to start on a wider address`);
}

function needSymbol(q) {
  const symbol = q.get('symbol');
  if (!symbol) throw badRequest('symbol is required');
  return symbol;
}

function needTimeframe(q) {
  const tf = q.get('timeframe') || '1m';
  if (!TIMEFRAMES[tf]) throw badRequest(`Unsupported timeframe ${tf}`);
  return tf;
}

/**
 * Local API for the Freqtrade adapter. It listens on the internal Docker network
 * only (no published port) and every route except /health needs the shared
 * secret in `X-Gateway-Secret`, because it can place orders on a real account.
 */
export function createServer(app, { secret, port, bind = '0.0.0.0', bindSubnet = '', allowOpen = false, allowQuerySecret = false, dataOnly = false }) {
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });
  const listenAddress = pickBindAddress(bind, bindSubnet);
  const orderRoute = (method, pattern, handler) => route(method, pattern, (q, m, body) => {
    if (dataOnly) throw permissionDenied('This gateway runs in data-only mode (GATEWAY_DATA_ONLY=1): order routes are disabled');
    return handler(q, m, body);
  });

  route('GET', /^\/health$/, () => app.health());
  route('GET', /^\/status$/, () => app.status());
  route('GET', /^\/markets$/, () => app.markets());
  route('GET', /^\/ohlcv$/, (q) => app.ohlcv(rootOf(needSymbol(q)), needTimeframe(q), intOrNull(q.get('since')), intOrNull(q.get('limit')) ?? 1000));
  route('GET', /^\/ticker$/, (q) => app.ticker(needSymbol(q)));
  route('GET', /^\/tickers$/, (q) => app.tickers((q.get('symbols') || '').split(',').filter(Boolean)));
  route('GET', /^\/orderbook$/, (q) => app.orderbook(needSymbol(q)));
  route('GET', /^\/trades$/, (q) => app.publicTrades(needSymbol(q), intOrNull(q.get('since')), intOrNull(q.get('limit')) ?? 1000));
  route('GET', /^\/orderflow\/features$/, (q) => app.orderflowFeatures(needSymbol(q), needTimeframe(q), intOrNull(q.get('since'))));
  route('GET', /^\/balance$/, () => app.router().balance(app.stake));
  route('GET', /^\/positions$/, (q) => app.router().positions((q.get('symbols') || '').split(',').filter(Boolean)));
  route('GET', /^\/orders\/open$/, (q) => app.router().openOrders(q.get('symbol')));
  route('GET', /^\/orders$/, (q) => app.router().orders(q.get('symbol'), intOrNull(q.get('since'))));
  route('GET', /^\/order\/([^/]+)$/, (q, m) => app.router().getOrder(m[1]));
  orderRoute('POST', /^\/order$/, (q, m, body) => app.router().place(body));
  orderRoute('POST', /^\/order\/([^/]+)\/cancel$/, (q, m) => app.router().cancel(m[1]));
  orderRoute('POST', /^\/order\/([^/]+)\/modify$/, (q, m, body) => app.router().modify(m[1], body));
  route('GET', /^\/mytrades$/, (q) => app.router().myTrades(q.get('symbol'), intOrNull(q.get('since'))));
  orderRoute('POST', /^\/position\/close$/, (q, m, body) => app.router().closePosition(body.symbol));
  route('GET', /^\/guard$/, () => app.guardState());
  route('POST', /^\/guard\/snapshot$/, (q, m, body) => app.guardSnapshot(body));
  route('POST', /^\/guard\/reset$/, (q, m, body) => app.guardReset(body.scope));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway');
    const send = (status, payload, headers = {}) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers });
      res.end(body);
    };

    try {
      if (url.pathname !== '/health' && !secretOk(secret, req.headers['x-gateway-secret'], allowOpen)) {
        throw new GatewayError('Bad or missing X-Gateway-Secret', { status: 401, kind: 'AuthenticationError' });
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const match = r.pattern.exec(url.pathname);
        if (!match) continue;
        const body = req.method === 'POST' ? await readBody(req) : null;
        const result = await r.handler(url.searchParams, match, body);
        return send(200, result ?? null);
      }
      throw new GatewayError(`No route ${req.method} ${url.pathname}`, { status: 404, kind: 'BadRequest' });
    } catch (err) {
      if (err instanceof GatewayError) return send(err.status, err.toJSON(), err.closeConnection ? { Connection: 'close' } : {});
      console.error(`[server] ${req.method} ${url.pathname} failed:`, err);
      return send(500, { error: err.message, kind: 'ExchangeError' });
    }
  });

  /**
   * WebSocket: `{"op":"subscribe","channel":"ohlcv","symbol":"MES/USD:USD","timeframe":"1m"}`,
   * `{"op":"subscribe","channel":"ticker","symbol":...}` or `{"op":"subscribe","channel":"guard"}`.
   * Pushes `{channel, symbol, timeframe, data}`.
   */
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://gateway');
    // A secret in the URL ends up in access logs and proxies, so it is opt-in.
    const given = req.headers['x-gateway-secret'] || (allowQuerySecret ? url.searchParams.get('secret') : null);
    if (url.pathname !== '/ws' || !secretOk(secret, given, allowOpen)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    ws.subs = new Set();
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.op !== 'subscribe' && msg.op !== 'unsubscribe') return;
      const key = msg.channel === 'guard' ? 'guard' : `${msg.channel}|${rootOf(msg.symbol)}|${msg.timeframe || ''}`;
      if (msg.op === 'unsubscribe') {
        ws.subs.delete(key);
        return;
      }
      ws.subs.add(key);
      try {
        if (msg.channel === 'ohlcv') {
          if (!TIMEFRAMES[msg.timeframe]) throw badRequest(`Unsupported timeframe ${msg.timeframe}`);
          const bars = await app.ohlcv(rootOf(msg.symbol), msg.timeframe, null, 3);
          ws.send(JSON.stringify({ channel: 'ohlcv', symbol: msg.symbol, timeframe: msg.timeframe, data: bars }));
        } else if (msg.channel === 'ticker') {
          ws.send(JSON.stringify({ channel: 'ticker', symbol: msg.symbol, data: await app.ticker(msg.symbol) }));
        } else if (msg.channel === 'guard') {
          ws.send(JSON.stringify({ channel: 'guard', data: app.guardState() }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ channel: msg.channel, symbol: msg.symbol, error: err.message, kind: err.kind || 'ExchangeError' }));
      }
    });
  });

  const broadcast = (key, payload) => {
    let text = null;
    for (const ws of wss.clients) {
      if (ws.readyState !== 1 || !ws.subs?.has(key)) continue;
      text ??= JSON.stringify(payload);
      ws.send(text);
    }
  };

  server.listen(port, listenAddress, () => console.log(`[server] listening on ${listenAddress}:${server.address().port}`));
  return { server, wss, broadcast, address: () => server.address() };
}
