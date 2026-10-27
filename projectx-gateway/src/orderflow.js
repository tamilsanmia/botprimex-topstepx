import { GatewayError } from './errors.js';
import { bucketStart, timeframe } from './timeframes.js';

const EMA_ALPHA = 0.005;
const BLOCK_WARMUP = 200;
const MAX_FEATURE_CANDLES = 5000;

/**
 * Value area around the point of control: grow from the POC toward whichever
 * neighbour has more volume until `pct` of the session's volume is inside.
 */
export function valueArea(profile, pct = 70) {
  if (!profile.size) return { poc: null, vah: null, val: null };
  const levels = [...profile.entries()].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let pocIdx = 0;
  for (let i = 0; i < levels.length; i += 1) {
    total += levels[i][1];
    if (levels[i][1] > levels[pocIdx][1]) pocIdx = i;
  }
  const target = total * (pct / 100);
  let lo = pocIdx;
  let hi = pocIdx;
  let inside = levels[pocIdx][1];
  while (inside < target && (lo > 0 || hi < levels.length - 1)) {
    const down = lo > 0 ? levels[lo - 1][1] : -1;
    const up = hi < levels.length - 1 ? levels[hi + 1][1] : -1;
    if (up >= down) {
      hi += 1;
      inside += up;
    } else {
      lo -= 1;
      inside += down;
    }
  }
  return { poc: levels[pocIdx][0], vah: levels[hi][0], val: levels[lo][0] };
}

/**
 * Per-candle order flow features Freqtrade's own orderflow does not compute:
 *   cvd_session    cumulative (buy - sell) volume, reset at each session start
 *   delta          buy - sell volume in the candle
 *   block_count    prints >= block_multiple x the running average print size
 *   block_volume   volume of those prints, signed (+buy / -sell) in block_delta
 *   poc/vah/val    session volume profile from recorded ticks, as of candle close
 *   bid/ask/spread best bid/ask at candle close (1 Hz snapshots)
 *
 * O(session ticks) per call; production uses FeatureEngine, and this stays as the reference its parity tests compare against.
 */
export function computeFeatures({ ticks, tfMs, since, clock, blockMultiple = 25, valueAreaPct = 70, quoteAt = null }) {
  const rows = [];
  const byTs = new Map();
  let sessionStart = null;
  let cvd = 0;
  let profile = new Map();
  let avgSize = 0;
  let seen = 0;
  const profileStepMs = Math.max(tfMs, 60_000);
  let lastProfileAt = -Infinity;
  let lastVA = { poc: null, vah: null, val: null };

  const close = (row) => {
    if (row.ts + tfMs - lastProfileAt >= profileStepMs) {
      lastVA = valueArea(profile, valueAreaPct);
      lastProfileAt = row.ts + tfMs;
    }
    Object.assign(row, lastVA, { cvd_session: cvd });
    if (quoteAt) {
      const q = quoteAt(row.ts + tfMs - 1);
      if (q) Object.assign(row, { bid: q.bid, ask: q.ask, spread: q.ask - q.bid });
    }
  };

  let current = null;
  for (const [ts, price, size, side] of ticks) {
    const bucket = bucketStart(ts, tfMs);
    const newCandle = !current || current.ts !== bucket;
    // Close the previous candle before a session reset clears the running totals.
    if (newCandle && current) close(current);

    const start = clock.sessionStart(ts);
    if (start !== sessionStart) {
      sessionStart = start;
      cvd = 0;
      profile = new Map();
      lastProfileAt = -Infinity;
    }

    if (newCandle) {
      current = byTs.get(bucket);
      if (!current) {
        current = { ts: bucket, delta: 0, buy_volume: 0, sell_volume: 0, block_count: 0, block_volume: 0, block_delta: 0 };
        byTs.set(bucket, current);
        rows.push(current);
      }
    }

    const signed = side === 0 ? size : -size;
    cvd += signed;
    current.delta += signed;
    if (side === 0) current.buy_volume += size;
    else current.sell_volume += size;
    profile.set(price, (profile.get(price) || 0) + size);

    seen += 1;
    if (seen > BLOCK_WARMUP && size >= avgSize * blockMultiple) {
      current.block_count += 1;
      current.block_volume += size;
      current.block_delta += signed;
    }
    avgSize = avgSize > 0 ? avgSize + EMA_ALPHA * (size - avgSize) : size;
  }
  if (current) close(current);

  return rows.filter((r) => r.ts >= since).slice(-MAX_FEATURE_CANDLES);
}

