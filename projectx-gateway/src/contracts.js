import { pairOf } from './config.js';
import { contractMonth } from './projectx.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1, 12));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7, 12);
}

function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0, 12));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return Date.UTC(year, month - 1, last.getUTCDate() - offset, 12);
}

export const MONTH_CODES = 'FGHJKMNQUVXZ';

const QUARTERLY = 'HMUZ';
const ALL_MONTHS = MONTH_CODES;
const ROOT_KIND = {};
const kinds = {
  index: ['ES', 'MES', 'NQ', 'MNQ', 'RTY', 'M2K', 'YM', 'MYM', 'NKD'],
  fx: ['6A', '6B', '6C', '6E', '6J', '6M', '6N', '6S', 'E7', 'M6A', 'M6B', 'M6E'],
  rates: ['ZT', 'ZF', 'ZN', 'TN', 'ZB', 'UB'],
  crude: ['CL', 'MCL', 'QM'],
  products: ['NG', 'QG', 'MNG', 'HO', 'RB'],
  metal: ['GC', 'MGC', 'SI', 'SIL', 'HG', 'MHG', 'PL'],
  crypto: ['MBT', 'MET'],
  ags: ['ZC', 'ZS', 'ZW', 'ZL', 'ZM', 'HE', 'LE'],
};
for (const [kind, roots] of Object.entries(kinds)) for (const r of roots) ROOT_KIND[r] = kind;

/** Contract months traded as the front month, per root (CME listing cycles). */
const CYCLES = {
  GC: 'GJMQVZ', MGC: 'GJMQVZ', PL: 'FJNV',
  SI: 'HKNUZ', SIL: 'HKNUZ', HG: 'HKNUZ', MHG: 'HKNUZ',
  ZC: 'HKNUZ', ZW: 'HKNUZ', ZS: 'FHKNQUX', ZL: 'FHKNQUVZ', ZM: 'FHKNQUVZ',
  HE: 'GJKMNQVZ', LE: 'GJMQVZ',
};

export function cycleFor(root) {
  if (CYCLES[root]) return CYCLES[root];
  const kind = ROOT_KIND[root];
  return kind === 'index' || kind === 'fx' || kind === 'rates' ? QUARTERLY : ALL_MONTHS;
}

/**
 * Approximate last day a contract is worth holding. Used by the roll guard and
 * the continuous-history roll schedule, so precision to the day is enough;
 * exchange calendars and holidays are deliberately not modelled.
 */
export function expiryFor(root, month, year) {
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  switch (ROOT_KIND[root]) {
    case 'crude':
      return Date.UTC(prevYear, prevMonth - 1, 20, 12);
    case 'products':
      return Date.UTC(prevYear, prevMonth - 1, 25, 12);
    case 'metal':
    case 'rates':
    case 'ags':
      // Liquidity leaves before first notice day, at the end of the prior month.
      return Date.UTC(year, month - 1, 0, 12);
    case 'crypto':
      return lastWeekday(year, month, 5);
    case 'fx':
      return nthWeekday(year, month, 3, 3);
    default:
      // Equity index futures: third Friday of the contract month.
      return nthWeekday(year, month, 5, 3);
  }
}

/** When volume moves to the next contract: about 8 days early for index/FX, 2 otherwise. */
export function rollAt(root, month, year) {
  const kind = ROOT_KIND[root];
  const days = kind === 'index' || kind === 'fx' ? 8 : 2;
  return expiryFor(root, month, year) - days * DAY_MS;
}

export function estimateExpiry(root, name, now = new Date()) {
  const cm = contractMonth(name, now);
  return cm ? expiryFor(root, cm.month, cm.year) : null;
}

/**
 * Front-month resolution for the whitelist plus the market rows the Python
 * adapter turns into ccxt markets.
 */
export class ContractBook {
  constructor(client, lots, { quote = 'USD' } = {}) {
    this.client = client;
    this.lots = lots;
    this.quote = quote;
    this.byRoot = new Map();
    this.byContractId = new Map();
    this.rolls = [];
  }

  async refresh({ force = false } = {}) {
    const rows = await this.client.availableContracts({ force });
    if (!rows.length) return this.byRoot;

    const next = new Map();
    for (const row of rows) {
      const existing = next.get(row.root);
      // Prefer the gateway's own front-month marker; otherwise keep the first.
      if (!existing || (!existing.activeContract && row.activeContract)) next.set(row.root, row);
    }

    for (const [root, row] of next) {
      const previous = this.byRoot.get(root);
      if (previous && previous.contractId !== row.contractId) {
        this.rolls.push({ root, from: previous.contractId, to: row.contractId, at: Date.now() });
        console.warn(`[contracts] ${root} rolled ${previous.contractId} -> ${row.contractId}`);
      }
    }

    for (const row of rows) this.byContractId.set(row.contractId, row);
    this.byRoot = next;
    return this.byRoot;
  }

  front(root) {
    return this.byRoot.get(String(root || '').toUpperCase()) || null;
  }

  /** Any contract id seen, including expired fronts that still hold a position. */
  rootForContract(contractId) {
    const row = this.byContractId.get(contractId);
    if (row) return row.root;
    const parts = String(contractId || '').split('.');
    return parts.length >= 4 ? parts[3] : null;
  }

  contractInfo(contractId) {
    return this.byContractId.get(contractId) || null;
  }

  market(root, now = new Date()) {
    const row = this.front(root);
    if (!row) return null;
    const lot = this.lots.info(root);
    const expiry = estimateExpiry(row.root, row.name, now);
    return {
      symbol: pairOf(row.root, this.quote),
      root: row.root,
      contractId: row.contractId,
      name: row.name,
      description: row.description,
      tickSize: row.tickSize,
      tickValue: row.tickValue,
      // Dollar point value: price is quoted per point, notional = contracts * size * price.
      contractSize: row.tickSize > 0 ? row.tickValue / row.tickSize : 1,
      active: row.activeContract,
      lot,
      expiry,
      daysToExpiry: expiry ? Math.floor((expiry - now.getTime()) / DAY_MS) : null,
    };
  }

  markets(roots, now = new Date()) {
    const wanted = roots?.length ? roots : [...this.byRoot.keys()];
    return wanted.map((r) => this.market(r, now)).filter(Boolean);
  }
}
