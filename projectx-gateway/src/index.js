import path from 'node:path';

import { CandleStore } from './candles.js';
import { loadConfig, pairOf, rootOf } from './config.js';
import { ContractBook } from './contracts.js';
import { GatewayError } from './errors.js';
import { AccountGuard, summarizeFills } from './guard.js';
import { ContinuousHistory } from './history.js';
import { RateLimiter } from './limiter.js';
import { LotTable } from './lots.js';
import { MarketStream } from './marketStream.js';
import { createMockUpstream } from './mock.js';
import { createNotifier } from './notifier.js';
import { OrderflowService } from './orderflow.js';
import { ProjectXClient } from './projectx.js';
import { OrderRouter } from './router.js';
import { RulesError, resolveRules } from './rules.js';
import { createServer } from './server.js';
import { SessionClock } from './session.js';
import { TickStore } from './ticks.js';
import { timeframe } from './timeframes.js';
import { UserStream } from './userStream.js';

const GUARD_THROTTLE_MS = 200;
const HISTORY_DAYS = 90;

export class GatewayApp {
  constructor(cfg) {
    this.cfg = cfg;
    this.stake = cfg.stakeCurrency;
    this.limiter = new RateLimiter(cfg.gateway.rate_limits);
    this.notify = createNotifier(cfg.telegram);
    this.ready = false;
    this.guard = null;
    this.guardSource = cfg.gateway.account_source === 'auto'
      ? (cfg.dryRun ? 'freqtrade' : 'projectx')
      : cfg.gateway.account_source;
    this.snapshot = null;
    this.guardTimer = null;
    this.startError = null;

    if (cfg.mock) {
      this.upstream = createMockUpstream(cfg);
      console.warn('[gateway] MOCK upstream: synthetic contracts, prices and fills. Never use for real trading.');
    } else {
      this.upstream = { client: new ProjectXClient(cfg.projectx, this.limiter) };
    }
    this.client = this.upstream.client;
    this.lots = new LotTable(cfg.topstep.lots || {});
    this.contracts = new ContractBook(this.client, this.lots, { quote: this.stake });
  }

