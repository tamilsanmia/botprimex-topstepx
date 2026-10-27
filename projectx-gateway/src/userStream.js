import { EventEmitter } from 'node:events';

import { ManagedHub, entries } from './hub.js';
import { PRIORITY } from './limiter.js';
import { ORDER_SIDE, ORDER_STATUS, POSITION_TYPE } from './projectx.js';

const FINAL = new Set([ORDER_STATUS.FILLED, ORDER_STATUS.CANCELLED, ORDER_STATUS.EXPIRED, ORDER_STATUS.REJECTED]);
const ORPHAN_SWEEP_MS = 5000;
const CANCEL_STRIKES = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DEFAULTS = Object.freeze({ orders_days: 2, trades_days: 14 });
export const PROTECT_TAG = 'ft-sl-';

/** User hub payloads may be the object itself or `{ action, data }`. */
function unwrap(args) {
  const payload = args.length > 1 ? args[args.length - 1] : args[0];
  return entries(payload).map((p) => (p && typeof p === 'object' && p.data && typeof p.data === 'object' ? p.data : p));
}

/**
 * Live account state from the user hub: account balance, orders, positions and
 * fills, so Freqtrade's frequent reads never touch the REST budget.
 *
 * A REST reconcile runs every `reconcileSecs` as a safety net for missed events.
 * The orphan sweep cancels protective stops whose position is gone: on a netting
 * account a stop left working after the position closes would open a NEW
 * position when hit. "Gone" must be seen twice before cancelling, because one
 * empty read is indistinguishable from a bad response.
 */
