/**
 * ProjectX Gateway REST client.
 *
 * Ported from botprimex-chart/server/projectx.js and narrowed to what Freqtrade
 * needs. Behaviour that was learned against the live gateway is kept:
 *
 *   - Every response carries success/errorCode/errorMessage, and a logically failed
 *     call still arrives as HTTP 200, so the envelope is checked, not just HTTP.
 *   - The session token lives 24h; it is re-minted at 23h, single-flight, and once
 *     more on any 401 because the gateway can revoke early.
 *   - /api/Contract/search is a substring match ("ES" also returns MES, ZF, 6J...),
 *     so roots are resolved exactly against /api/Contract/available.
 *   - The contract list is empty, not an error, when `live` does not match the
 *     account's data subscription; an empty list is never cached.
 *
 * Every call goes through the RateLimiter so orders always jump the queue.
 */
import { GatewayError, placeErrorKind } from './errors.js';
import { PRIORITY } from './limiter.js';

const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const ORDER_TIMEOUT_MS = 8_000;
const AVAILABLE_TTL_MS = 10 * 60 * 1000;

export const BAR_UNIT = Object.freeze({ SECOND: 1, MINUTE: 2, HOUR: 3, DAY: 4, WEEK: 5, MONTH: 6 });
export const MAX_BARS_PER_REQUEST = 20000;

export const ORDER_TYPE = Object.freeze({
  LIMIT: 1, MARKET: 2, STOP_LIMIT: 3, STOP: 4, TRAILING_STOP: 5, JOIN_BID: 6, JOIN_ASK: 7,
});
export const ORDER_SIDE = Object.freeze({ BUY: 0, SELL: 1 });
export const ORDER_STATUS = Object.freeze({
  NONE: 0, OPEN: 1, FILLED: 2, CANCELLED: 3, EXPIRED: 4, REJECTED: 5, PENDING: 6,
});
export const POSITION_TYPE = Object.freeze({ LONG: 1, SHORT: 2 });

/** CME month codes as used in contract names (MNQU6 = MNQ, Sep 2026). */
const MONTH_YEAR_SUFFIX = /([FGHJKMNQUVXZ])(\d{1,2})$/;
const MONTH_CODES = 'FGHJKMNQUVXZ';

export function contractRoot(contract) {
  const name = String(contract?.name || '').toUpperCase();
  const stripped = name.replace(MONTH_YEAR_SUFFIX, '');
  if (stripped.length >= 1) return stripped;
  return String(contract?.symbolId || '').split('.').pop() || name;
}

/** Contract month and year from the name, e.g. MESZ5 -> { month: 12, year: 2025 }. */
export function contractMonth(name, now = new Date()) {
  const match = MONTH_YEAR_SUFFIX.exec(String(name || '').toUpperCase());
  if (!match) return null;
  const month = MONTH_CODES.indexOf(match[1]) + 1;
  const digits = match[2];
  const nowYear = now.getUTCFullYear();
  let year;
  if (digits.length === 2) {
    year = 2000 + Number(digits);
  } else {
    // Single digit: the nearest year at or after this decade's matching digit.
    year = nowYear - (nowYear % 10) + Number(digits);
    if (year < nowYear - 1) year += 10;
  }
  return { month, year };
}

/**
 * The account name encodes the product: `50KTC-V2-...` is a $50K Trading Combine,
 * `XFA` an Express Funded Account, `LFA` Live Funded. The gateway reports no account
 * size or limits at all, so this is the only signal for defaulting Topstep's rules.
 */
export function accountProduct(name) {
  // Only known product codes: a name like "6KCHCR-LABS005-..." is not a 6K account.
  const match = /^(\d+)K(TC|XFA|LFA|PA)(?![A-Z])/.exec(String(name || '').trim().toUpperCase());
  if (!match) return { sizeUsd: null, kind: null };
  const thousands = Number(match[1]);
  return {
    sizeUsd: Number.isFinite(thousands) && thousands > 0 ? thousands * 1000 : null,
    kind: match[2] || null,
  };
}

export class ProjectXClient {
  constructor({ apiBase, username, apiKey, live = false }, limiter) {
    this.apiBase = apiBase;
    this.username = username;
    this.apiKey = apiKey;
    this.live = live;
    this.limiter = limiter;

    this.token = null;
    this.tokenUntil = 0;
    this.inFlightLogin = null;

    this.availableCache = null;
    this.availableUntil = 0;
    this.inFlightAvailable = null;

    this.latency = { lastMs: null, avgMs: null, samples: 0 };
  }