const NO_VALUE_AREA = Object.freeze({ poc: null, vah: null, val: null });

/**
 * computeFeatures as a stream: push() is the reference loop body, step for step
 * and in the same order, so view() returns exactly what computeFeatures returns
 * for the ticks pushed so far. Ticks must arrive in (ts, seq) order.
 *
 * Differences that do not change the output:
 * - the session start is looked up only when a tick leaves the cached trading day;
 * - a candle is closed for good when the next candle opens; view() closes a copy
 *   of the open candle without touching the running state;
 * - the value area is memoised per profile version, so repeated views between
 *   ticks sort the price levels once;
 * - only the newest MAX_FEATURE_CANDLES closed candles are kept, which is all the
 *   reference can ever return.
 */
export class FeatureEngine {
  constructor({ tfMs, clock, blockMultiple = 25, valueAreaPct = 70, quoteAt = null, coverStart = null }) {
    this.tfMs = tfMs;
    this.clock = clock;
    this.blockMultiple = blockMultiple;
    this.valueAreaPct = valueAreaPct;
    this.quoteAt = quoteAt;
    this.profileStepMs = Math.max(tfMs, 60_000);
    // First tick time this engine has seen everything from, and the (ts, seq) of the last tick pushed.
    this.coverStart = coverStart;
    this.cursorTs = coverStart ?? -Infinity;
    this.cursorSeq = -1;

    this.rows = [];
    this.current = null;
    this.sessionStart = null;
    this.dayStart = null;
    this.dayEnd = null;
    this.cvd = 0;
    this.profile = new Map();
    this.profileVersion = 0;
    this.memo = { version: -1, va: NO_VALUE_AREA };
    this.avgSize = 0;
    this.seen = 0;
    this.lastProfileAt = -Infinity;
    this.lastVA = NO_VALUE_AREA;
  }

  get committedCount() {
    return this.rows.length;
  }

  /** clock.sessionStart(ts), recomputed only when ts leaves the cached trading day. */
  sessionOf(ts) {
    if (this.dayStart === null || ts < this.dayStart || ts >= this.dayEnd) {
      const day = this.clock.tradingDay(ts);
      this.dayStart = day.start;
      this.dayEnd = day.end;
    }
    return this.dayStart;
  }

  valueArea() {
    if (this.memo.version !== this.profileVersion) {
      this.memo = { version: this.profileVersion, va: valueArea(this.profile, this.valueAreaPct) };
    }
    return this.memo.va;
  }

  /** The reference's close(); with `commit` false the running VA step is left as it was. */
  close(row, commit) {
    let va = this.lastVA;
    if (row.ts + this.tfMs - this.lastProfileAt >= this.profileStepMs) {
      va = this.valueArea();
      if (commit) {
        this.lastVA = va;
        this.lastProfileAt = row.ts + this.tfMs;
      }
    }
    Object.assign(row, va, { cvd_session: this.cvd });
    if (this.quoteAt) {
      const q = this.quoteAt(row.ts + this.tfMs - 1);
      if (q) Object.assign(row, { bid: q.bid, ask: q.ask, spread: q.ask - q.bid });
    }
  }

  push(ts, price, size, side) {
    const bucket = bucketStart(ts, this.tfMs);
    const newCandle = !this.current || this.current.ts !== bucket;
    // Close the previous candle before a session reset clears the running totals.
    if (newCandle && this.current) {
      this.close(this.current, true);
      this.rows.push(this.current);
      if (this.rows.length > 2 * MAX_FEATURE_CANDLES) this.rows.splice(0, this.rows.length - MAX_FEATURE_CANDLES);
    }

    const start = this.sessionOf(ts);
    if (start !== this.sessionStart) {
      this.sessionStart = start;
      this.cvd = 0;
      this.profile = new Map();
      this.profileVersion += 1;
      this.lastProfileAt = -Infinity;
    }

    if (newCandle) {
      this.current = { ts: bucket, delta: 0, buy_volume: 0, sell_volume: 0, block_count: 0, block_volume: 0, block_delta: 0 };
    }
    const current = this.current;

    const signed = side === 0 ? size : -size;
    this.cvd += signed;
    current.delta += signed;
    if (side === 0) current.buy_volume += size;
    else current.sell_volume += size;
    this.profile.set(price, (this.profile.get(price) || 0) + size);
    this.profileVersion += 1;

    this.seen += 1;
    if (this.seen > BLOCK_WARMUP && size >= this.avgSize * this.blockMultiple) {
      current.block_count += 1;
      current.block_volume += size;
      current.block_delta += signed;
    }
    this.avgSize = this.avgSize > 0 ? this.avgSize + EMA_ALPHA * (size - this.avgSize) : size;
  }