export class UserStream extends EventEmitter {
  constructor({ client, url, tokenFactory, hubFactory, accountSelector = 'auto', reconcileSecs = 30, retention = {} }) {
    super();
    const days = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);
    this.retention = {
      orders_days: days(retention.orders_days, RETENTION_DEFAULTS.orders_days),
      trades_days: days(retention.trades_days, RETENTION_DEFAULTS.trades_days),
    };
    this.pruneArmed = false;
    this.client = client;
    this.accountSelector = accountSelector;
    this.reconcileSecs = reconcileSecs;
    this.account = null;
    this.accounts = [];
    this.accountError = null;
    this.orders = new Map();
    this.positions = new Map();
    this.trades = new Map();
    // orderId -> Map(tradeId -> trade), kept in step with `trades` by addTrade/removeTrade.
    this.tradesByOrder = new Map();
    this.waiters = new Map();
    this.strikes = new Map();
    this.lastReconcileAt = 0;
    this.hub = new ManagedHub({
      name: 'user-hub',
      url,
      tokenFactory,
      factory: hubFactory,
      handlers: {
        GatewayUserAccount: (...a) => unwrap(a).forEach((x) => this.onAccount(x)),
        GatewayUserOrder: (...a) => unwrap(a).forEach((x) => this.onOrder(x)),
        GatewayUserPosition: (...a) => unwrap(a).forEach((x) => this.onPosition(x)),
        GatewayUserTrade: (...a) => unwrap(a).forEach((x) => this.onTrade(x)),
      },
      onReady: (hub) => this.onHubReady(hub),
      onState: (state, info) => this.emit('state', state, info),
    });
  }

  /** Picks the account by id, name, or `auto` (only when exactly one can trade). */
  selectAccount(accounts) {
    const sel = this.accountSelector;
    if (sel !== 'auto' && sel !== '' && sel !== null && sel !== undefined) {
      const hit = accounts.find((a) => String(a.id) === String(sel) || a.name === String(sel));
      if (!hit) throw new Error(`projectx_gateway.account "${sel}" not found. Available: ${accounts.map((a) => `${a.id}=${a.name}`).join(', ')}`);
      return hit;
    }
    const tradeable = accounts.filter((a) => a.canTrade);
    if (tradeable.length === 1) return tradeable[0];
    if (!tradeable.length) throw new Error('No ProjectX account can trade.');
    throw new Error(`Several ProjectX accounts can trade; set projectx_gateway.account to one of: ${tradeable.map((a) => `${a.id} (${a.name})`).join(', ')}`);
  }

  async start({ tradesSince }) {
    this.accounts = await this.client.searchAccounts({ onlyActive: true });
    try {
      this.account = this.selectAccount(this.accounts);
      this.accountError = null;
    } catch (err) {
      this.accountError = err.message;
      console.error(`[user-hub] ${err.message}`);
      return;
    }
    console.log(`[user-hub] trading account ${this.account.id} (${this.account.name}, ${this.account.simulated ? 'demo' : 'LIVE'})`);
    await this.loadHistory(tradesSince);
    await this.reconcile();
    await this.hub.start();

    this.reconcileTimer = setInterval(() => this.reconcile().catch((err) => console.warn(`[user-hub] reconcile failed: ${err.message}`)), this.reconcileSecs * 1000);
    this.reconcileTimer.unref?.();
    this.orphanTimer = setInterval(() => this.sweepOrphans().catch((err) => console.warn(`[user-hub] orphan sweep failed: ${err.message}`)), ORPHAN_SWEEP_MS);
    this.orphanTimer.unref?.();
  }

  get accountId() {
    return this.account?.id ?? null;
  }

  /**
   * Runs on every hub connect, including rebuilds and SignalR reconnects. Events
   * sent while the socket was down are gone for good, so the REST state replaces
   * whatever the hub missed. A failed reconcile must not fail the resubscribe.
   */
  async onHubReady(hub) {
    await this.subscribe(hub);
    try {
      await this.reconcile();
    } catch (err) {
      console.warn(`[user-hub] reconcile after connect failed: ${err.message}`);
    }
  }

  async subscribe(hub) {
    const id = this.accountId;
    await hub.invoke('SubscribeAccounts');
    await hub.invoke('SubscribeOrders', id);
    await hub.invoke('SubscribePositions', id);
    await hub.invoke('SubscribeTrades', id);
  }

  async loadHistory(since) {
    const id = this.accountId;
    const [orders, trades] = await Promise.all([
      this.client.searchOrders(id, { start: Date.now() - 24 * 60 * 60 * 1000 }),
      this.client.searchTrades(id, { start: since }),
    ]);
    for (const o of orders) this.orders.set(o.id, o);
    for (const t of trades) this.addTrade(t);
  }

  async reconcile() {
    const id = this.accountId;
    if (!id) return;
    const [accounts, positions, openOrders] = await Promise.all([
      this.client.searchAccounts({ onlyActive: true }).catch(() => null),
      this.client.searchOpenPositions(id, { priority: PRIORITY.BACKGROUND }),
      this.client.searchOpenOrders(id, { priority: PRIORITY.BACKGROUND }),
    ]);

    const acct = accounts?.find((a) => a.id === id);
    if (acct) this.onAccount(acct);

    this.positions = new Map(positions.filter((p) => Number(p.size) > 0).map((p) => [p.contractId, p]));

    const openIds = new Set(openOrders.map((o) => o.id));
    for (const o of openOrders) this.orders.set(o.id, { ...this.orders.get(o.id), ...o });
    const vanished = [...this.orders.values()].filter((o) => !FINAL.has(o.status) && !openIds.has(o.id));
    if (vanished.length) {
      const start = Math.min(...vanished.map((o) => Date.parse(o.creationTimestamp) || Date.now())) - 60_000;
      const recent = await this.client.searchOrders(id, { start, priority: PRIORITY.BACKGROUND });
      for (const o of recent) this.onOrder(o);
    }
    this.lastReconcileAt = Date.now();
    if (this.pruneArmed) this.prune();
    this.emit('reconciled');
  }

  /**
   * Allows prune() to run after every reconcile. Not armed at first: the guard
   * rebuilds missed end-of-day history from the 90 days of fills loaded at start,
   * and pruning them earlier would shorten that history.
   */
  armPruning() {
    this.pruneArmed = true;
    this.prune();
  }

  /**
   * Drops finished orders older than retention.orders_days and fills older than
   * retention.trades_days, so a gateway that runs for months does not grow without
   * bound. Working orders are never dropped. Also clears bookkeeping that points at
   * orders that are gone.
   */
  prune(now = Date.now()) {
    const orderCutoff = now - this.retention.orders_days * DAY_MS;
    const tradeCutoff = now - this.retention.trades_days * DAY_MS;
    const dropped = { orders: 0, trades: 0 };

    for (const [id, o] of this.orders) {
      if (!FINAL.has(o.status)) continue;
      const ts = Date.parse(o.updateTimestamp || o.creationTimestamp);
      if (Number.isFinite(ts) && ts < orderCutoff) {
        this.orders.delete(id);
        dropped.orders += 1;
      }
    }
    for (const [id, t] of this.trades) {
      const ts = Date.parse(t.creationTimestamp);
      if (Number.isFinite(ts) && ts < tradeCutoff) {
        this.removeTrade(id);
        dropped.trades += 1;
      }
    }
    for (const id of this.strikes.keys()) {
      const order = this.orders.get(id);
      if (!order || FINAL.has(order.status)) this.strikes.delete(id);
    }
    for (const [id, list] of this.waiters) {
      if (!list.length) this.waiters.delete(id);
    }
    return dropped;
  }

  addTrade(t) {
    const previous = this.trades.get(t.id);
    if (previous && previous.orderId !== t.orderId) this.unindexTrade(previous);
    this.trades.set(t.id, t);
    if (t.orderId === null || t.orderId === undefined) return;
    let byId = this.tradesByOrder.get(t.orderId);
    if (!byId) {
      byId = new Map();
      this.tradesByOrder.set(t.orderId, byId);
    }
    byId.set(t.id, t);
  }

  removeTrade(id) {
    const t = this.trades.get(id);
    if (!t) return;
    this.trades.delete(id);
    this.unindexTrade(t);
  }

  unindexTrade(t) {
    const byId = this.tradesByOrder.get(t.orderId);
    if (!byId) return;
    byId.delete(t.id);
    if (!byId.size) this.tradesByOrder.delete(t.orderId);
  }

  onAccount(a) {
    if (!a || (this.accountId && a.id !== this.accountId)) return;
    this.account = { ...this.account, ...a, balance: Number(a.balance) || 0 };
    this.emit('account', this.account);
  }

  onOrder(o) {
    if (!o?.id || (this.accountId && o.accountId && o.accountId !== this.accountId)) return;
    const merged = { ...this.orders.get(o.id), ...o };
    this.orders.set(o.id, merged);
    if (FINAL.has(merged.status)) {
      const waiters = this.waiters.get(o.id);
      if (waiters) {
        this.waiters.delete(o.id);
        for (const w of waiters) w(merged);
      }
    }
    this.emit('order', merged);
  }

  onPosition(p) {
    if (!p?.contractId || (this.accountId && p.accountId && p.accountId !== this.accountId)) return;
    if (Number(p.size) > 0) this.positions.set(p.contractId, p);
    else this.positions.delete(p.contractId);
    this.emit('position', p);
  }

  onTrade(t) {
    if (!t?.id || (this.accountId && t.accountId && t.accountId !== this.accountId)) return;
    this.addTrade(t);
    this.emit('trade', t);
  }

  /** Resolves with the order once it is filled/cancelled/rejected, or null on timeout. */
  waitForFinal(orderId, timeoutMs) {
    const known = this.orders.get(orderId);
    if (known && FINAL.has(known.status)) return Promise.resolve(known);
    return new Promise((resolve) => {
      const list = this.waiters.get(orderId) || [];
      const timer = setTimeout(() => {
        const rest = (this.waiters.get(orderId) || []).filter((w) => w !== done);
        if (rest.length) this.waiters.set(orderId, rest);
        else this.waiters.delete(orderId);
        resolve(null);
      }, timeoutMs);
      const done = (order) => {
        clearTimeout(timer);
        resolve(order);
      };
      list.push(done);
      this.waiters.set(orderId, list);
    });
  }

  tradesForOrder(orderId) {
    const byId = this.tradesByOrder.get(orderId);
    return byId ? [...byId.values()].filter((t) => !t.voided) : [];
  }

  openOrders() {
    return [...this.orders.values()].filter((o) => !FINAL.has(o.status));
  }

  positionFor(contractId) {
    return this.positions.get(contractId) || null;
  }

  async sweepOrphans() {
    const id = this.accountId;
    if (!id) return;
    for (const order of this.openOrders()) {
      if (!String(order.customTag || '').startsWith(PROTECT_TAG)) continue;
      const pos = this.positionFor(order.contractId);
      const key = order.id;

      if (!pos) {
        const strikes = (this.strikes.get(key) || 0) + 1;
        this.strikes.set(key, strikes);
        if (strikes < CANCEL_STRIKES) continue;
        await this.cancelOrphan(order, 'position is flat');
        continue;
      }
      this.strikes.delete(key);

      const longPos = pos.type === POSITION_TYPE.LONG;
      const reduces = longPos ? order.side === ORDER_SIDE.SELL : order.side === ORDER_SIDE.BUY;
      if (!reduces) {
        await this.cancelOrphan(order, 'position flipped');
        continue;
      }
      if (Number(order.size) > Number(pos.size)) {
        try {
          await this.client.modifyOrder({ accountId: id, orderId: order.id, size: Number(pos.size) });
          console.log(`[user-hub] protective order ${order.id} shrunk to ${pos.size}`);
        } catch (err) {
          console.warn(`[user-hub] shrink ${order.id} failed: ${err.message}`);
        }
      }
    }
  }

  async cancelOrphan(order, reason) {
    try {
      await this.client.cancelOrder(this.accountId, order.id);
      this.strikes.delete(order.id);
      console.warn(`[user-hub] cancelled orphan protective order ${order.id} (${reason})`);
      this.emit('orphan-cancelled', order, reason);
    } catch (err) {
      console.warn(`[user-hub] cancel orphan ${order.id} failed: ${err.message}`);
    }
  }

  status() {
    return {
      ...this.hub.status(),
      account: this.account ? { id: this.account.id, name: this.account.name, simulated: this.account.simulated } : null,
      accountError: this.accountError,
      positions: this.positions.size,
      openOrders: this.openOrders().length,
      lastReconcileAt: this.lastReconcileAt || null,
      reconcileAgeMs: this.lastReconcileAt ? Date.now() - this.lastReconcileAt : null,
    };
  }

  async stop() {
    clearInterval(this.reconcileTimer);
    clearInterval(this.orphanTimer);
    await this.hub.stop();
  }
}
