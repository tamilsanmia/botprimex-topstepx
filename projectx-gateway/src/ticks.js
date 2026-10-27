import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip, gunzipSync } from 'node:zlib';
import os from 'node:os';

import Database from 'better-sqlite3';

const DAY_MS = 24 * 60 * 60 * 1000;
const FLUSH_MS = 500;
const COMPRESS_AFTER_DAYS = 2;
const OPEN_CACHE = 4;
// Rows written per event-loop turn by flushAsync, so a burst never stalls the loop for long.
const FLUSH_CHUNK = 2000;
// Per root: how many recent distinct millisecond timestamps keep their print counter.
const SEQ_WINDOW = 512;

const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);
const tableName = (prefix, root) => `${prefix}_${String(root).replace(/[^A-Z0-9]/gi, '_').toUpperCase()}`;

/**
 * Tick recorder.
 *
 * ProjectX has no historical tick endpoint and its bars carry no buy/sell split,
 * so order flow history only exists if it is recorded. Every GatewayTrade is kept
 * with its aggressor side in one SQLite file per UTC day (a table per contract
 * root), plus a 1 Hz bid/ask snapshot for spread at candle close.
 *
 * Days older than COMPRESS_AFTER_DAYS are gzipped; reading one decompresses it
 * into a temp file kept in a small LRU (synchronously in db(), or as a stream
 * through prepareDays() for readers that can wait).
 */
export class TickStore {
  constructor({ dir, retentionDays = 30, enabled = true }) {
    this.dir = dir;
    this.retentionDays = retentionDays;
    this.enabled = enabled;
    this.open = new Map();
    this.pending = [];
    this.pendingQuotes = [];
    this.seqByRoot = new Map();
    this.flushing = null;
    this.maintaining = null;
    this.preparing = new Map();
    this.tempSeq = 0;
    this.closed = false;
    this.lastQuoteSec = new Map();
    this.stats = { written: 0, lastFlushMs: 0 };
    if (enabled) mkdirSync(dir, { recursive: true });
    this.timer = setInterval(() => this.flushAsync().catch((err) => console.warn(`[ticks] flush failed: ${err.message}`)), FLUSH_MS);
    this.timer.unref?.();
    this.maintenance = setInterval(() => this.maintain().catch((err) => console.warn(`[ticks] maintenance failed: ${err.message}`)), 60 * 60 * 1000);
    this.maintenance.unref?.();
  }

  filePath(day) {
    return path.join(this.dir, `${day}.sqlite`);
  }

  db(day, { create = false } = {}) {
    if (this.open.has(day)) {
      const entry = this.open.get(day);
      this.open.delete(day);
      this.open.set(day, entry);
      return entry.db;
    }

    let file = this.filePath(day);
    let temp = null;
    if (!existsSync(file)) {
      const gz = `${file}.gz`;
      if (existsSync(gz)) {
        temp = path.join(os.tmpdir(), `ticks-${process.pid}-${day}.sqlite`);
        writeFileSync(temp, gunzipSync(readFileSync(gz)));
        file = temp;
      } else if (!create) {
        return null;
      }
    }
    return this.register(day, file, temp);
  }

  /**
   * Opens `file` as the connection for `day` and evicts the least recently used
   * days over OPEN_CACHE. Prepared statements live in the entry, so they are
   * closed with the connection.
   */
  register(day, file, temp) {
    const db = new Database(file, { readonly: Boolean(temp) });
    if (!temp) {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
    }
    this.open.set(day, { db, temp, tables: new Set(), stmts: new Map(), known: new Set() });
    while (this.open.size > OPEN_CACHE) {
      const [oldest, entry] = this.open.entries().next().value;
      if (oldest === utcDay(Date.now())) {
        this.open.delete(oldest);
        this.open.set(oldest, entry);
        if (this.open.size <= OPEN_CACHE + 1) break;
        continue;
      }
      entry.db.close();
      if (entry.temp) rmSync(entry.temp, { force: true });
      this.open.delete(oldest);
    }
    return db;
  }

