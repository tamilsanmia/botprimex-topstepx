/**
 * Mini/micro lot table.
 *
 * Topstep's maximum position size is quoted in minis with micros at 10:1, and it
 * applies across every open position. Exposure is therefore counted in
 * mini-equivalents: a micro weighs 1 / micro_ratio of a mini.
 */
/**
 * Every root on TopstepX's contract list. Groups pair each micro with its full-size contract.
 *
 * Verified against Topstep's help pages (2026-10): the Combine and Express Funded
 * limit counts minis and micros at 10:1 (help.topstep.com "Trading Combine
 * Parameters"). The page lists no per-product weight, so entries tagged
 * `// unverified` are the standard CME size classes assumed by this table, not
 * something Topstep states. A root missing from this table is NOT guessed: see
 * `info().known`.
 */
const BUILTIN = Object.freeze({
  // Equity index
  ES: { class: 'mini', group: 'S&P' },
  MES: { class: 'micro', group: 'S&P' },
  NQ: { class: 'mini', group: 'Nasdaq' },
  MNQ: { class: 'micro', group: 'Nasdaq' },
  RTY: { class: 'mini', group: 'Russell' },
  M2K: { class: 'micro', group: 'Russell' },
  YM: { class: 'mini', group: 'Dow' },
  MYM: { class: 'micro', group: 'Dow' },
  NKD: { class: 'mini', group: 'Nikkei' }, // unverified
  // Metals
  GC: { class: 'mini', group: 'Gold' },
  MGC: { class: 'micro', group: 'Gold' },
  SI: { class: 'mini', group: 'Silver' }, // unverified
  SIL: { class: 'micro', group: 'Silver' }, // unverified
  HG: { class: 'mini', group: 'Copper' }, // unverified
  MHG: { class: 'micro', group: 'Copper' }, // unverified
  PL: { class: 'mini', group: 'Platinum' }, // unverified
  // Energy
  CL: { class: 'mini', group: 'Crude' },
  QM: { class: 'mini', group: 'Crude' }, // unverified
  MCL: { class: 'micro', group: 'Crude' },
  NG: { class: 'mini', group: 'NatGas' }, // unverified
  QG: { class: 'mini', group: 'NatGas' }, // unverified
  MNG: { class: 'micro', group: 'NatGas' }, // unverified
  HO: { class: 'mini', group: 'Heating Oil' }, // unverified
  RB: { class: 'mini', group: 'Gasoline' }, // unverified
  // Crypto
  MBT: { class: 'micro', group: 'BTC' }, // unverified
  MET: { class: 'micro', group: 'ETH' }, // unverified
  // FX
  '6E': { class: 'mini', group: 'EUR' }, // unverified
  E7: { class: 'mini', group: 'EUR' }, // unverified
  M6E: { class: 'micro', group: 'EUR' }, // unverified
  '6B': { class: 'mini', group: 'GBP' }, // unverified
  M6B: { class: 'micro', group: 'GBP' }, // unverified
  '6A': { class: 'mini', group: 'AUD' }, // unverified
  M6A: { class: 'micro', group: 'AUD' }, // unverified
  '6C': { class: 'mini', group: 'CAD' }, // unverified
  '6J': { class: 'mini', group: 'JPY' }, // unverified
  '6M': { class: 'mini', group: 'MXN' }, // unverified
  '6N': { class: 'mini', group: 'NZD' }, // unverified
  '6S': { class: 'mini', group: 'CHF' }, // unverified
  // Rates
  ZT: { class: 'mini', group: '2Y' }, // unverified
  ZF: { class: 'mini', group: '5Y' }, // unverified
  ZN: { class: 'mini', group: '10Y' }, // unverified
  TN: { class: 'mini', group: 'Ultra 10Y' }, // unverified
  ZB: { class: 'mini', group: '30Y' }, // unverified
  UB: { class: 'mini', group: 'Ultra Bond' }, // unverified
  // Agriculture
  ZC: { class: 'mini', group: 'Corn' }, // unverified
  ZS: { class: 'mini', group: 'Soybeans' }, // unverified
  ZW: { class: 'mini', group: 'Wheat' }, // unverified
  ZL: { class: 'mini', group: 'Soybean Oil' }, // unverified
  ZM: { class: 'mini', group: 'Soybean Meal' }, // unverified
  HE: { class: 'mini', group: 'Lean Hogs' }, // unverified
  LE: { class: 'mini', group: 'Live Cattle' }, // unverified
});

export class LotTable {
  constructor({ micro_ratio = 10, block_mini_micro_overlap = true, overrides = {} } = {}) {
    if (!(Number(micro_ratio) > 0)) throw new Error('topstep.lots.micro_ratio must be > 0');
    this.microRatio = Number(micro_ratio);
    this.blockOverlap = block_mini_micro_overlap !== false;
    this.overrides = overrides || {};
  }

  info(root) {
    const key = String(root || '').toUpperCase();
    // An unknown root is not guessed from its name: it weighs a full mini (the
    // most cautious reading) and is flagged `known: false` so entries are refused.
    const base = BUILTIN[key] || { class: 'mini', group: key };
    const override = this.overrides[key] || {};
    const cls = override.class || base.class;
    const weight = Number.isFinite(Number(override.weight))
      ? Number(override.weight)
      : (cls === 'micro' ? 1 / this.microRatio : 1);
    return { root: key, class: cls, group: override.group || base.group, weight, known: Boolean(BUILTIN[key]) || override.class !== undefined || override.weight !== undefined };
  }

  /**
   * Mini-equivalent exposure of a set of legs: [{ root, contracts }]. Contracts are
   * absolute; direction does not offset, because Topstep counts gross size.
   */
  exposure(legs) {
    let total = 0;
    for (const leg of legs) total += Math.abs(Number(leg.contracts) || 0) * this.info(leg.root).weight;
    return Math.round(total * 1e6) / 1e6;
  }

  /** Root of the other lot size in the same group already held, if overlap is blocked. */
  overlapConflict(root, heldRoots) {
    if (!this.blockOverlap) return null;
    const mine = this.info(root);
    for (const other of heldRoots) {
      if (other === mine.root) continue;
      if (this.info(other).group === mine.group) return other;
    }
    return null;
  }

  /** Whole contracts of `root` that still fit under `maxMini`. */
  contractsThatFit(root, maxMini, legs) {
    const room = maxMini - this.exposure(legs);
    if (room <= 0) return 0;
    return Math.floor((room + 1e-9) / this.info(root).weight);
  }
}
