/**
 * Mock ProjectX upstream for tests and credential-free end-to-end runs
 * (PROJECTX_MOCK=1). It implements the same interface as ProjectXClient plus fake
 * market and user hubs: deterministic synthetic prices, a trade tape with
 * aggressor sides, and an exchange that fills market orders, triggers stops and
 * limits, nets positions and books P&L. It never contacts the real gateway.
 */
import { accountProduct, contractRoot, ORDER_SIDE, ORDER_STATUS, ORDER_TYPE, POSITION_TYPE } from './projectx.js';
import { GatewayError } from './errors.js';

const SPECS = {
  ES: { base: 6000, tick: 0.25, value: 12.5, desc: 'E-Mini S&P 500' },
  MES: { base: 6000, tick: 0.25, value: 1.25, desc: 'Micro E-mini S&P 500' },
  NQ: { base: 21000, tick: 0.25, value: 5, desc: 'E-mini NASDAQ-100' },
  MNQ: { base: 21000, tick: 0.25, value: 0.5, desc: 'Micro E-mini Nasdaq-100' },
  RTY: { base: 2200, tick: 0.1, value: 5, desc: 'E-mini Russell 2000' },
  M2K: { base: 2200, tick: 0.1, value: 0.5, desc: 'Micro E-mini Russell 2000' },
  YM: { base: 44000, tick: 1, value: 5, desc: 'E-mini Dow' },
  MYM: { base: 44000, tick: 1, value: 0.5, desc: 'Micro E-mini Dow' },
  GC: { base: 2400, tick: 0.1, value: 10, desc: 'Gold' },
  MGC: { base: 2400, tick: 0.1, value: 1, desc: 'Micro Gold' },
  CL: { base: 70, tick: 0.01, value: 10, desc: 'Crude Oil' },
  MCL: { base: 70, tick: 0.01, value: 1, desc: 'Micro Crude Oil' },
  MBT: { base: 95000, tick: 5, value: 0.5, desc: 'Micro Bitcoin' },
  MET: { base: 3500, tick: 0.5, value: 0.05, desc: 'Micro Ether' },
};
const UNIT_MS = { 1: 1000, 2: 60_000, 3: 3_600_000, 4: 86_400_000, 5: 604_800_000, 6: 2_592_000_000 };
const FEE_PER_CONTRACT = 0.37;
const COMMISSION_PER_CONTRACT = 0.25;