  ensureTables(day, root) {
    const db = this.db(day, { create: true });
    const entry = this.open.get(day);
    if (!entry.tables.has(root)) {
      const t = tableName('ticks', root);
      const q = tableName('quotes', root);
      db.exec(`CREATE TABLE IF NOT EXISTS ${t} (ts INTEGER NOT NULL, seq INTEGER NOT NULL, price REAL NOT NULL, size REAL NOT NULL, side INTEGER NOT NULL, PRIMARY KEY (ts, seq)) WITHOUT ROWID`);
      db.exec(`CREATE TABLE IF NOT EXISTS ${q} (ts INTEGER PRIMARY KEY, bid REAL, ask REAL) WITHOUT ROWID`);
      entry.tables.add(root);
    }
    return db;
  }

  /**
   * Sequence number of a print within its millisecond. Prints of one root arrive
   * almost in order, so a counter per recent timestamp is enough, and unlike a
   * global map that gets cleared when it fills up it never forgets a millisecond
   * that is still receiving prints. (ts, seq) is the primary key, so a repeated seq
   * would silently drop the print.
   */
  nextSeq(root, ts) {
    let counters = this.seqByRoot.get(root);
    if (!counters) {
      counters = new Map();
      this.seqByRoot.set(root, counters);
    }
    const seq = counters.get(ts) ?? 0;
    // Re-insert so the Map's order is "least recently seen first".
    counters.delete(ts);
    counters.set(ts, seq + 1);
    if (counters.size > SEQ_WINDOW * 2) {
      for (const key of counters.keys()) {
        if (counters.size <= SEQ_WINDOW) break;
        counters.delete(key);
      }
    }
    return seq;
  }

  record(root, tick) {
    if (!this.enabled) return;
    const seq = this.nextSeq(root, tick.ts);
    this.pending.push([root, tick.ts, seq, tick.price, tick.size, tick.side === 'buy' ? 0 : 1]);
  }

  recordQuote(root, ts, bid, ask) {
    if (!this.enabled || !(bid > 0) || !(ask > 0)) return;
    const sec = Math.floor(ts / 1000);
    if (this.lastQuoteSec.get(root) === sec) return;
    this.lastQuoteSec.set(root, sec);
    this.pendingQuotes.push([root, sec * 1000, bid, ask]);
  }

  /** Writes everything pending now. Used by reads (so they see fresh rows) and at close. */
  flush() {
    if (!this.pending.length && !this.pendingQuotes.length) return;
    const ticks = this.pending;
    const quotes = this.pendingQuotes;
    this.pending = [];
    this.pendingQuotes = [];
    this.writeRows(ticks, quotes);
  }

  /**
   * The timer's flush: writes at most FLUSH_CHUNK rows per event-loop turn. Rows
   * not yet written stay in `pending`, so a read that calls flush() meanwhile still
   * sees and writes them. Calls while a flush is running join it.
   */
  flushAsync() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        while (!this.closed && (this.pending.length || this.pendingQuotes.length)) {
          this.writeRows(this.pending.splice(0, FLUSH_CHUNK), this.pendingQuotes.splice(0, FLUSH_CHUNK));
          if (this.pending.length || this.pendingQuotes.length) await new Promise((resolve) => setImmediate(resolve));
        }
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  writeRows(ticks, quotes) {
    if (!ticks.length && !quotes.length) return;
    const started = performance.now();

    const byDay = new Map();
    for (const row of ticks) {
      const day = utcDay(row[1]);
      if (!byDay.has(day)) byDay.set(day, { ticks: [], quotes: [] });
      byDay.get(day).ticks.push(row);
    }
    for (const row of quotes) {
      const day = utcDay(row[1]);
      if (!byDay.has(day)) byDay.set(day, { ticks: [], quotes: [] });
      byDay.get(day).quotes.push(row);
    }

    for (const [day, rows] of byDay) {
      try {
        const roots = new Set([...rows.ticks.map((r) => r[0]), ...rows.quotes.map((r) => r[0])]);
        let db;
        for (const root of roots) db = this.ensureTables(day, root);
        const tickStmt = new Map();
        const quoteStmt = new Map();
        for (const root of roots) {
          tickStmt.set(root, db.prepare(`INSERT OR IGNORE INTO ${tableName('ticks', root)} VALUES (?, ?, ?, ?, ?)`));
          quoteStmt.set(root, db.prepare(`INSERT OR REPLACE INTO ${tableName('quotes', root)} VALUES (?, ?, ?)`));
        }
        const tx = db.transaction(() => {
          for (const [root, ts, seq, price, size, side] of rows.ticks) tickStmt.get(root).run(ts, seq, price, size, side);
          for (const [root, ts, bid, ask] of rows.quotes) quoteStmt.get(root).run(ts, bid, ask);
        });
        tx();
        this.stats.written += rows.ticks.length;
      } catch (err) {
        console.warn(`[ticks] flush ${day} failed: ${err.message}`);
      }
    }
    this.stats.lastFlushMs = performance.now() - started;
  }

