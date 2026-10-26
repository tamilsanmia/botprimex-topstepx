import { randomBytes } from 'node:crypto';

import { pairOf, rootOf } from './config.js';
import { GatewayError, invalidOrder, notFound, permissionDenied } from './errors.js';
import { ORDER_SIDE, ORDER_STATUS, ORDER_TYPE, POSITION_TYPE } from './projectx.js';
import { STARTS_AT_ZERO } from './rules.js';
import { PROTECT_TAG } from './userStream.js';

const STATUS_CCXT = { 0: 'open', 1: 'open', 2: 'closed', 3: 'canceled', 4: 'expired', 5: 'rejected', 6: 'open' };
const TYPE_CCXT = { 1: 'limit', 2: 'market', 3: 'stop_limit', 4: 'stop', 5: 'trailing_stop', 6: 'limit', 7: 'limit' };
const ENTRY_TAG = 'ft-en-';
const EXIT_TAG = 'ft-ex-';
const FINAL = new Set([ORDER_STATUS.FILLED, ORDER_STATUS.CANCELLED, ORDER_STATUS.EXPIRED, ORDER_STATUS.REJECTED]);
/** Tag of stops placed by the gateway itself; still starts with PROTECT_TAG, so the orphan sweeper manages them. */
export const GATEWAY_STOP_TAG = `${PROTECT_TAG}gw-`;
const STOP_TYPES = new Set([ORDER_TYPE.STOP, ORDER_TYPE.STOP_LIMIT, ORDER_TYPE.TRAILING_STOP]);
const STOP_VISIBLE_MS = 5000;
const PROTECTIVE_DEFAULTS = Object.freeze({ mode: 'off', grace_secs: 10, flatten_after_secs: 30 });

