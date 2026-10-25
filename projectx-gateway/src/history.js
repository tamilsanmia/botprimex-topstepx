import { MONTH_CODES, cycleFor, rollAt } from './contracts.js';
import { BAR_UNIT, contractMonth } from './projectx.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CHAIN = 60;

function previousInCycle(root, month, year) {
  const cycle = cycleFor(root);
  let m = month;
  let y = year;
  for (let i = 0; i < 12; i += 1) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
    if (cycle.includes(MONTH_CODES[m - 1])) return { month: m, year: y };
  }
  return { month: month === 1 ? 12 : month - 1, year: month === 1 ? year - 1 : year };
}

function contractIdFor(stem, month, year) {
  return `${stem}.${MONTH_CODES[month - 1]}${String(year % 100).padStart(2, '0')}`;
}

/**
 * The front-month contracts covering [start, end), oldest first, as
 * [{ contractId, month, year, from, to }]. Built backwards from the gateway's
 * current front along the root's listing cycle and roll schedule. ProjectX keeps
 * about a year of bars, so the chain stops at `retentionDays`.
 */
export function contractChain(front, { root, start, end, now = Date.now(), retentionDays = 400 }) {
  const parts = String(front.contractId).split('.');
  const cm = contractMonth(front.name, new Date(now));
  if (parts.length < 5 || !cm) return [{ contractId: front.contractId, from: -Infinity, to: Infinity }];

  const stem = parts.slice(0, 4).join('.');
  const oldest = Math.max(start, now - retentionDays * DAY_MS);
  const chain = [];
  let cur = { ...cm, contractId: front.contractId };
  let to = Infinity;

  for (let i = 0; i < MAX_CHAIN; i += 1) {
    const prev = previousInCycle(root, cur.month, cur.year);
    let from = rollAt(root, prev.month, prev.year);
    // The gateway's front is authoritative for "now", even if it rolled early.
    if (i === 0) from = Math.min(from, now);
    chain.unshift({ contractId: cur.contractId, month: cur.month, year: cur.year, from, to });
    if (from <= oldest) break;
    to = from;
    cur = { ...prev, contractId: contractIdFor(stem, prev.month, prev.year) };
  }
  return chain.filter((seg) => seg.to > start && seg.from < end);
}

/**
 * Continuous history across contract rolls.
 *
 * Each segment of a window is fetched from the contract that was front at the
 * time. With `adjust: "back"` (default), older contracts are shifted by the price
 * gap at each roll, so the series has no artificial jumps and the latest prices
 * equal the live contract's; P&L in points is unchanged. `adjust: "none"` stitches
 * raw prices.
 */
export class ContinuousHistory {
  /**
   * ProjectX keeps second bars for about 2-3 weeks, minute bars for about 60 days
   * and hour/day bars for about a year (measured). Requests are clamped to those
   * windows so asking for older data costs nothing and returns nothing.
   */
  constructor({ client, contracts, enabled = true, adjust = 'back', retentionDays = 400, minuteRetentionDays = 61, secondRetentionDays = 15, now = () => Date.now() }) {
    this.client = client;
    this.contracts = contracts;
    this.enabled = enabled;
    this.adjust = adjust;
    this.retention = {
      [BAR_UNIT.SECOND]: secondRetentionDays,
      [BAR_UNIT.MINUTE]: minuteRetentionDays,
    };
    this.retentionDays = retentionDays;
    this.now = now;
    this.diffs = new Map();
  }

  retentionFor(unit) {
    return this.retention[unit] ?? this.retentionDays;
  }

  async fetch({ root, spec, startTime: requestedStart, endTime, limit, priority }) {
    const front = this.contracts.front(root);
    const retentionDays = this.retentionFor(spec.unit);
    const startTime = Math.max(requestedStart, this.now() - retentionDays * DAY_MS);
    if (startTime >= endTime) return [];
    const single = () => this.client.retrieveBars({
      contractId: front.contractId, unit: spec.unit, unitNumber: spec.unitNumber, startTime, endTime, limit, priority,
    });
    if (!this.enabled) return single();

    const chain = contractChain(front, { root, start: startTime, end: endTime, now: this.now(), retentionDays });
    if (chain.length <= 1) return single();

    const pieces = [];
    for (const seg of chain) {
      const s = Math.max(startTime, seg.from);
      const e = Math.min(endTime, seg.to);
      if (s >= e) continue;
      let bars = [];
      try {
        bars = await this.client.retrieveBars({
          contractId: seg.contractId, unit: spec.unit, unitNumber: spec.unitNumber, startTime: s, endTime: e, limit, priority,
        });
      } catch (err) {
        console.warn(`[history] ${seg.contractId} unavailable (${err.message}); leaving a gap`);
      }
      pieces.push({ seg, bars: bars.filter((b) => b[0] >= seg.from && b[0] < seg.to) });
    }

    if (this.adjust === 'back') {
      let offset = 0;
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        const seg = chain[i];
        const piece = pieces.find((p) => p.seg === seg);
        if (piece && offset !== 0) {
          for (const b of piece.bars) {
            for (let k = 1; k <= 4; k += 1) b[k] = Math.round((b[k] + offset) * 1e9) / 1e9;
          }
        }
        if (i > 0) offset += await this.rollDiff(chain[i - 1], seg, priority);
      }
    }

    return pieces.flatMap((p) => p.bars).sort((a, b) => a[0] - b[0]);
  }

  /** Newer minus older close at the roll, from hourly bars just before it. Cached. */
  async rollDiff(older, newer, priority) {
    const key = `${older.contractId}>${newer.contractId}`;
    if (this.diffs.has(key)) return this.diffs.get(key);
    const at = newer.from;
    const window = { unit: BAR_UNIT.HOUR, unitNumber: 1, startTime: at - 5 * DAY_MS, endTime: at, limit: 200, priority };
    let diff = 0;
    try {
      const [a, b] = await Promise.all([
        this.client.retrieveBars({ contractId: older.contractId, ...window }),
        this.client.retrieveBars({ contractId: newer.contractId, ...window }),
      ]);
      const newerByTs = new Map(b.map((bar) => [bar[0], bar[4]]));
      const common = a.filter((bar) => newerByTs.has(bar[0])).at(-1);
      if (common) diff = newerByTs.get(common[0]) - common[4];
      else if (a.length && b.length) diff = b.at(-1)[4] - a.at(-1)[4];
    } catch (err) {
      console.warn(`[history] roll gap ${key} unavailable (${err.message}); not adjusting`);
    }
    diff = Math.round(diff * 1e9) / 1e9;
    this.diffs.set(key, diff);
    console.log(`[history] roll ${key} at ${new Date(at).toISOString().slice(0, 10)}: back-adjust ${diff}`);
    return diff;
  }
}
