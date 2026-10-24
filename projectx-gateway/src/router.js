import { randomBytes } from 'node:crypto';

import { pairOf, rootOf } from './config.js';
import { GatewayError, invalidOrder, notFound } from './errors.js';
import { ORDER_SIDE, ORDER_STATUS, ORDER_TYPE, POSITION_TYPE } from './projectx.js';
import { PROTECT_TAG } from './userStream.js';

const STATUS_CCXT = { 0: 'open', 1: 'open', 2: 'closed', 3: 'canceled', 4: 'expired', 5: 'rejected', 6: 'open' };
const TYPE_CCXT = { 1: 'limit', 2: 'market', 3: 'stop_limit', 4: 'stop', 5: 'trailing_stop', 6: 'limit', 7: 'limit' };
const ENTRY_TAG = 'ft-en-';
const EXIT_TAG = 'ft-ex-';
const FINAL = new Set([ORDER_STATUS.FILLED, ORDER_STATUS.CANCELLED, ORDER_STATUS.EXPIRED, ORDER_STATUS.REJECTED]);

const iso = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString() : null);
const tagId = () => `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

function snap(price, tick) {
  if (price === null || price === undefined || !(tick > 0)) return price ?? null;
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)) + 2);
  return Number((Math.round(Number(price) / tick) * tick).toFixed(decimals));
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
  constructor({ client, contracts, user, market, lots, guard, config, notify = () => {} }) {
    this.client = client;
    this.contracts = contracts;
    this.user = user;
    this.market = market;
    this.lots = lots;
    this.guard = guard;
    this.config = config;
    this.notify = notify;
    this.pendingFlattens = new Map();
    this.flattenSeenAt = null;
    this.flattening = false;
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

  /** Open positions plus working entry orders, as lot legs for the cap check. */
  legs() {
    const legs = [];
    for (const p of this.user.positions.values()) {
      legs.push({ root: this.contracts.rootForContract(p.contractId), contracts: Number(p.size) || 0 });
    }
    for (const o of this.user.openOrders()) {
      if (String(o.customTag || '').startsWith(ENTRY_TAG)) {
        legs.push({ root: this.contracts.rootForContract(o.contractId), contracts: Math.max(0, (Number(o.size) || 0) - (Number(o.fillVolume) || 0)) });
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

    if (!reduceOnly && this.config.brackets === 'native' && this.guard) {
      const maxRisk = this.guard().last?.metrics?.maxRiskPerTrade;
      const ticks = maxRisk && info.tickValue > 0 ? Math.floor(maxRisk / (size * info.tickValue)) : 0;
      if (ticks >= 1) body.stopLossBracket = { ticks, type: ORDER_TYPE.STOP };
    }

    const orderId = await this.submit(body);

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
   * Wallet for Freqtrade's stake sizing. An Express Funded Account's balance starts
   * at $0 (its 50K/100K/150K is buying power), which would leave Freqtrade unable to
   * size anything, so the account size is added as an offset. The AccountGuard
   * still works on the real balance.
   */
  balance(stake = 'USD') {
    const acct = this.user.account;
    if (!acct) throw new GatewayError(this.user.accountError || 'Account not loaded yet', { status: 503, kind: 'ExchangeNotAvailable' });
    const setting = this.config.balance_offset ?? 'auto';
    const offset = setting === 'auto' ? (acct.kind === 'XFA' ? Number(acct.sizeUsd) || 0 : 0) : Number(setting) || 0;
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
    const accountId = this.accountId();
    const root = rootOf(symbol);
    const position = this.positionForRoot(root);
    if (!position) return { closed: false, reason: 'no position' };
    await this.client.closeContract(accountId, position.contractId);
    return { closed: true, contractId: position.contractId };
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
      const accountId = this.user.accountId;
      for (const p of [...this.user.positions.values()]) {
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
        const msg = `ProjectX gateway closed ${p.size} ${root} itself (${verdict.flattenReasons.join(', ')}): Freqtrade had not flattened within ${this.config.flatten_grace_secs}s.`;
        console.warn(`[router] ${msg}`);
        this.notify(msg);
      }
    } finally {
      this.flattening = false;
      this.flattenSeenAt = null;
    }
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