  isConfigured() {
    return Boolean(this.username && this.apiKey);
  }

  recordLatency(ms) {
    this.latency.lastMs = ms;
    this.latency.samples += 1;
    this.latency.avgMs = this.latency.avgMs === null ? ms : this.latency.avgMs * 0.9 + ms * 0.1;
  }

  async rawPost(path, body, { token = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const headers = { 'Content-Type': 'application/json', accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const started = performance.now();
    let response;
    try {
      response = await fetch(`${this.apiBase}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError';
      throw new GatewayError(
        timedOut ? `ProjectX request timed out: ${path}` : `ProjectX request failed: ${err.message}`,
        { status: 504, kind: timedOut ? 'RequestTimeout' : 'NetworkError' },
      );
    }
    this.recordLatency(performance.now() - started);

    if (response.status === 429) {
      throw new GatewayError(`ProjectX rate limit reached on ${path}.`, { status: 429, kind: 'RateLimitExceeded' });
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (response.status === 401) {
      throw new GatewayError(`ProjectX rejected the session on ${path}.`, { status: 401, kind: 'AuthenticationError' });
    }
    if (!response.ok) {
      throw new GatewayError(payload?.errorMessage || `ProjectX ${path} returned HTTP ${response.status}`, {
        status: 502,
        kind: response.status >= 500 ? 'ExchangeNotAvailable' : 'BadRequest',
        errorCode: payload?.errorCode ?? null,
      });
    }
    if (payload && payload.success === false) {
      const kind = path === '/api/Order/place' ? placeErrorKind(payload.errorCode) : 'ExchangeError';
      const err = new GatewayError(
        payload.errorMessage || `ProjectX ${path} rejected the request (code ${payload.errorCode}).`,
        { status: 400, kind, errorCode: payload.errorCode ?? null },
      );
      err.payload = payload;
      throw err;
    }
    return payload ?? {};
  }

  async getToken({ force = false } = {}) {
    if (!this.isConfigured()) {
      throw new GatewayError('ProjectX is not configured. Set PROJECTX_USERNAME and PROJECTX_API_KEY.', {
        status: 503, kind: 'AuthenticationError',
      });
    }
    if (!force && this.token && Date.now() < this.tokenUntil) return this.token;
    if (this.inFlightLogin) return this.inFlightLogin;

    this.inFlightLogin = (async () => {
      try {
        const payload = await this.limiter.schedule('/api/Auth/loginKey', PRIORITY.ORDER, () =>
          this.rawPost('/api/Auth/loginKey', { userName: this.username, apiKey: this.apiKey }));
        if (!payload?.token) throw new GatewayError('ProjectX login returned no token.', { kind: 'AuthenticationError' });
        this.token = payload.token;
        this.tokenUntil = Date.now() + TOKEN_TTL_MS;
        console.log(`[projectx] session token minted for ${this.username}`);
        return this.token;
      } finally {
        this.inFlightLogin = null;
      }
    })();
    return this.inFlightLogin;
  }

  /**
   * Authenticated call through the limiter. Reads retry on 429 with backoff; an
   * order is retried once on 429 only, because a 429 is refused before processing.
   */
  async call(path, body, { priority = PRIORITY.READ, timeoutMs, retries = 2 } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const token = await this.getToken();
        return await this.limiter.schedule(path, priority, async () => {
          try {
            return await this.rawPost(path, body, { token, timeoutMs });
          } catch (err) {
            if (err.status === 401) {
              const fresh = await this.getToken({ force: true });
              return this.rawPost(path, body, { token: fresh, timeoutMs });
            }
            throw err;
          }
        });
      } catch (err) {
        if (err.status === 429 && attempt < retries) {
          const delay = 1000 * (attempt + 1);
          this.limiter.backoff(path, delay);
          continue;
        }
        throw err;
      }
    }
  }

  /* ------------------------------------------------------------- accounts -- */

  async searchAccounts({ onlyActive = true } = {}) {
    const payload = await this.call('/api/Account/search', { onlyActiveAccounts: onlyActive });
    return (payload.accounts || []).map((a) => ({
      id: a.id,
      name: a.name || String(a.id),
      balance: Number(a.balance) || 0,
      canTrade: a.canTrade !== false,
      visible: a.isVisible !== false,
      // Not in the published schema; absent means demo, never "real money".
      simulated: a.simulated !== false,
      ...accountProduct(a.name),
    }));
  }

  /* ------------------------------------------------------------ contracts -- */

  async availableContracts({ force = false } = {}) {
    if (!force && this.availableCache && Date.now() < this.availableUntil) return this.availableCache;
    if (this.inFlightAvailable) return this.inFlightAvailable;

    this.inFlightAvailable = (async () => {
      try {
        const payload = await this.call('/api/Contract/available', { live: this.live });
        const rows = (payload.contracts || [])
          .filter((c) => c?.id && c?.name)
          .map((c) => ({
            contractId: c.id,
            name: c.name,
            root: contractRoot(c),
            symbolId: c.symbolId || null,
            description: c.description || c.name,
            tickSize: Number(c.tickSize) || 0,
            tickValue: Number(c.tickValue) || 0,
            activeContract: c.activeContract !== false,
          }));
        if (rows.length > 0) {
          this.availableCache = rows;
          this.availableUntil = Date.now() + AVAILABLE_TTL_MS;
        } else {
          console.warn(`[projectx] /api/Contract/available returned nothing with live=${this.live}; check live_data against the account's data subscription`);
        }
        return rows;
      } finally {
        this.inFlightAvailable = null;
      }
    })();
    return this.inFlightAvailable;
  }