  days(since, until) {
    const out = [];
    for (let t = Date.parse(utcDay(since)); t <= until; t += DAY_MS) out.push(utcDay(t));
    return out;
  }

  /**
   * Ticks in [since, until), oldest first, as [ts, price, size, side(0 buy / 1 sell)].
   */
  ticks(root, since, until = Date.now(), limit = Infinity) {
    this.flush();
    const out = [];
    for (const day of this.days(since, until)) {
      const db = this.db(day);
      if (!db) continue;
      const t = tableName('ticks', root);
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (!exists) continue;
      const remaining = limit === Infinity ? -1 : limit - out.length;
      const rows = db.prepare(`SELECT ts, price, size, side, seq FROM ${t} WHERE ts >= ? AND ts < ? ORDER BY ts, seq LIMIT ?`)
        .raw()
        .all(since, until, remaining);
      for (const r of rows) out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Open entry of `day` (opening it like db() does), or null when the day has no file. */
  entry(day) {
    return this.db(day) ? this.open.get(day) : null;
  }

  /** Prepared statement cached on the day's connection. */
  statement(entry, sql, raw = false) {
    let stmt = entry.stmts.get(sql);
    if (!stmt) {
      stmt = entry.db.prepare(sql);
      if (raw) stmt.raw();
      entry.stmts.set(sql, stmt);
    }
    return stmt;
  }

  /** Only a found table is remembered: today's table can be created after a miss. */
  hasTable(entry, name) {
    if (entry.known.has(name)) return true;
    const found = this.statement(entry, "SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (found) entry.known.add(name);
    return Boolean(found);
  }

  /**
   * Up to `limit` ticks strictly after (afterTs, afterSeq) and before `until`, in
   * (ts, seq) order, as [ts, price, size, side, seq]. Paging with the last row's
   * (ts, seq) as the next cursor walks exactly the rows ticks() returns.
   */
  ticksAfter(root, afterTs, afterSeq, until, limit = 5000) {
    this.flush();
    const out = [];
    const t = tableName('ticks', root);
    for (const day of this.days(afterTs, until)) {
      const entry = this.entry(day);
      if (!entry || !this.hasTable(entry, t)) continue;
      const rows = this.statement(entry, `SELECT ts, price, size, side, seq FROM ${t} WHERE (ts, seq) > (?, ?) AND ts < ? ORDER BY ts, seq LIMIT ?`, true)
        .all(afterTs, afterSeq, until, limit - out.length);
      for (const r of rows) out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Opens the gzipped days in [since, until] with a streaming gunzip, so a reader
   * that awaits this first never decompresses a day synchronously in db().
   * Days that are open, live or absent are left alone.
   */
  async prepareDays(since, until) {
    for (const day of this.days(since, until)) {
      if (this.open.has(day)) continue;
      const file = this.filePath(day);
      if (existsSync(file) || !existsSync(`${file}.gz`)) continue;
      let job = this.preparing.get(day);
      if (!job) {
        job = this.gunzipDay(day, file).finally(() => this.preparing.delete(day));
        this.preparing.set(day, job);
      }
      await job;
    }
  }

  async gunzipDay(day, file) {
    this.tempSeq += 1;
    const temp = path.join(os.tmpdir(), `ticks-${process.pid}-${day}-a${this.tempSeq}.sqlite`);
    try {
      await pipeline(createReadStream(`${file}.gz`), createGunzip(), createWriteStream(temp));
    } catch (err) {
      rmSync(temp, { force: true });
      throw err;
    }
    // A synchronous db() call may have opened the day meanwhile.
    if (this.closed || this.open.has(day)) {
      rmSync(temp, { force: true });
      return;
    }
    this.register(day, temp, temp);
  }

  /** Latest bid/ask at or before `ts` on the same UTC day. */
  quoteAt(root, ts) {
    const entry = this.entry(utcDay(ts));
    if (!entry) return null;
    const q = tableName('quotes', root);
    if (!this.hasTable(entry, q)) return null;
    return this.statement(entry, `SELECT ts, bid, ask FROM ${q} WHERE ts <= ? ORDER BY ts DESC LIMIT 1`).get(ts) || null;
  }

  /** ccxt-shaped public trades for Freqtrade's orderflow (time pagination). */
  publicTrades(root, symbol, since, limit = 1000) {
    const start = since ?? Date.now() - 60 * 60 * 1000;
    return this.ticks(root, start, Date.now() + 1000, limit).map(([ts, price, size, side, seq]) => ({
      id: `${ts}-${seq}`,
      timestamp: ts,
      datetime: new Date(ts).toISOString(),
      symbol,
      side: side === 0 ? 'buy' : 'sell',
      price,
      amount: size,
      cost: price * size,
      type: null,
      takerOrMaker: 'taker',
    }));
  }

  /**
   * Compress old days and drop expired ones. The gzip runs as a stream on the
   * thread pool, so a day file of hundreds of MB does not block the event loop.
   * Calls while a run is in progress join it.
   */
  maintain(now = Date.now()) {
    if (this.maintaining) return this.maintaining;
    this.maintaining = this.runMaintenance(now).finally(() => {
      this.maintaining = null;
    });
    return this.maintaining;
  }

  async runMaintenance(now) {
    if (!this.enabled || !existsSync(this.dir)) return;
    const today = utcDay(now);
    for (const file of readdirSync(this.dir)) {
      const match = /^(\d{4}-\d{2}-\d{2})\.sqlite(\.gz)?$/.exec(file);
      if (!match) continue;
      const day = match[1];
      const ageDays = (Date.parse(today) - Date.parse(day)) / DAY_MS;
      const full = path.join(this.dir, file);
      if (ageDays > this.retentionDays) {
        rmSync(full, { force: true });
        continue;
      }
      if (!match[2] && ageDays >= COMPRESS_AFTER_DAYS && statSync(full).size > 0) {
        await this.compressDay(day, full);
      }
    }
  }

  async compressDay(day, full) {
    const entry = this.open.get(day);
    const db = entry?.db || new Database(full);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    this.open.delete(day);

    // Written under a temporary name and renamed, so a crash never leaves a truncated .gz that looks valid.
    const gz = `${full}.gz`;
    const partial = `${gz}.partial`;
    try {
      await pipeline(createReadStream(full), createGzip(), createWriteStream(partial));
    } catch (err) {
      rmSync(partial, { force: true });
      throw err;
    }
    if (this.open.has(day)) {
      // A late print reopened the day while it was being compressed; keep the live file and try again next run.
      rmSync(partial, { force: true });
      return;
    }
    renameSync(partial, gz);
    rmSync(full, { force: true });
    rmSync(`${full}-wal`, { force: true });
    rmSync(`${full}-shm`, { force: true });
  }

  status() {
    return { enabled: this.enabled, dir: this.dir, pending: this.pending.length, ...this.stats };
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.maintenance);
    this.flush();
    for (const entry of this.open.values()) {
      entry.db.close();
      if (entry.temp) rmSync(entry.temp, { force: true });
    }
    this.open.clear();
  }
}