  /** What computeFeatures returns for `since` over the ticks pushed so far. Closed rows are shared, not copied. */
  view(since) {
    const rows = this.rows;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (rows[mid].ts < since) lo = mid + 1;
      else hi = mid;
    }
    const out = rows.slice(Math.max(lo, rows.length - MAX_FEATURE_CANDLES));
    if (this.current && this.current.ts >= since) {
      const open = { ...this.current };
      this.close(open, false);
      out.push(open);
    }
    return out.length > MAX_FEATURE_CANDLES ? out.slice(-MAX_FEATURE_CANDLES) : out;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LOADING = Symbol('loading');
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Order flow features served from one FeatureEngine per (root, timeframe, session
 * the request starts in). The reference replays ticks from sessionStart(from), and
 * its block-size average and warm-up depend on that start, so requests that start in
 * different sessions get different engines; every answer equals computeFeatures
 * over ticks(root, sessionStart(from), now).
 *
 * An engine keeps a (ts, seq) cursor into the tick store and catches up by reading
 * the rows after it in pages, so seeding and live updates are one loop and the input
 * order is the reference's. The loop yields to the event loop every `sliceMs`. First
 * fills of different engines interleave, so a quiet pair is ready in milliseconds
 * while a busy one (MNQ: about 1.7M prints a session) is still replaying. A request
 * waits at most `waitMs` for its engine and otherwise gets a 503 while the replay
 * goes on; a warm request reads the new prints and copies the open candle.
 *
 * Trade-off: a print that reaches SQLite after a later-keyed print of the same root
 * was already read (more than one flush out of order) is behind the cursor and not
 * counted, where the old full replay would have counted it on the next request.
 * Prints of one root arrive almost in order, so this is rare and small.
 *
 * While a request's session is not the current one, the engine for the next session
 * is kept current too, so moving into it does not start a cold replay.
 */
export class OrderflowService {
  constructor({
    tickStore, clock, blockMultiple = 25, valueAreaPct = 70, now = () => Date.now(),
    waitMs = 2000, maxEngines = 64, idleMs = 30 * 60_000, sliceMs = 5, chunkRows = 250,
  }) {
    this.tickStore = tickStore;
    this.clock = clock;
    this.blockMultiple = blockMultiple;
    this.valueAreaPct = valueAreaPct;
    this.now = now;
    this.waitMs = waitMs;
    this.maxEngines = maxEngines;
    this.idleMs = idleMs;
    this.sliceMs = sliceMs;
    this.chunkRows = chunkRows;
    // Map order is least recently used first.
    this.entries = new Map();
    // Replays waiting for their next page, served in turn by pump().
    this.jobs = [];
    this.pumping = false;
  }

  async features(root, tf, since, until) {
    // A caller that names `until` asks about a fixed moment: a one-off replay.
    if (until !== undefined) return this.compute(root, tf, since, until);

    const now = this.now();
    const tfMs = timeframe(tf).ms;
    const from = since ?? now - 500 * tfMs;
    const seedStart = this.clock.sessionStart(from);
    const entry = this.entryFor(root, tf, tfMs, seedStart, now);
    const next = this.clock.tradingDay(seedStart).end;
    if (next <= this.clock.sessionStart(now)) this.catchUp(this.entryFor(root, tf, tfMs, next, now));
    const ready = this.ready(entry, now);
    this.evict(now);
    await ready;
    return entry.engine.view(from);
  }

  newEntry(root, tf, tfMs, seedStart) {
    const engine = new FeatureEngine({
      tfMs,
      clock: this.clock,
      blockMultiple: this.blockMultiple,
      valueAreaPct: this.valueAreaPct,
      quoteAt: (ts) => this.tickStore.quoteAt(root, ts),
      coverStart: seedStart,
    });
    return { root, tf, engine, running: null, seeded: false, readUntil: -Infinity, replayed: 0, lastUsed: 0 };
  }