  async start() {
    const cfg = this.cfg;
    await this.retry('load contracts', () => this.contracts.refresh());
    const roots = cfg.whitelist.map(rootOf).filter((r) => {
      if (this.contracts.front(r)) return true;
      console.warn(`[gateway] ${r} is in the whitelist but has no front contract on this data subscription`);
      return false;
    });
    this.roots = roots;
    const recordSetting = cfg.gateway.ticks.pairs;
    this.recordRoots = new Set(Array.isArray(recordSetting) ? recordSetting.map(rootOf) : roots);

    this.clock = new SessionClock({
      timezone: cfg.topstep.timezone || 'America/New_York',
      reset_time: cfg.topstep.session?.reset_time || '18:00',
      eod_time: cfg.topstep.session?.eod_time || '16:10',
    });

    this.history = new ContinuousHistory({
      client: this.client,
      contracts: this.contracts,
      enabled: cfg.gateway.history.continuous !== false,
      adjust: cfg.gateway.history.adjust,
      retentionDays: cfg.gateway.history.retention_days,
      minuteRetentionDays: cfg.gateway.history.minute_retention_days,
      secondRetentionDays: cfg.gateway.history.second_retention_days,
    });
    this.store = new CandleStore({
      maxCandles: cfg.gateway.max_candles,
      backfillCandles: cfg.gateway.backfill_candles,
      fetchBars: ({ root, tf, startTime, endTime, limit, priority }) => {
        if (!this.contracts.front(root)) throw new GatewayError(`Unknown root ${root}`, { status: 404, kind: 'BadSymbol' });
        return this.history.fetch({ root, spec: timeframe(tf), startTime, endTime, limit, priority });
      },
    });
    this.ticks = new TickStore({
      dir: path.join(cfg.dataDir, 'ticks'),
      retentionDays: cfg.gateway.ticks.retention_days,
      enabled: cfg.gateway.ticks.record !== false,
    });
    this.orderflow = new OrderflowService({
      tickStore: this.ticks,
      clock: this.clock,
      blockMultiple: cfg.gateway.orderflow.block_multiple,
      valueAreaPct: cfg.gateway.orderflow.value_area_pct,
    });

    const tokenFactory = () => this.client.getToken();
    this.market = new MarketStream({
      url: cfg.projectx.marketHub, tokenFactory, contracts: this.contracts, hubFactory: this.upstream.marketHubFactory,
    });
    this.market.on('tick', (root, tick) => {
      this.store.onTick(root, tick.ts, tick.price, tick.size);
      if (this.recordRoots.has(root)) this.ticks.record(root, tick);
      this.scheduleGuard();
    });
    const onBook = (root, q) => {
      if (this.recordRoots.has(root)) this.ticks.recordQuote(root, q.ts || Date.now(), q.bid, q.ask);
      this.scheduleGuard();
    };
    this.market.on('quote', onBook);
    this.market.on('depth', onBook);
    this.market.on('reconnected', (rs) => rs.forEach((r) => this.store.repair(r)));

    this.user = new UserStream({
      client: this.client,
      url: cfg.projectx.userHub,
      tokenFactory,
      hubFactory: this.upstream.userHubFactory,
      accountSelector: cfg.gateway.account,
      reconcileSecs: cfg.gateway.reconcile_secs,
    });

    const server = createServer(this, { secret: cfg.secret, port: cfg.port });
    this.server = server;
    this.store.on('candles', (root, tf, bars) => {
      server.broadcast(`ohlcv|${root}|${tf}`, { channel: 'ohlcv', symbol: pairOf(root, this.stake), timeframe: tf, data: bars });
    });
    this.market.on('quote', (root) => this.broadcastTicker(root));

    await this.market.start(roots);

    if (this.guardSource === 'projectx') {
      await this.retry('load account', () => this.user.start({ tradesSince: Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000 }));
    } else {
      try {
        this.user.accounts = await this.client.searchAccounts({ onlyActive: true });
        this.user.account = this.user.selectAccount(this.user.accounts);
      } catch (err) {
        console.warn(`[gateway] dry-run: no account auto-detected (${err.message}); topstep phase and preset must be explicit`);
      }
    }

    this.router_ = new OrderRouter({
      client: this.client,
      contracts: this.contracts,
      user: this.user,
      market: this.market,
      lots: this.lots,
      guard: this.guard ? () => this.guard : null,
      config: cfg.gateway,
      notify: this.notify,
    });
    this.setupGuard();
    this.router_.guard = this.guard ? () => this.guard : null;
    this.user.on('orphan-cancelled', (o, reason) => this.notify(`cancelled orphan protective order ${o.id} (${reason})`));
    for (const ev of ['trade', 'position', 'account']) this.user.on(ev, () => this.scheduleGuard());

    this.guardTimer = setInterval(() => this.evaluateGuard(), 1000);
    this.guardTimer.unref?.();
    this.rollTimer = setInterval(() => this.checkRolls().catch((err) => console.warn(`[gateway] roll check failed: ${err.message}`)), 10 * 60 * 1000);
    this.rollTimer.unref?.();

    this.ready = true;
    console.log(`[gateway] ready: ${roots.length} pairs, guard ${this.guard ? `${this.guard.resolved.phase} (${this.guardSource})` : 'disabled'}`);
  }

  async retry(what, fn) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        const delay = Math.min(30_000, 2000 * 2 ** attempt);
        console.warn(`[gateway] ${what} failed (${err.message}); retrying in ${delay / 1000}s`);
        this.startError = `${what}: ${err.message}`;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  setupGuard() {
    const cfg = this.cfg;
    if (cfg.topstep.enabled === false) {
      console.warn('[gateway] topstep.enabled is false: account protection is OFF');
      return;
    }
    let resolved;
    try {
      resolved = resolveRules(cfg.topstep, this.user.account);
    } catch (err) {
      if (err instanceof RulesError) {
        console.error(`[gateway] ${err.message}`);
        this.notify(`refusing to start: ${err.message}`);
        process.exit(2);
      }
      throw err;
    }
    for (const w of resolved.warnings) console.warn(`[gateway] rules: ${w}`);
    const stateName = this.guardSource === 'freqtrade' ? 'dryrun' : String(this.user.accountId);
    this.guard = new AccountGuard({
      resolved,
      lots: new LotTable(resolved.lots),
      statePath: path.join(cfg.dataDir, `topstep_state.${stateName}.json`),
    });
    if (this.guardSource === 'projectx') {
      this.guard.rebuildHistory([...this.user.trades.values()], this.user.account.balance);
    }
    this.guard.on('change', (res) => {
      const why = res.reasons.map((r) => r.code).join(', ') || 'clear';
      console.log(`[guard] ${res.status}${res.flatten ? ' +flatten' : ''}: ${why}`);
      this.server.broadcast('guard', { channel: 'guard', data: res });
    });
    console.log(`[gateway] rules: ${resolved.phase}, ${resolved.size ? `${resolved.size / 1000}K` : 'custom'}, start ${resolved.startBalance}, DLL ${resolved.rules.daily_loss_limit}, MLL ${resolved.rules.max_loss_limit} (${resolved.rules.max_loss_type}), target ${resolved.rules.profit_target}`);
    this.evaluateGuard();
  }

