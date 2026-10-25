import { EventEmitter } from 'node:events';

import { ManagedHub, entries } from './hub.js';

export const DOM_TYPE = Object.freeze({
  UNKNOWN: 0, ASK: 1, BID: 2, BEST_ASK: 3, BEST_BID: 4, TRADE: 5, RESET: 6,
  LOW: 7, HIGH: 8, NEW_BEST_BID: 9, NEW_BEST_ASK: 10, FILL: 11,
});

/** TradeLogType: the aggressor side. 0 = buyer lifted the offer, 1 = seller hit the bid. */
const TRADE_BUY = 0;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Market hub client.
 *
 * Payload shapes here follow what botprimex-chart measured on the live hub, which
 * differ from the published examples:
 *   - GatewayQuote is a PARTIAL delta: about half carry no lastPrice, and
 *     open/high/low arrive once per subscription. Every field is latched.
 *   - changePercent is a fraction (-0.009 for -0.9%).
 *   - GatewayTrade and GatewayDepth arrive as arrays.
 *   - Depth on this entitlement is Level 1 only: best bid/ask, the session
 *     volume-at-price profile (DomType 5) and session extremes. No ladder.
 */
export class MarketStream extends EventEmitter {
  constructor({ url, tokenFactory, contracts, hubFactory }) {
    super();
    this.contracts = contracts;
    this.wanted = new Map();
    this.subscribed = new Set();
    this.subscribedAt = new Map();
    this.quotes = new Map();
    this.profiles = new Map();
    this.hub = new ManagedHub({
      name: 'market-hub',
      url,
      tokenFactory,
      factory: hubFactory,
      handlers: {
        GatewayQuote: (contractId, payload) => this.onQuote(contractId, payload),
        GatewayTrade: (contractId, payload) => this.onTrade(contractId, payload),
        GatewayDepth: (contractId, payload) => this.onDepth(contractId, payload),
      },
      onReady: (hub, { reconnected }) => this.resubscribeAll(hub, reconnected),
      onState: (state, info) => this.emit('state', state, info),
    });
  }

  async start(roots) {
    for (const root of roots) this.want(root);
    await this.hub.start();
  }

  want(root) {
    const front = this.contracts.front(root);
    if (!front) {
      console.warn(`[market-hub] no front contract for ${root}`);
      return null;
    }
    this.wanted.set(front.contractId, root);
    return front.contractId;
  }

  async subscribe(hub, contractId) {
    await hub.invoke('SubscribeContractQuotes', contractId);
    await hub.invoke('SubscribeContractTrades', contractId);
    try {
      await hub.invoke('SubscribeContractMarketDepth', contractId);
    } catch (err) {
      console.warn(`[market-hub] depth refused for ${contractId}: ${err.message}`);
    }
    this.subscribed.add(contractId);
    this.subscribedAt.set(contractId, Date.now());
  }

  async resubscribeAll(hub, reconnected) {
    this.subscribed = new Set();
    this.subscribedAt = new Map();
    for (const [contractId, root] of this.wanted) {
      // The gateway re-sends the profile snapshot on subscribe.
      this.profiles.get(contractId)?.clear();
      try {
        await this.subscribe(hub, contractId);
      } catch (err) {
        console.warn(`[market-hub] subscribe ${root} failed: ${err.message}`);
      }
    }
    if (reconnected) this.emit('reconnected', [...this.wanted.values()]);
  }

  /** Follow a contract roll: move the subscription to the new front. */
  async roll(root, fromId, toId) {
    this.wanted.delete(fromId);
    this.wanted.set(toId, root);
    if (this.hub.connection) {
      for (const m of ['UnsubscribeContractQuotes', 'UnsubscribeContractTrades', 'UnsubscribeContractMarketDepth']) {
        try { await this.hub.invoke(m, fromId); } catch { /* already gone */ }
      }
      await this.subscribe(this.hub.connection, toId);
    }
  }

  rootFor(contractId) {
    return this.wanted.get(contractId) || this.contracts.rootForContract(contractId);
  }

  quoteFor(root) {
    for (const [contractId, r] of this.wanted) {
      if (r === root) return this.quotes.get(contractId) || null;
    }
    return null;
  }

  wantedRoots() {
    return [...new Set(this.wanted.values())];
  }

  /**
   * Local time of the newest quote, trade or depth message for the root, or of
   * the latest (re)subscription if that is newer. Local receive time on purpose:
   * server timestamps would turn clock skew into false staleness. Null when the
   * root is not subscribed.
   */
  quoteSince(root) {
    for (const [contractId, r] of this.wanted) {
      if (r !== root) continue;
      return Math.max(this.quotes.get(contractId)?.receivedAt || 0, this.subscribedAt.get(contractId) || 0) || null;
    }
    return null;
  }