function hash(n) {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const snap = (p, tick) => Math.round(p / tick) * tick;

export function mockPrice(root, ts) {
  const spec = SPECS[root];
  const t = ts / 1000;
  const seed = root.split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  const drift = 0.02 * Math.sin((2 * Math.PI * t) / 21600 + seed)
    + 0.006 * Math.sin((2 * Math.PI * t) / 2220 + seed * 2)
    + 0.0015 * Math.sin((2 * Math.PI * t) / 186 + seed * 3);
  const noise = (hash(Math.floor(t) + seed * 1_000_003) - 0.5) * 4 * spec.tick;
  return snap(spec.base * Math.exp(drift) + noise, spec.tick);
}

class FakeHub {
  constructor(kind, exchange) {
    this.kind = kind;
    this.exchange = exchange;
    this.handlers = new Map();
    this.closeHandlers = [];
    this.state = 'Disconnected';
    this.timers = new Map();
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
  }

  emit(event, ...args) {
    for (const fn of this.handlers.get(event) || []) fn(...args);
  }

  onclose(fn) { this.closeHandlers.push(fn); }
  onreconnecting() {}
  onreconnected() {}

  async start() {
    this.state = 'Connected';
    if (this.kind === 'user') this.exchange.userHubs.add(this);
  }

  async stop() {
    this.state = 'Disconnected';
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    this.exchange.userHubs.delete(this);
  }

  async invoke(method, contractId) {
    if (this.kind !== 'market') return;
    if (method === 'SubscribeContractTrades' && !this.timers.has(contractId)) {
      const root = contractRoot({ name: this.exchange.contractsById.get(contractId)?.name });
      const spec = SPECS[root];
      let n = 0;
      const timer = setInterval(() => {
        const now = Date.now();
        const price = mockPrice(root, now);
        const prints = [];
        const count = 1 + Math.floor(hash(now) * 3);
        for (let i = 0; i < count; i += 1) {
          const big = hash(now + i * 7) > 0.995;
          prints.push({
            symbolId: `F.US.${root}`,
            price,
            timestamp: new Date(now).toISOString(),
            type: hash(now + i) > 0.5 ? 0 : 1,
            volume: big ? 40 + Math.floor(hash(now + i * 3) * 60) : 1 + Math.floor(hash(now + i * 5) * 4),
          });
        }
        this.exchange.lastPrices.set(root, price);
        this.emit('GatewayTrade', contractId, prints);
        this.emit('GatewayQuote', contractId, {
          symbol: `F.US.${root}`,
          lastPrice: n % 2 === 0 ? price : undefined,
          bestBid: price - spec.tick,
          bestAsk: price + spec.tick,
          timestamp: new Date(now).toISOString(),
          ...(n === 0 ? { open: price, high: price, low: price, volume: 0, change: 0, changePercent: 0 } : {}),
        });
        this.emit('GatewayDepth', contractId, [
          { type: 4, price: price - spec.tick, volume: 10 + Math.floor(hash(now) * 40) },
          { type: 3, price: price + spec.tick, volume: 10 + Math.floor(hash(now + 1) * 40) },
          { type: 5, price, volume: 100 + n },
        ]);
        this.exchange.onPrice(root, price);
        n += 1;
      }, 250);
      timer.unref?.();
      this.timers.set(contractId, timer);
    }
    if (method === 'UnsubscribeContractTrades') {
      clearInterval(this.timers.get(contractId));
      this.timers.delete(contractId);
    }
  }
}

class MockExchange {
  constructor({ balance = 50000, accountName = '50KTC-V2-MOCK-1001' } = {}) {
    this.account = { id: 1001, name: accountName, balance, canTrade: true, isVisible: true, simulated: true };
    this.contracts = Object.entries(SPECS).map(([root, s]) => ({
      id: `CON.F.US.${root}.Z26`, name: `${root}Z6`, description: `${s.desc}: December 2026`,
      tickSize: s.tick, tickValue: s.value, activeContract: true, symbolId: `F.US.${root}`,
    }));
    this.contractsById = new Map(this.contracts.map((c) => [c.id, c]));
    this.orders = new Map();
    this.positions = new Map();
    this.trades = [];
    this.lastPrices = new Map();
    this.userHubs = new Set();
    this.nextId = 5000;
  }

  push(event, payload) {
    setTimeout(() => {
      for (const hub of this.userHubs) hub.emit(event, payload);
    }, 15);
  }

  rootOf(contractId) {
    const name = this.contractsById.get(contractId)?.name;
    return name ? contractRoot({ name }) : String(contractId).split('.')[3];
  }

  price(root) {
    return this.lastPrices.get(root) ?? mockPrice(root, Date.now());
  }

  fill(order, price) {
    const root = this.rootOf(order.contractId);
    const spec = SPECS[root];
    const pointValue = spec.value / spec.tick;
    const signed = order.side === ORDER_SIDE.BUY ? order.size : -order.size;
    const pos = this.positions.get(order.contractId);
    const current = pos ? (pos.type === POSITION_TYPE.LONG ? pos.size : -pos.size) : 0;
    let pnl = null;

    if (current !== 0 && Math.sign(current) !== Math.sign(signed)) {
      const closing = Math.min(Math.abs(current), Math.abs(signed));
      pnl = (price - pos.averagePrice) * closing * pointValue * Math.sign(current);
    }
    const next = current + signed;
    if (next === 0) {
      this.positions.delete(order.contractId);
    } else {
      const sameSide = current === 0 || Math.sign(current) === Math.sign(signed);
      const avg = sameSide
        ? ((pos?.averagePrice || 0) * Math.abs(current) + price * Math.abs(signed)) / Math.abs(next)
        : (Math.sign(next) === Math.sign(current) ? pos.averagePrice : price);
      this.positions.set(order.contractId, {
        id: pos?.id ?? (this.nextId += 1),
        accountId: this.account.id,
        contractId: order.contractId,
        creationTimestamp: pos?.creationTimestamp ?? new Date().toISOString(),
        type: next > 0 ? POSITION_TYPE.LONG : POSITION_TYPE.SHORT,
        size: Math.abs(next),
        averagePrice: avg,
      });
    }

    const fees = FEE_PER_CONTRACT * order.size;
    const commissions = COMMISSION_PER_CONTRACT * order.size;
    const trade = {
      id: (this.nextId += 1), accountId: this.account.id, contractId: order.contractId,
      creationTimestamp: new Date().toISOString(), price, profitAndLoss: pnl, fees, commissions,
      side: order.side, size: order.size, voided: false, orderId: order.id,
    };
    this.trades.push(trade);
    this.account.balance += (pnl || 0) - fees - commissions;

    Object.assign(order, { status: ORDER_STATUS.FILLED, fillVolume: order.size, filledPrice: price, updateTimestamp: new Date().toISOString() });
    this.push('GatewayUserTrade', trade);
    this.push('GatewayUserOrder', { ...order });
    this.push('GatewayUserPosition', this.positions.get(order.contractId) || { accountId: this.account.id, contractId: order.contractId, size: 0, type: 0, averagePrice: 0 });
    this.push('GatewayUserAccount', { ...this.account });
  }

  onPrice(root, price) {
    for (const o of this.orders.values()) {
      if (o.status !== ORDER_STATUS.OPEN || this.rootOf(o.contractId) !== root) continue;
      const buy = o.side === ORDER_SIDE.BUY;
      if (o.type === ORDER_TYPE.LIMIT && (buy ? price <= o.limitPrice : price >= o.limitPrice)) this.fill(o, o.limitPrice);
      else if (o.type === ORDER_TYPE.STOP && (buy ? price >= o.stopPrice : price <= o.stopPrice)) this.fill(o, price);
      else if (o.type === ORDER_TYPE.STOP_LIMIT && (buy ? price >= o.stopPrice : price <= o.stopPrice)) {
        o.type = ORDER_TYPE.LIMIT;
      }
    }
  }

  place(body) {
    if (!this.contractsById.has(body.contractId)) {
      throw new GatewayError('Contract not found', { status: 400, kind: 'BadSymbol', errorCode: 8 });
    }
    const order = {
      id: (this.nextId += 1), accountId: this.account.id, contractId: body.contractId, symbolId: null,
      creationTimestamp: new Date().toISOString(), updateTimestamp: new Date().toISOString(),
      status: ORDER_STATUS.OPEN, type: body.type, side: body.side, size: body.size,
      limitPrice: body.limitPrice ?? null, stopPrice: body.stopPrice ?? null, fillVolume: 0, filledPrice: null,
      customTag: body.customTag ?? null,
    };
    this.orders.set(order.id, order);
    this.push('GatewayUserOrder', { ...order });
    const root = this.rootOf(order.contractId);
    const spec = SPECS[root];
    if (order.type === ORDER_TYPE.MARKET) {
      const px = this.price(root) + (order.side === ORDER_SIDE.BUY ? spec.tick : -spec.tick);
      setTimeout(() => this.fill(order, px), 20);
    }
    return { orderId: order.id, success: true, errorCode: 0, errorMessage: null };
  }
}

export function createMockUpstream(cfg = {}) {
  const ex = new MockExchange({ accountName: process.env.PROJECTX_MOCK_ACCOUNT || '50KTC-V2-MOCK-1001' });
  const client = {
    exchange: ex,
    isConfigured: () => true,
    getToken: async () => 'mock-token',
    status: () => ({ configured: true, tokenValid: true, live: false, latency: { lastMs: 0, avgMs: 0, samples: 0 }, mock: true }),
    async searchAccounts() {
      return [{ ...ex.account, visible: true, ...accountProduct(ex.account.name) }];
    },
    async availableContracts() {
      return ex.contracts.map((c) => ({
        contractId: c.id, name: c.name, root: contractRoot(c), symbolId: c.symbolId, description: c.description,
        tickSize: c.tickSize, tickValue: c.tickValue, activeContract: true,
      }));
    },
    async retrieveBars({ contractId, unit, unitNumber, startTime, endTime, limit }) {
      const root = ex.rootOf(contractId);
      const ms = UNIT_MS[unit] * unitNumber;
      const end = Math.min(new Date(endTime).getTime(), Date.now());
      const first = Math.ceil(new Date(startTime).getTime() / ms) * ms;
      const out = [];
      for (let t = Math.floor(end / ms) * ms; t >= first && out.length < limit; t -= ms) {
        const samples = 12;
        const pts = [];
        for (let i = 0; i <= samples; i += 1) pts.push(mockPrice(root, t + (ms * i) / samples));
        out.push([t, pts[0], Math.max(...pts), Math.min(...pts), pts[samples], Math.max(1, Math.round(hash(t / 1000) * 50 * (ms / 60000)))]);
      }
      return out.reverse();
    },
    async placeOrder(body) {
      return ex.place(body);
    },
    async cancelOrder(accountId, orderId) {
      const o = ex.orders.get(orderId);
      if (o && o.status === ORDER_STATUS.OPEN) {
        o.status = ORDER_STATUS.CANCELLED;
        o.updateTimestamp = new Date().toISOString();
        ex.push('GatewayUserOrder', { ...o });
      }
      return { success: true };
    },
    async modifyOrder({ orderId, size, limitPrice, stopPrice }) {
      const o = ex.orders.get(orderId);
      if (!o) throw new GatewayError('Order not found', { status: 400, kind: 'OrderNotFound' });
      if (size) o.size = size;
      if (limitPrice) o.limitPrice = limitPrice;
      if (stopPrice) o.stopPrice = stopPrice;
      ex.push('GatewayUserOrder', { ...o });
      return { success: true };
    },
    async closeContract(accountId, contractId) {
      const pos = ex.positions.get(contractId);
      if (!pos) return { success: true };
      ex.place({ contractId, type: ORDER_TYPE.MARKET, side: pos.type === POSITION_TYPE.LONG ? ORDER_SIDE.SELL : ORDER_SIDE.BUY, size: pos.size, customTag: null });
      return { success: true };
    },
    async partialCloseContract(accountId, contractId, size) {
      const pos = ex.positions.get(contractId);
      if (!pos) return { success: true };
      ex.place({ contractId, type: ORDER_TYPE.MARKET, side: pos.type === POSITION_TYPE.LONG ? ORDER_SIDE.SELL : ORDER_SIDE.BUY, size: Math.min(size, pos.size) });
      return { success: true };
    },
    async searchOpenOrders() {
      return [...ex.orders.values()].filter((o) => o.status === ORDER_STATUS.OPEN).map((o) => ({ ...o }));
    },
    async searchOrders(accountId, { start }) {
      return [...ex.orders.values()].filter((o) => Date.parse(o.creationTimestamp) >= start).map((o) => ({ ...o }));
    },
    async searchOpenPositions() {
      return [...ex.positions.values()].map((p) => ({ ...p }));
    },
    async searchTrades(accountId, { start }) {
      return ex.trades.filter((t) => Date.parse(t.creationTimestamp) >= start).map((t) => ({ ...t }));
    },
  };

  return {
    client,
    marketHubFactory: () => new FakeHub('market', ex),
    userHubFactory: () => new FakeHub('user', ex),
  };
}