  scheduleGuard() {
    if (this.guardPending) return;
    this.guardPending = setTimeout(() => {
      this.guardPending = null;
      this.evaluateGuard();
    }, GUARD_THROTTLE_MS);
    this.guardPending.unref?.();
  }

  guardInputs() {
    const now = Date.now();
    if (this.guardSource === 'projectx') {
      if (!this.user.account) return null;
      return {
        now,
        balance: this.user.account.balance,
        unrealized: this.router_.unrealized(),
        ...summarizeFills([...this.user.trades.values()], this.guard.clock.sessionStart(now)),
        legs: this.router_.legs(),
      };
    }
    const s = this.snapshot;
    if (!s) {
      return { now, balance: this.guard.start, unrealized: 0, dayRealized: 0, closedResults: [], entriesToday: 0, legs: [] };
    }
    let unrealized = 0;
    const legs = [];
    for (const p of s.positions || []) {
      const root = rootOf(p.pair);
      const front = this.contracts.front(root);
      const mark = this.router_.markFor(root) ?? p.mark ?? p.entry_price;
      const pointValue = front && front.tickSize > 0 ? front.tickValue / front.tickSize : 1;
      const dir = p.side === 'short' ? -1 : 1;
      unrealized += (mark - p.entry_price) * p.contracts * pointValue * dir;
      legs.push({ root, contracts: p.contracts });
    }
    return {
      now,
      balance: this.guard.start + (Number(s.realized_total) || 0),
      unrealized,
      dayRealized: Number(s.day_realized) || 0,
      closedResults: s.closed_results || [],
      entriesToday: Number(s.entries_today) || 0,
      legs,
    };
  }

  evaluateGuard() {
    if (!this.guard || !this.router_) return null;
    const input = this.guardInputs();
    if (!input) return null;
    const verdict = this.guard.evaluate(input);
    if (this.guardSource === 'projectx') {
      this.router_.enforceFlatten(verdict).catch((err) => console.warn(`[gateway] flatten fallback failed: ${err.message}`));
    }
    return verdict;
  }

  async checkRolls() {
    const before = this.contracts.rolls.length;
    await this.contracts.refresh({ force: true });
    for (const roll of this.contracts.rolls.slice(before)) {
      await this.market.roll(roll.root, roll.from, roll.to);
      this.notify(`${roll.root} front contract rolled ${roll.from} -> ${roll.to}`);
    }
  }

  router() {
    if (!this.router_) throw new GatewayError('Gateway is still starting', { status: 503, kind: 'ExchangeNotAvailable' });
    return this.router_;
  }

  /* ---------------------------------------------------------- API handlers -- */

  health() {
    return { ok: true, ready: this.ready, mock: this.cfg.mock, marketHub: this.market?.hub.state ?? 'idle', startError: this.ready ? null : this.startError };
  }

  status() {
    return {
      ...this.health(),
      dryRun: this.cfg.dryRun,
      guardSource: this.guardSource,
      upstream: this.client.status(),
      rateLimits: this.limiter.status(),
      marketHub: this.market?.status(),
      userHub: this.user?.status(),
      candles: this.store?.status(),
      ticks: this.ticks?.status(),
      rolls: this.contracts.rolls,
    };
  }

  markets() {
    return this.contracts.markets(this.roots);
  }

  ohlcv(root, tf, since, limit) {
    if (!this.contracts.front(root)) throw new GatewayError(`Unknown symbol ${root}`, { status: 404, kind: 'BadSymbol' });
    return this.store.get(root, tf, { since, limit });
  }