const iso = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString() : null);
const tagId = () => `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

function snap(price, tick) {
  if (price === null || price === undefined || !(tick > 0)) return price ?? null;
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)) + 2);
  return Number((Math.round(Number(price) / tick) * tick).toFixed(decimals));
}

/** Promise-chain mutex: `acquire()` resolves with a release function once earlier holders are done. */
export class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  acquire() {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    return previous.then(() => release);
  }
}

/**
 * Order routing between Freqtrade (via the ccxt adapter) and ProjectX.
 *
 * Entry orders pass the AccountGuard and the mini-equivalent cap first; exits
 * (reduceOnly) are never blocked, are sent to the contract the position is
 * actually in (it may be the pre-roll contract), and are clamped so they can only
 * reduce. Market orders wait for the fill event so Freqtrade sees `closed` with
 * the average price in the same loop.
 */
export class OrderRouter {
  constructor({ client, contracts, user, market, lots, guard, config, notify = () => {}, dataOnly = false }) {
    this.client = client;
    this.contracts = contracts;
    this.user = user;
    this.market = market;
    this.lots = lots;
    this.guard = guard;
    this.config = config;
    this.notify = notify;
    this.dataOnly = dataOnly;
    this.pendingFlattens = new Map();
    this.flattenSeenAt = null;
    this.flattening = false;
    this.entryLocks = new Map();
    this.reservations = new Map();
    this.watch = new Map();
    this.protecting = false;
  }

  /** Order-changing calls are refused outright on a data-only gateway. */
  assertTrading() {
    if (this.dataOnly) throw permissionDenied('This gateway runs in data-only mode (GATEWAY_DATA_ONLY=1): order routes are disabled');
  }

  protectiveStop() {
    const ps = this.config.protective_stop;
    return ps && ps.mode ? { ...PROTECTIVE_DEFAULTS, ...ps } : { ...PROTECTIVE_DEFAULTS };
  }

  /** Dollars one trade may risk, from the guard; null when the cap is off or unknown. */
  maxRisk() {
    const g = this.guard?.();
    const value = Number(g?.last?.metrics?.maxRiskPerTrade ?? g?.protection?.max_risk_per_trade);
    return value > 0 ? value : null;
  }

  entryLock(accountId) {
    if (!this.entryLocks.has(accountId)) this.entryLocks.set(accountId, new Mutex());
    return this.entryLocks.get(accountId);
  }

  accountId() {
    const id = this.user.accountId;
    if (!id) {
      throw new GatewayError(this.user.accountError || 'No trading account selected.', { status: 503, kind: 'AuthenticationError' });
    }
    return id;
  }

  symbolFor(contractId) {
    const root = this.contracts.rootForContract(contractId);
    return root ? pairOf(root) : contractId;
  }

  pointValue(contractId) {
    const info = this.contracts.contractInfo(contractId) || this.contracts.front(this.contracts.rootForContract(contractId));
    return info && info.tickSize > 0 ? info.tickValue / info.tickSize : 1;
  }

  markFor(root) {
    const q = this.market.quoteFor(root);
    if (!q) return null;
    if (q.last > 0) return q.last;
    if (q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
    return null;
  }

  /** Milliseconds since the last market message for the root, null when it is not subscribed. */
  markAge(root) {
    return this.market.quoteAgeMs ? this.market.quoteAgeMs(root) : null;
  }

  positionForRoot(root) {
    for (const p of this.user.positions.values()) {
      if (this.contracts.rootForContract(p.contractId) === root) return p;
    }
    return null;
  }

  /**
   * Fill and position events arrive separately, so an exit sent right after an
   * entry can beat the position update. Waits briefly, then asks REST once.
   */
  async settledPosition(root, wanted, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const p = this.positionForRoot(root);
      if (wanted(p)) return p;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      const fresh = await this.client.searchOpenPositions(this.user.accountId);
      for (const p of fresh) this.user.onPosition(p);
    } catch { /* keep the cached view */ }
    return this.positionForRoot(root);
  }

  /**
   * Open positions plus working entry orders, as lot legs for the cap check. With
   * `reserved` (default) it also counts entries that are being submitted right now
   * and not yet visible as an order, so two parallel entries cannot both pass the cap.
   */
  legs({ reserved = true } = {}) {
    const legs = [];
    for (const p of this.user.positions.values()) {
      legs.push({ root: this.contracts.rootForContract(p.contractId), contracts: Number(p.size) || 0 });
    }
    for (const o of this.user.openOrders()) {
      if (String(o.customTag || '').startsWith(ENTRY_TAG)) {
        legs.push({ root: this.contracts.rootForContract(o.contractId), contracts: Math.max(0, (Number(o.size) || 0) - (Number(o.fillVolume) || 0)) });
      }
    }
    if (reserved) {
      for (const r of this.reservations.values()) {
        // Once the order is working it is counted above; counting it twice would only refuse valid entries.
        const order = r.orderId === null ? null : this.user.orders.get(r.orderId);
        if (order && !FINAL.has(order.status)) continue;
        legs.push({ root: r.root, contracts: r.contracts });
      }
    }
    return legs.filter((l) => l.root);
  }

  unrealized() {
    let total = 0;
    for (const p of this.user.positions.values()) {
      const root = this.contracts.rootForContract(p.contractId);
      const mark = this.markFor(root);
      if (!mark) continue;
      const dir = p.type === POSITION_TYPE.SHORT ? -1 : 1;
      total += (mark - Number(p.averagePrice)) * Number(p.size) * this.pointValue(p.contractId) * dir;
    }
    return total;
  }

  /* --------------------------------------------------------------- orders -- */

  async place({ symbol, type, side, amount, price, params = {} }) {
    this.assertTrading();
    const accountId = this.accountId();
    const root = rootOf(symbol);
    const front = this.contracts.front(root);
    if (!front) throw new GatewayError(`Unknown symbol ${symbol}`, { status: 404, kind: 'BadSymbol' });

    let size = Number(amount);
    if (!Number.isInteger(size) || size <= 0) throw invalidOrder(`Order size must be a whole number of contracts, got ${amount}`);
    if (size > this.config.max_order_size) throw invalidOrder(`Order size ${size} exceeds max_order_size ${this.config.max_order_size}`);

    const sideCode = String(side).toLowerCase() === 'buy' ? ORDER_SIDE.BUY : ORDER_SIDE.SELL;
    const stopPrice = params.stopPrice ?? params.triggerPrice ?? params.stopLossPrice ?? null;
    const t = String(type || '').toLowerCase();
    let typeCode;
    if (t === 'stop_limit' || (t === 'limit' && stopPrice !== null)) typeCode = ORDER_TYPE.STOP_LIMIT;
    else if (t === 'stop' || t === 'stop_market' || (t === 'market' && stopPrice !== null)) typeCode = ORDER_TYPE.STOP;
    else if (t === 'limit') typeCode = ORDER_TYPE.LIMIT;
    else if (t === 'market') typeCode = ORDER_TYPE.MARKET;
    else throw invalidOrder(`Unsupported order type ${type}`);

    const reduceOnly = params.reduceOnly === true || params.reduceOnly === 'true';
    const reducible = (p) => Boolean(p) && (p.type === POSITION_TYPE.LONG ? ORDER_SIDE.SELL : ORDER_SIDE.BUY) === sideCode;

    // Entries are serialized per account from the cap check until the order is
    // submitted, and hold a reservation until the fill has settled. Exits are not
    // serialized: an exit must never wait behind an entry.
    let release = null;
    let reservedTag = null;
    try {
      if (!reduceOnly) release = await this.entryLock(accountId).acquire();

      const position = reduceOnly ? await this.settledPosition(root, reducible) : this.positionForRoot(root);
      let contractId = front.contractId;
      let tag;

      if (reduceOnly) {
        if (!reducible(position)) {
          const synthetic = this.consumeFlatten(root, sideCode, size);
          if (synthetic) return synthetic;
          throw invalidOrder(`No ${sideCode === ORDER_SIDE.SELL ? 'long' : 'short'} ${root} position to reduce`);
        }
        contractId = position.contractId;
        size = Math.min(size, Number(position.size));
        tag = `${typeCode === ORDER_TYPE.STOP || typeCode === ORDER_TYPE.STOP_LIMIT ? PROTECT_TAG : EXIT_TAG}${tagId()}`;
      } else {
        if (position) {
          const sameDirection = (position.type === POSITION_TYPE.LONG) === (sideCode === ORDER_SIDE.BUY);
          if (!sameDirection) throw invalidOrder(`Entry would offset the open ${root} position; exits must be reduceOnly`);
          contractId = position.contractId;
        }
        if (this.guard) {
          const verdict = this.guard().canEnter({ root, contracts: size, legs: this.legs() });
          if (!verdict.ok) throw invalidOrder(`Refused by account protection: ${verdict.reason}`);
        }
        tag = `${ENTRY_TAG}${tagId()}`;
      }

      const info = this.contracts.contractInfo(contractId) || front;
      const body = {
        accountId,
        contractId,
        type: typeCode,
        side: sideCode,
        size,
        limitPrice: typeCode === ORDER_TYPE.LIMIT || typeCode === ORDER_TYPE.STOP_LIMIT ? snap(price, info.tickSize) : null,
        stopPrice: typeCode === ORDER_TYPE.STOP || typeCode === ORDER_TYPE.STOP_LIMIT ? snap(stopPrice ?? price, info.tickSize) : null,
        trailPrice: null,
        customTag: tag,
      };
      if ((typeCode === ORDER_TYPE.LIMIT || typeCode === ORDER_TYPE.STOP_LIMIT) && !(body.limitPrice > 0)) throw invalidOrder('A limit order needs a price');
      if ((typeCode === ORDER_TYPE.STOP || typeCode === ORDER_TYPE.STOP_LIMIT) && !(body.stopPrice > 0)) throw invalidOrder('A stop order needs stopPrice');

      let reservation = null;
      if (!reduceOnly) {
        const unprotectable = this.cannotProtect(root, info, size + (position ? Number(position.size) || 0 : 0));
        if (unprotectable) throw invalidOrder(`Refused: the gateway could not protect this entry (${unprotectable})`);

        const useBracket = this.config.brackets === 'native' || this.protectiveStop().mode === 'native';
        const maxRisk = this.maxRisk();
        if (useBracket && this.guard && maxRisk) {
          const ticks = info.tickValue > 0 ? Math.floor(maxRisk / (size * info.tickValue)) : 0;
          if (ticks >= 1) body.stopLossBracket = { ticks, type: ORDER_TYPE.STOP };
        }
        reservation = { root, contracts: size, orderId: null };
        this.reservations.set(tag, reservation);
        reservedTag = tag;
      }

      const orderId = await this.submit(body);
      if (reservation) reservation.orderId = orderId;
      if (release) {
        release();
        release = null;
      }
      if (reduceOnly && tag.startsWith(PROTECT_TAG)) await this.dropGatewayStops(contractId);

      const waitMs = typeCode === ORDER_TYPE.MARKET ? this.config.fill_wait_ms : 300;
      if (waitMs > 0) {
        const final = await this.user.waitForFinal(orderId, waitMs);
        if (final?.status === ORDER_STATUS.FILLED && !reduceOnly) {
          await this.settledPosition(root, (p) => Boolean(p), 500);
        }
      }
      const raw = this.user.orders.get(orderId) || {
        id: orderId, accountId, contractId, status: ORDER_STATUS.OPEN, type: typeCode, side: sideCode, size,
        limitPrice: body.limitPrice, stopPrice: body.stopPrice, fillVolume: 0, filledPrice: null,
        customTag: tag, creationTimestamp: new Date().toISOString(),
      };
      return this.toCcxtOrder(raw);
    } finally {
      if (release) release();
      if (reservedTag) this.reservations.delete(reservedTag);
    }
  }

  /**
   * Places with one ambiguity handled: if the request times out we cannot know
   * whether it was placed, so the order is looked up by its unique tag before the
   * error is reported. Retrying blindly could double the position.
   */
  async submit(body) {
    try {
      const res = await this.client.placeOrder(body);
      return res.orderId;
    } catch (err) {
      if (err.kind === 'RequestTimeout' || err.kind === 'NetworkError') {
        try {
          const recent = await this.client.searchOrders(body.accountId, { start: Date.now() - 5 * 60 * 1000 });
          const hit = recent.find((o) => o.customTag === body.customTag);
          if (hit) {
            this.user.onOrder(hit);
            return hit.id;
          }
        } catch { /* fall through to the original error */ }
      }
      throw err;
    }
  }

  async cancel(orderId) {
    this.assertTrading();
    const accountId = this.accountId();
    const id = Number(orderId);
    const known = this.user.orders.get(id) || (await this.findOrder(id));
    if (!known) throw notFound(`Order ${orderId} not found`);
    if (!FINAL.has(known.status)) {
      try {
        await this.client.cancelOrder(accountId, id);
      } catch (err) {
        const fresh = await this.findOrder(id);
        if (!fresh || !FINAL.has(fresh.status)) throw err;
      }
      await this.user.waitForFinal(id, 1500);
    }
    return this.toCcxtOrder(this.user.orders.get(id) || known);
  }

  async modify(orderId, { amount, price, stopPrice }) {
    this.assertTrading();
    const accountId = this.accountId();
    const id = Number(orderId);
    const known = this.user.orders.get(id) || (await this.findOrder(id));
    if (!known) throw notFound(`Order ${orderId} not found`);
    const info = this.contracts.contractInfo(known.contractId);
    const body = { accountId, orderId: id };
    if (amount !== undefined && amount !== null) body.size = Number(amount);
    if (price !== undefined && price !== null) body.limitPrice = snap(price, info?.tickSize);
    if (stopPrice !== undefined && stopPrice !== null) body.stopPrice = snap(stopPrice, info?.tickSize);
    await this.client.modifyOrder(body);
    await new Promise((r) => setTimeout(r, 200));
    return this.toCcxtOrder(this.user.orders.get(id) || { ...known, ...body });
  }

  async findOrder(id) {
    const accountId = this.accountId();
    for (const days of [1, 7]) {
      const rows = await this.client.searchOrders(accountId, { start: Date.now() - days * 24 * 60 * 60 * 1000 });
      for (const o of rows) this.user.onOrder(o);
      const hit = rows.find((o) => o.id === id);
      if (hit) return hit;
    }
    return null;
  }

  async getOrder(orderId) {
    const id = Number(orderId);
    const raw = this.user.orders.get(id) || (await this.findOrder(id));
    if (!raw) throw notFound(`Order ${orderId} not found`);
    return this.toCcxtOrder(raw);
  }

  openOrders(symbol) {
    const root = symbol ? rootOf(symbol) : null;
    return this.user.openOrders()
      .filter((o) => !root || this.contracts.rootForContract(o.contractId) === root)
      .map((o) => this.toCcxtOrder(o));
  }

  async orders(symbol, since) {
    const root = symbol ? rootOf(symbol) : null;
    if (since && since < Date.now() - 24 * 60 * 60 * 1000) {
      const rows = await this.client.searchOrders(this.accountId(), { start: since });
      for (const o of rows) this.user.onOrder(o);
    }
    return [...this.user.orders.values()]
      .filter((o) => (!root || this.contracts.rootForContract(o.contractId) === root)
        && (!since || Date.parse(o.creationTimestamp) >= since))
      .sort((a, b) => Date.parse(a.creationTimestamp) - Date.parse(b.creationTimestamp))
      .map((o) => this.toCcxtOrder(o));
  }

  myTrades(symbol, since) {
    const root = symbol ? rootOf(symbol) : null;
    return [...this.user.trades.values()]
      .filter((t) => !t.voided
        && (!root || this.contracts.rootForContract(t.contractId) === root)
        && (!since || Date.parse(t.creationTimestamp) >= since))
      .sort((a, b) => Date.parse(a.creationTimestamp) - Date.parse(b.creationTimestamp))
      .map((t) => this.toCcxtTrade(t));
  }

  positions(symbols) {
    const roots = symbols?.length ? new Set(symbols.map(rootOf)) : null;
    const out = [];
    for (const p of this.user.positions.values()) {
      const root = this.contracts.rootForContract(p.contractId);
      if (roots && !roots.has(root)) continue;
      const size = Number(p.size) || 0;
      const contractSize = this.pointValue(p.contractId);
      const mark = this.markFor(root);
      const dir = p.type === POSITION_TYPE.SHORT ? -1 : 1;
      const entry = Number(p.averagePrice) || 0;
      out.push({
        info: p,
        id: String(p.id),
        symbol: pairOf(root),
        timestamp: Date.parse(p.creationTimestamp) || null,
        datetime: p.creationTimestamp || null,
        contracts: size,
        contractSize,
        side: dir > 0 ? 'long' : 'short',
        entryPrice: entry,
        markPrice: mark,
        notional: mark ? size * contractSize * mark : null,
        unrealizedPnl: mark ? (mark - entry) * size * contractSize * dir : null,
        leverage: null,
        collateral: 0,
        initialMargin: 0,
        maintenanceMargin: 0,
        marginMode: 'isolated',
        liquidationPrice: null,
        hedged: false,
      });
    }
    return out;
  }

  /**
   * Wallet for Freqtrade's stake sizing. The balance of an Express Funded Account
   * (its 50K/100K/150K is buying power) and of a Topstep Labs account (profit only)
   * starts at $0, which would leave Freqtrade unable to size anything, so the account
   * size is added as an offset. The AccountGuard still works on the real balance.
   */
  /**
   * balance_offset "auto": an Express Funded account adds its size (its buying power).
   * A Topstep Labs Challenge has no account size (the "6K" in its name is the profit
   * target), so it adds its static Max Loss Limit: the wallet is then the profit plus
   * what may still be lost, which is what the account can trade with.
   */
  autoBalanceOffset(acct) {
    if (acct.kind === 'LABS') return Number(this.guard?.()?.rules?.max_loss_limit) || 0;
    return STARTS_AT_ZERO.has(acct.kind) ? Number(acct.sizeUsd) || 0 : 0;
  }

  balance(stake = 'USD') {
    const acct = this.user.account;
    if (!acct) throw new GatewayError(this.user.accountError || 'Account not loaded yet', { status: 503, kind: 'ExchangeNotAvailable' });
    const setting = this.config.balance_offset ?? 'auto';
    const offset = setting === 'auto' ? this.autoBalanceOffset(acct) : Number(setting) || 0;
    const total = (Number(acct.balance) || 0) + offset;
    return {
      info: { ...acct, balanceOffset: offset },
      [stake]: { free: total, used: 0, total },
      free: { [stake]: total },
      used: { [stake]: 0 },
      total: { [stake]: total },
    };
  }

  async closePosition(symbol) {
    this.assertTrading();
    const accountId = this.accountId();
    const root = rootOf(symbol);
    const position = this.positionForRoot(root);
    if (!position) return { closed: false, reason: 'no position' };
    await this.client.closeContract(accountId, position.contractId);
    return { closed: true, contractId: position.contractId };
  }

  /* ------------------------------------------------------- protective stop -- */

  /**
   * Why an entry of `totalSize` contracts could not be protected by the gateway's
   * own stop, or null. Only applies in protective_stop.mode "gateway" and when
   * max_risk_per_trade is set (without it the watchdog has nothing to size a stop
   * from; the startup log warns about that).
   */
  cannotProtect(root, info, totalSize) {
    if (this.protectiveStop().mode !== 'gateway') return null;
    const maxRisk = this.maxRisk();
    if (!maxRisk) return null;
    if (!(info?.tickSize > 0) || !(info?.tickValue > 0)) return `no tick size or tick value known for ${root}`;
    if (Math.floor(maxRisk / (totalSize * info.tickValue)) < 1) {
      return `max_risk_per_trade ${maxRisk} is below one tick of risk for ${totalSize} ${root}`;
    }
    if (this.user.hub?.state !== 'connected') return 'the user hub is not connected, so a stop could not be watched';
    return null;
  }

  /** Working stop orders that reduce the position (the ones that protect it). */
  workingStops(position) {
    const reduceSide = position.type === POSITION_TYPE.LONG ? ORDER_SIDE.SELL : ORDER_SIDE.BUY;
    return this.user.openOrders().filter((o) => o.contractId === position.contractId
      && STOP_TYPES.has(o.type) && o.side === reduceSide);
  }

  /** A Freqtrade (or bracket) stop took over: the gateway's own stop on that contract is cancelled. */
  async dropGatewayStops(contractId) {
    const accountId = this.user.accountId;
    for (const o of this.user.openOrders()) {
      if (o.contractId !== contractId || !String(o.customTag || '').startsWith(GATEWAY_STOP_TAG)) continue;
      try {
        await this.client.cancelOrder(accountId, o.id);
        console.log(`[router] cancelled gateway stop ${o.id}: another stop protects the position`);
      } catch (err) {
        console.warn(`[router] could not cancel gateway stop ${o.id}: ${err.message}`);
      }
    }
  }

  /**
   * Watchdog, run every couple of seconds. A position with no working stop is first
   * given `grace_secs` for Freqtrade to place its own. After that the gateway places
   * a stop sized to max_risk_per_trade. If it cannot, or no stop is visible after
   * `flatten_after_secs`, the position is flattened and the failure announced.
   */
  async protectPositions(now = Date.now()) {
    const ps = this.protectiveStop();
    if (ps.mode !== 'gateway' || this.dataOnly || !this.user.accountId || this.protecting) return;
    const maxRisk = this.maxRisk();
    if (!maxRisk) return;
    this.protecting = true;
    try {
      const live = new Set();
      for (const p of [...this.user.positions.values()]) {
        live.add(p.contractId);
        await this.protectOne(p, ps, maxRisk, now);
      }
      for (const key of [...this.watch.keys()]) if (!live.has(key)) this.watch.delete(key);
    } finally {
      this.protecting = false;
    }
  }

  async protectOne(p, ps, maxRisk, now) {
    let w = this.watch.get(p.contractId);
    if (!w || w.type !== p.type) {
      w = { type: p.type, unprotectedSince: null, placedAt: null };
      this.watch.set(p.contractId, w);
    }
    const root = this.contracts.rootForContract(p.contractId);
    const stops = this.workingStops(p);
    const isGateway = (o) => String(o.customTag || '').startsWith(GATEWAY_STOP_TAG);

    if (stops.length) {
      w.unprotectedSince = null;
      w.placedAt = null;
      if (stops.some((o) => !isGateway(o)) && stops.some(isGateway)) await this.dropGatewayStops(p.contractId);
      return;
    }

    if (w.unprotectedSince === null) w.unprotectedSince = now;
    const waited = now - w.unprotectedSince;

    if (waited >= ps.flatten_after_secs * 1000) {
      await this.flattenUnprotected(p, root, `no stop order was working ${Math.round(waited / 1000)}s after the position opened`, now);
      return;
    }
    if (w.placedAt !== null) {
      if (now - w.placedAt >= STOP_VISIBLE_MS) await this.flattenUnprotected(p, root, 'the gateway stop did not show up as a working order', now);
      return;
    }
    if (waited < ps.grace_secs * 1000) return;

    try {
      const orderId = await this.placeGatewayStop(p, root, maxRisk);
      w.placedAt = now;
      const msg = `${root} had no stop for ${Math.round(waited / 1000)}s: the gateway placed stop ${orderId}`;
      console.warn(`[router] ${msg}`);
      this.notify(msg);
    } catch (err) {
      await this.flattenUnprotected(p, root, `the gateway could not place a stop (${err.message})`, now);
    }
  }

  async placeGatewayStop(p, root, maxRisk) {
    const info = this.contracts.contractInfo(p.contractId) || this.contracts.front(root);
    if (!(info?.tickSize > 0) || !(info?.tickValue > 0)) throw new Error(`no tick size or value for ${root}`);
    const size = Number(p.size);
    const ticks = Math.floor(maxRisk / (size * info.tickValue));
    if (ticks < 1) throw new Error(`max_risk_per_trade ${maxRisk} is below one tick of risk for ${size} ${root}`);
    const long = p.type === POSITION_TYPE.LONG;
    const entry = Number(p.averagePrice);
    const stopPrice = snap(long ? entry - ticks * info.tickSize : entry + ticks * info.tickSize, info.tickSize);
    if (!(stopPrice > 0)) throw new Error(`stop price ${stopPrice} is not valid`);
    return this.submit({
      accountId: this.user.accountId,
      contractId: p.contractId,
      type: ORDER_TYPE.STOP,
      side: long ? ORDER_SIDE.SELL : ORDER_SIDE.BUY,
      size,
      limitPrice: null,
      stopPrice,
      trailPrice: null,
      customTag: `${GATEWAY_STOP_TAG}${tagId()}`,
    });
  }

  async flattenUnprotected(p, root, why, now) {
    const msg = `${root} ${p.size} contracts flattened by the gateway: ${why}.`;
    try {
      await this.flattenPosition(p, msg, now);
      this.watch.delete(p.contractId);
    } catch (err) {
      const failed = `${root} has no stop (${why}) and the flatten FAILED: ${err.message}. Close it manually.`;
      console.error(`[router] ${failed}`);
      const w = this.watch.get(p.contractId);
      if (!w?.flattenFailedNotified) {
        if (w) w.flattenFailedNotified = true;
        this.notify(failed);
      }
    }
  }

  /* -------------------------------------------------------- flatten fallback -- */

  /**
   * Freqtrade is expected to flatten on a lock (custom_exit returns
   * account_protection). If positions are still open `flatten_grace_secs` later,
   * the gateway closes them itself, and remembers each close so Freqtrade's own
   * exit, when it arrives, is answered with the real fill instead of an error.
   */
  async enforceFlatten(verdict, now = Date.now()) {
    if (!verdict?.flatten || !this.user.accountId) {
      this.flattenSeenAt = null;
      return;
    }
    if (!this.user.positions.size) {
      this.flattenSeenAt = null;
      return;
    }
    if (!this.flattenSeenAt) this.flattenSeenAt = now;
    if (now - this.flattenSeenAt < this.config.flatten_grace_secs * 1000 || this.flattening) return;

    this.flattening = true;
    try {
      for (const p of [...this.user.positions.values()]) {
        const root = this.contracts.rootForContract(p.contractId);
        await this.flattenPosition(p, `ProjectX gateway closed ${p.size} ${root} itself (${verdict.flattenReasons.join(', ')}): Freqtrade had not flattened within ${this.config.flatten_grace_secs}s.`, now);
      }
    } finally {
      this.flattening = false;
      this.flattenSeenAt = null;
    }
  }

  /**
   * Cancels what is working on the contract, closes the position, and remembers the
   * close so Freqtrade's own exit, when it arrives, is answered with the real fill.
   */
  async flattenPosition(p, message, now = Date.now()) {
    const accountId = this.user.accountId;
    const root = this.contracts.rootForContract(p.contractId);
    for (const o of this.user.openOrders().filter((x) => x.contractId === p.contractId)) {
      try { await this.client.cancelOrder(accountId, o.id); } catch { /* may already be done */ }
    }
    await this.client.closeContract(accountId, p.contractId);
    this.pendingFlattens.set(root, {
      at: now - 1000,
      contractId: p.contractId,
      side: p.type === POSITION_TYPE.LONG ? ORDER_SIDE.SELL : ORDER_SIDE.BUY,
      size: Number(p.size),
    });
    console.warn(`[router] ${message}`);
    this.notify(message);
  }

  consumeFlatten(root, sideCode, size) {
    const pending = this.pendingFlattens.get(root);
    if (!pending || pending.side !== sideCode) return null;
    const fills = [...this.user.trades.values()].filter((t) => t.contractId === pending.contractId
      && t.side === sideCode && Date.parse(t.creationTimestamp) >= pending.at && !t.voided);
    if (!fills.length) return null;
    this.pendingFlattens.delete(root);
    const filled = Math.min(size, fills.reduce((s, t) => s + Number(t.size), 0));
    const avg = fills.reduce((s, t) => s + Number(t.price) * Number(t.size), 0) / fills.reduce((s, t) => s + Number(t.size), 0);
    const fee = fills.reduce((s, t) => s + (Number(t.fees) || 0) + (Number(t.commissions) || 0), 0);
    const ts = Date.parse(fills[fills.length - 1].creationTimestamp);
    return {
      id: `flatten-${fills[0].orderId ?? fills[0].id}`,
      clientOrderId: null,
      timestamp: ts,
      datetime: iso(ts),
      lastTradeTimestamp: ts,
      symbol: pairOf(root),
      type: 'market',
      side: sideCode === ORDER_SIDE.BUY ? 'buy' : 'sell',
      price: avg,
      average: avg,
      amount: filled,
      filled,
      remaining: 0,
      cost: avg * filled * this.pointValue(pending.contractId),
      status: 'closed',
      reduceOnly: true,
      fee: { cost: fee, currency: 'USD' },
      trades: [],
      info: { flattenedByGateway: true },
    };
  }

  /* ---------------------------------------------------------------- shapes -- */

  toCcxtOrder(o) {
    const fills = this.user.tradesForOrder(o.id);
    const filled = Number(o.fillVolume) || fills.reduce((s, t) => s + Number(t.size), 0) || 0;
    let average = o.filledPrice !== null && o.filledPrice !== undefined && filled > 0 ? Number(o.filledPrice) : null;
    if (average === null && fills.length) {
      const qty = fills.reduce((s, t) => s + Number(t.size), 0);
      average = fills.reduce((s, t) => s + Number(t.price) * Number(t.size), 0) / qty;
    }
    const amount = Number(o.size) || 0;
    const status = STATUS_CCXT[o.status] ?? 'open';
    const tag = String(o.customTag || '');
    const created = Date.parse(o.creationTimestamp);
    const updated = Date.parse(o.updateTimestamp);
    const stopPrice = o.stopPrice === null || o.stopPrice === undefined ? null : Number(o.stopPrice);
    const limitPrice = o.limitPrice === null || o.limitPrice === undefined ? null : Number(o.limitPrice);
    const fee = fills.reduce((s, t) => s + (Number(t.fees) || 0) + (Number(t.commissions) || 0), 0);
    const pointValue = this.pointValue(o.contractId);

    return {
      info: o,
      id: String(o.id),
      clientOrderId: tag || null,
      timestamp: Number.isFinite(created) ? created : null,
      datetime: iso(created),
      lastTradeTimestamp: filled > 0 && Number.isFinite(updated) ? updated : null,
      symbol: this.symbolFor(o.contractId),
      type: TYPE_CCXT[o.type] || 'market',
      timeInForce: 'GTC',
      side: o.side === ORDER_SIDE.BUY ? 'buy' : 'sell',
      price: limitPrice ?? average ?? stopPrice,
      stopPrice,
      triggerPrice: stopPrice,
      average,
      amount,
      filled,
      remaining: status === 'open' ? Math.max(0, amount - filled) : 0,
      cost: average ? average * filled * pointValue : 0,
      status,
      reduceOnly: tag.startsWith(PROTECT_TAG) || tag.startsWith(EXIT_TAG),
      fee: fills.length ? { cost: fee, currency: 'USD' } : undefined,
      trades: fills.map((t) => this.toCcxtTrade(t)),
    };
  }

  toCcxtTrade(t) {
    const ts = Date.parse(t.creationTimestamp);
    const price = Number(t.price);
    const amount = Number(t.size);
    return {
      info: t,
      id: String(t.id),
      order: t.orderId !== undefined && t.orderId !== null ? String(t.orderId) : null,
      timestamp: ts,
      datetime: iso(ts),
      symbol: this.symbolFor(t.contractId),
      type: null,
      side: t.side === ORDER_SIDE.BUY ? 'buy' : 'sell',
      takerOrMaker: null,
      price,
      amount,
      cost: price * amount * this.pointValue(t.contractId),
      fee: { cost: (Number(t.fees) || 0) + (Number(t.commissions) || 0), currency: 'USD' },
    };
  }
}
