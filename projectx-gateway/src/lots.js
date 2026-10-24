/**
 * Mini/micro lot table.
 *
 * Topstep's maximum position size is quoted in minis with micros at 10:1, and it
 * applies across every open position. Exposure is therefore counted in
 * mini-equivalents: a micro weighs 1 / micro_ratio of a mini.
 */
/** Every root on TopstepX's contract list. Groups pair each micro with its full-size contract. */
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
  NKD: { class: 'mini', group: 'Nikkei' },
  // Metals
  GC: { class: 'mini', group: 'Gold' },
  MGC: { class: 'micro', group: 'Gold' },
  SI: { class: 'mini', group: 'Silver' },
  SIL: { class: 'micro', group: 'Silver' },
  HG: { class: 'mini', group: 'Copper' },
  MHG: { class: 'micro', group: 'Copper' },
  PL: { class: 'mini', group: 'Platinum' },
  // Energy
  CL: { class: 'mini', group: 'Crude' },
  QM: { class: 'mini', group: 'Crude' },
  MCL: { class: 'micro', group: 'Crude' },
  NG: { class: 'mini', group: 'NatGas' },
  QG: { class: 'mini', group: 'NatGas' },
  MNG: { class: 'micro', group: 'NatGas' },
  HO: { class: 'mini', group: 'Heating Oil' },
  RB: { class: 'mini', group: 'Gasoline' },
  // Crypto
  MBT: { class: 'micro', group: 'BTC' },
  MET: { class: 'micro', group: 'ETH' },
  // FX
  '6E': { class: 'mini', group: 'EUR' },
  E7: { class: 'mini', group: 'EUR' },
  M6E: { class: 'micro', group: 'EUR' },
  '6B': { class: 'mini', group: 'GBP' },
  M6B: { class: 'micro', group: 'GBP' },
  '6A': { class: 'mini', group: 'AUD' },
  M6A: { class: 'micro', group: 'AUD' },
  '6C': { class: 'mini', group: 'CAD' },
  '6J': { class: 'mini', group: 'JPY' },
  '6M': { class: 'mini', group: 'MXN' },
  '6N': { class: 'mini', group: 'NZD' },
  '6S': { class: 'mini', group: 'CHF' },
  // Rates
  ZT: { class: 'mini', group: '2Y' },
  ZF: { class: 'mini', group: '5Y' },
  ZN: { class: 'mini', group: '10Y' },
  TN: { class: 'mini', group: 'Ultra 10Y' },
  ZB: { class: 'mini', group: '30Y' },
  UB: { class: 'mini', group: 'Ultra Bond' },
  // Agriculture
  ZC: { class: 'mini', group: 'Corn' },
  ZS: { class: 'mini', group: 'Soybeans' },
  ZW: { class: 'mini', group: 'Wheat' },
  ZL: { class: 'mini', group: 'Soybean Oil' },
  ZM: { class: 'mini', group: 'Soybean Meal' },
  HE: { class: 'mini', group: 'Lean Hogs' },
  LE: { class: 'mini', group: 'Live Cattle' },
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
    const base = BUILTIN[key] || { class: key.startsWith('M') ? 'micro' : 'mini', group: key };
    const override = this.overrides[key] || {};
    const cls = override.class || base.class;
    const weight = Number.isFinite(Number(override.weight))
      ? Number(override.weight)
      : (cls === 'micro' ? 1 / this.microRatio : 1);
    return { root: key, class: cls, group: override.group || base.group, weight, known: Boolean(BUILTIN[key]) };
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
