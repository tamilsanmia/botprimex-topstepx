import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { WebSocketServer } from 'ws';

import { rootOf } from './config.js';
import { GatewayError, badRequest } from './errors.js';
import { TIMEFRAMES } from './timeframes.js';

const MAX_BODY = 64 * 1024;

function secretOk(expected, given) {
  if (!expected) return true;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(badRequest('Request body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
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

const intOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

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
export function createServer(app, { secret, port }) {
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

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
  route('POST', /^\/order$/, (q, m, body) => app.router().place(body));
  route('POST', /^\/order\/([^/]+)\/cancel$/, (q, m) => app.router().cancel(m[1]));
  route('POST', /^\/order\/([^/]+)\/modify$/, (q, m, body) => app.router().modify(m[1], body));
  route('GET', /^\/mytrades$/, (q) => app.router().myTrades(q.get('symbol'), intOrNull(q.get('since'))));
  route('POST', /^\/position\/close$/, (q, m, body) => app.router().closePosition(body.symbol));
  route('GET', /^\/guard$/, () => app.guardState());
  route('POST', /^\/guard\/snapshot$/, (q, m, body) => app.guardSnapshot(body));
  route('POST', /^\/guard\/reset$/, (q, m, body) => app.guardReset(body.scope));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway');
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };

    try {
      if (url.pathname !== '/health' && !secretOk(secret, req.headers['x-gateway-secret'])) {
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
      if (err instanceof GatewayError) return send(err.status, err.toJSON());
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
    if (url.pathname !== '/ws' || !secretOk(secret, req.headers['x-gateway-secret'] || url.searchParams.get('secret'))) {
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

  server.listen(port, '0.0.0.0', () => console.log(`[server] listening on :${server.address().port}`));
  return { server, wss, broadcast, address: () => server.address() };
}