  quoteAgeMs(root, now = Date.now()) {
    const since = this.quoteSince(root);
    return since === null ? null : Math.max(0, now - since);
  }

  profileFor(root) {
    for (const [contractId, r] of this.wanted) {
      if (r === root) return this.profiles.get(contractId) || new Map();
    }
    return new Map();
  }

  latchedQuote(contractId) {
    let q = this.quotes.get(contractId);
    if (!q) {
      q = {
        contractId, root: this.rootFor(contractId), last: null, bid: null, ask: null, bidSize: null, askSize: null,
        open: null, high: null, low: null, volume: null, change: null, changePercent: null, ts: 0, receivedAt: 0,
      };
      this.quotes.set(contractId, q);
    }
    return q;
  }

  onQuote(contractId, payload) {
    const q = this.latchedQuote(contractId);
    q.receivedAt = Date.now();
    for (const data of entries(payload)) {
      if (!data || typeof data !== 'object') continue;
      const last = num(data.lastPrice);
      if (last > 0) q.last = last;
      const bid = num(data.bestBid);
      if (bid > 0) q.bid = bid;
      const ask = num(data.bestAsk);
      if (ask > 0) q.ask = ask;
      const open = num(data.open);
      if (open > 0) q.open = open;
      const high = num(data.high);
      if (high > 0) q.high = high;
      const low = num(data.low);
      if (low > 0) q.low = low;
      const volume = num(data.volume);
      if (volume !== null && volume >= 0) q.volume = volume;
      const change = num(data.change);
      if (change !== null) q.change = change;
      const pct = num(data.changePercent);
      if (pct !== null) q.changePercent = pct * 100;
      const ts = Date.parse(data.timestamp || data.lastUpdated || '');
      q.ts = Number.isFinite(ts) ? ts : Date.now();
    }
    this.emit('quote', q.root, q);
  }

  onTrade(contractId, payload) {
    const root = this.rootFor(contractId);
    if (!root) return;
    const q = this.latchedQuote(contractId);
    q.receivedAt = Date.now();
    for (const data of entries(payload)) {
      const price = num(data?.price);
      const size = num(data?.volume);
      if (!(price > 0) || !(size > 0)) continue;
      const parsed = Date.parse(data.timestamp || '');
      const ts = Number.isFinite(parsed) ? parsed : Date.now();
      q.last = price;
      q.ts = ts;
      this.emit('tick', root, { ts, price, size, side: data.type === TRADE_BUY ? 'buy' : 'sell', contractId });
    }
  }

  onDepth(contractId, payload) {
    const root = this.rootFor(contractId);
    const q = this.latchedQuote(contractId);
    q.receivedAt = Date.now();
    let profile = this.profiles.get(contractId);
    if (!profile) {
      profile = new Map();
      this.profiles.set(contractId, profile);
    }
    for (const entry of entries(payload)) {
      if (!entry || entry.type === undefined || entry.type === null) continue;
      const price = num(entry.price);
      const volume = num(entry.volume);
      switch (entry.type) {
        case DOM_TYPE.RESET:
          profile.clear();
          break;
        case DOM_TYPE.BEST_BID:
        case DOM_TYPE.NEW_BEST_BID:
          if (price > 0) {
            q.bid = price;
            if (volume !== null) q.bidSize = num(entry.currentVolume) ?? volume;
          }
          break;
        case DOM_TYPE.BEST_ASK:
        case DOM_TYPE.NEW_BEST_ASK:
          if (price > 0) {
            q.ask = price;
            if (volume !== null) q.askSize = num(entry.currentVolume) ?? volume;
          }
          break;
        case DOM_TYPE.TRADE:
          // Running session total at the price, so it is assigned, not added.
          if (price > 0 && volume !== null && volume >= 0) profile.set(price, volume);
          break;
        case DOM_TYPE.HIGH:
          if (price > 0) q.high = price;
          break;
        case DOM_TYPE.LOW:
          if (price > 0) q.low = price;
          break;
        default:
          break;
      }
    }
    if (root) this.emit('depth', root, q);
  }

  status() {
    return {
      ...this.hub.status(),
      wanted: [...this.wanted.values()].sort(),
      live: [...this.subscribed].map((id) => this.wanted.get(id)).filter(Boolean).sort(),
    };
  }

  stop() {
    return this.hub.stop();
  }
}