  entryFor(root, tf, tfMs, seedStart, now) {
    const key = `${root}|${tf}|${seedStart}`;
    let entry = this.entries.get(key);
    if (entry) this.entries.delete(key);
    else entry = this.newEntry(root, tf, tfMs, seedStart);
    entry.lastUsed = now;
    this.entries.set(key, entry);
    return entry;
  }

  /** Resolves once the engine has read every print before `now`; a 503 after waitMs. */
  async ready(entry, now) {
    const work = (async () => {
      while (entry.readUntil < now) {
        const err = await this.catchUp(entry);
        if (err) throw err;
      }
    })();
    work.catch(() => {});
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, this.waitMs, LOADING);
    });
    try {
      if ((await Promise.race([work, timeout])) === LOADING) {
        throw new GatewayError(
          `Order flow for ${entry.root} ${entry.tf} is still loading (${entry.replayed} prints replayed); retry shortly`,
          { status: 503, kind: 'ExchangeNotAvailable' },
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Starts or joins the entry's single catch-up. Resolves to the error it failed with, or null. */
  catchUp(entry) {
    if (!entry.running) {
      entry.running = this.replay(entry).then(() => null, (err) => err).finally(() => {
        entry.running = null;
      });
    }
    return entry.running;
  }

  /** Resolves once every print after the engine's cursor and before `until` is pushed. */
  replay(entry, until = this.now()) {
    return new Promise((resolve, reject) => {
      const dayStart = Math.floor(entry.engine.cursorTs / DAY_MS) * DAY_MS;
      this.jobs.push({ entry, until, dayStart, resolve, reject });
      if (!this.pumping) this.pump();
    });
  }

  /**
   * One loop runs every replay, a page at a time in turn, and yields to the event
   * loop when `sliceMs` is used up. Separate loops would each take a slice in the
   * same event-loop turn, so N replays would hold the loop N times as long.
   */
  async pump() {
    this.pumping = true;
    let sliceStart = performance.now();
    try {
      while (this.jobs.length) {
        const job = this.jobs.shift();
        try {
          // Opens a gzipped day with a streaming gunzip, so db() never runs gunzipSync for it.
          await this.tickStore.prepareDays(job.dayStart, job.dayStart);
          if (this.step(job)) job.resolve();
          else this.jobs.push(job);
        } catch (err) {
          job.reject(err);
        }
        if (this.jobs.length && performance.now() - sliceStart >= this.sliceMs) {
          await yieldTurn();
          sliceStart = performance.now();
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Reads and pushes one page, bounded to one UTC day. True when the job reached `until`. */
  step(job) {
    const { entry, until } = job;
    const { engine } = entry;
    const dayEnd = job.dayStart + DAY_MS;
    const before = engine.cursorTs < job.dayStart;
    const rows = this.tickStore.ticksAfter(
      entry.root, before ? job.dayStart : engine.cursorTs, before ? -1 : engine.cursorSeq, Math.min(until, dayEnd), this.chunkRows,
    );
    for (const r of rows) engine.push(r[0], r[1], r[2], r[3]);
    if (rows.length) {
      const last = rows[rows.length - 1];
      engine.cursorTs = last[0];
      engine.cursorSeq = last[4];
      entry.replayed += rows.length;
    }
    if (rows.length === this.chunkRows) return false;
    if (dayEnd < until) {
      job.dayStart = dayEnd;
      return false;
    }
    entry.readUntil = Math.max(entry.readUntil, until);
    entry.seeded = true;
    return true;
  }

  /** Drops entries idle for idleMs, then the least recently used over maxEngines; never one that is replaying. */
  evict(now) {
    for (const [key, entry] of this.entries) {
      if (entry.running) continue;
      if (now - entry.lastUsed > this.idleMs || this.entries.size > this.maxEngines) this.entries.delete(key);
    }
  }

  /** One-off answer as of `until`, from a fresh engine that is not kept. */
  async compute(root, tf, since, until = this.now()) {
    const tfMs = timeframe(tf).ms;
    const from = since ?? until - 500 * tfMs;
    const entry = this.newEntry(root, tf, tfMs, this.clock.sessionStart(from));
    await this.replay(entry, until);
    return entry.engine.view(from);
  }
}