  /* ----------------------------------------------------------------- bars -- */

  /** Oldest-first [ts, o, h, l, c, v]; ProjectX returns newest first. */
  async retrieveBars({ contractId, unit, unitNumber, startTime, endTime, limit, includePartialBar = true, priority = PRIORITY.READ }) {
    const payload = await this.call('/api/History/retrieveBars', {
      contractId,
      live: this.live,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      unit,
      unitNumber,
      limit: Math.min(limit, MAX_BARS_PER_REQUEST),
      includePartialBar,
    }, { priority });

    return (payload.bars || [])
      .map((b) => [Date.parse(b.t), Number(b.o), Number(b.h), Number(b.l), Number(b.c), Number(b.v) || 0])
      .filter((b) => Number.isFinite(b[0]) && b[1] > 0 && b[4] > 0 && b[2] >= b[3])
      .sort((a, b) => a[0] - b[0]);
  }

  /* --------------------------------------------------------------- orders -- */

  placeOrder(body) {
    return this.call('/api/Order/place', body, { priority: PRIORITY.ORDER, timeoutMs: ORDER_TIMEOUT_MS, retries: 1 });
  }

  cancelOrder(accountId, orderId) {
    return this.call('/api/Order/cancel', { accountId, orderId }, { priority: PRIORITY.ORDER, timeoutMs: ORDER_TIMEOUT_MS, retries: 1 });
  }

  modifyOrder(body) {
    return this.call('/api/Order/modify', body, { priority: PRIORITY.ORDER, timeoutMs: ORDER_TIMEOUT_MS, retries: 1 });
  }

  closeContract(accountId, contractId) {
    return this.call('/api/Position/closeContract', { accountId, contractId }, { priority: PRIORITY.ORDER, timeoutMs: ORDER_TIMEOUT_MS, retries: 1 });
  }

  partialCloseContract(accountId, contractId, size) {
    return this.call('/api/Position/partialCloseContract', { accountId, contractId, size }, { priority: PRIORITY.ORDER, timeoutMs: ORDER_TIMEOUT_MS, retries: 1 });
  }

  async searchOpenOrders(accountId, { priority = PRIORITY.READ } = {}) {
    const payload = await this.call('/api/Order/searchOpen', { accountId }, { priority });
    return payload.orders || [];
  }

  async searchOrders(accountId, { start, end = Date.now(), priority = PRIORITY.READ } = {}) {
    const payload = await this.call('/api/Order/search', {
      accountId,
      startTimestamp: new Date(start).toISOString(),
      endTimestamp: new Date(end).toISOString(),
    }, { priority });
    return payload.orders || [];
  }

  async searchOpenPositions(accountId, { priority = PRIORITY.READ } = {}) {
    const payload = await this.call('/api/Position/searchOpen', { accountId }, { priority });
    return payload.positions || [];
  }

  async searchTrades(accountId, { start, end = Date.now(), priority = PRIORITY.READ } = {}) {
    const payload = await this.call('/api/Trade/search', {
      accountId,
      startTimestamp: new Date(start).toISOString(),
      endTimestamp: new Date(end).toISOString(),
    }, { priority });
    return payload.trades || [];
  }

  status() {
    return {
      configured: this.isConfigured(),
      tokenValid: Boolean(this.token && Date.now() < this.tokenUntil),
      live: this.live,
      latency: this.latency,
    };
  }
}