  async ticker(symbol) {
    const root = rootOf(symbol);
    const front = this.contracts.front(root);
    if (!front) throw new GatewayError(`Unknown symbol ${symbol}`, { status: 404, kind: 'BadSymbol' });
    const q = this.market.quoteFor(root) || {};
    let last = q.last ?? this.store.lastPrice(root);
    if (!last) {
      const bars = await this.store.get(root, '1m', { limit: 1 });
      last = bars.at(-1)?.[4] ?? null;
    }
    if (!last) throw new GatewayError(`No price yet for ${symbol}`, { status: 503, kind: 'ExchangeNotAvailable' });
    const ts = q.ts || Date.now();
    const change = q.change ?? null;
    return {
      symbol: pairOf(root, this.stake),
      timestamp: ts,
      datetime: new Date(ts).toISOString(),
      high: q.high ?? null,
      low: q.low ?? null,
      bid: q.bid ?? last,
      bidVolume: q.bidSize ?? null,
      ask: q.ask ?? last,
      askVolume: q.askSize ?? null,
      vwap: null,
      open: q.open ?? null,
      close: last,
      last,
      previousClose: change !== null ? last - change : null,
      change,
      percentage: q.changePercent ?? null,
      average: null,
      baseVolume: q.volume ?? null,
      quoteVolume: null,
      info: q,
    };
  }

  async tickers(symbols) {
    const list = symbols.length ? symbols : this.roots.map((r) => pairOf(r, this.stake));
    const out = {};
    for (const s of list) {
      try {
        const t = await this.ticker(s);
        out[t.symbol] = t;
      } catch { /* omit symbols without a price yet */ }
    }
    return out;
  }

  broadcastTicker(root) {
    if (!this.server) return;
    const now = Date.now();
    this.tickerSent ??= new Map();
    if (now - (this.tickerSent.get(root) || 0) < 250) return;
    this.tickerSent.set(root, now);
    this.ticker(root).then((t) => this.server.broadcast(`ticker|${root}|`, { channel: 'ticker', symbol: t.symbol, data: t })).catch(() => {});
  }

  /** Level 1 only on this entitlement: one level per side, size 0 when unknown. */
  async orderbook(symbol) {
    const t = await this.ticker(symbol);
    const ts = t.timestamp;
    return {
      symbol: t.symbol,
      bids: [[t.bid, t.bidVolume ?? 0]],
      asks: [[t.ask, t.askVolume ?? 0]],
      timestamp: ts,
      datetime: new Date(ts).toISOString(),
      nonce: null,
    };
  }

  publicTrades(symbol, since, limit) {
    const root = rootOf(symbol);
    return this.ticks.publicTrades(root, pairOf(root, this.stake), since, Math.min(limit, 5000));
  }

  orderflowFeatures(symbol, tf, since) {
    return this.orderflow.features(rootOf(symbol), tf, since);
  }

  guardState() {
    if (!this.guard) return { status: 'disabled', canEnter: true, flatten: false, reasons: [], metrics: {} };
    return this.guard.last || this.evaluateGuard();
  }

  guardSnapshot(body) {
    if (this.guardSource !== 'freqtrade') {
      throw new GatewayError('Snapshots are only accepted when the guard runs on Freqtrade dry-run data', { status: 409, kind: 'BadRequest' });
    }
    this.snapshot = body;
    return this.evaluateGuard();
  }

  guardReset(scope) {
    if (!this.guard) return { status: 'disabled' };
    if (!['day', 'account'].includes(scope)) throw new GatewayError('scope must be day or account', { status: 400, kind: 'BadRequest' });
    this.guard.reset(scope);
    console.warn(`[guard] manual ${scope} reset`);
    return this.evaluateGuard();
  }

  async stop() {
    clearInterval(this.guardTimer);
    clearInterval(this.rollTimer);
    await Promise.allSettled([this.market?.stop(), this.user?.stop()]);
    this.store?.close();
    this.ticks?.close();
    this.server?.server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = new GatewayApp(loadConfig());
  const shutdown = async (signal) => {
    console.log(`[gateway] ${signal}, shutting down`);
    await app.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  app.start().catch((err) => {
    console.error('[gateway] fatal:', err);
    process.exit(1);
  });
}
