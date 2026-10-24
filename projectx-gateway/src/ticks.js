import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import os from 'node:os';

import Database from 'better-sqlite3';

const DAY_MS = 24 * 60 * 60 * 1000;
const FLUSH_MS = 500;
const COMPRESS_AFTER_DAYS = 2;
const OPEN_CACHE = 4;

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
 * into a temp file kept in a small LRU.
 */
export class TickStore {
  constructor({ dir, retentionDays = 30, enabled = true }) {
    this.dir = dir;
    this.retentionDays = retentionDays;
    this.enabled = enabled;
    this.open = new Map();
    this.pending = [];
    this.pendingQuotes = [];
    this.seqByMs = new Map();
    this.lastQuoteSec = new Map();
    this.stats = { written: 0, lastFlushMs: 0 };
    if (enabled) mkdirSync(dir, { recursive: true });
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref?.();
    this.maintenance = setInterval(() => this.maintain(), 60 * 60 * 1000);
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

    const db = new Database(file, { readonly: Boolean(temp) });
    if (!temp) {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
    }
    this.open.set(day, { db, temp, tables: new Set() });
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

  record(root, tick) {
    if (!this.enabled) return;
    const key = `${root}|${tick.ts}`;
    const seq = this.seqByMs.get(key) || 0;
    this.seqByMs.set(key, seq + 1);
    if (this.seqByMs.size > 50_000) this.seqByMs.clear();
    this.pending.push([root, tick.ts, seq, tick.price, tick.size, tick.side === 'buy' ? 0 : 1]);
  }

  recordQuote(root, ts, bid, ask) {
    if (!this.enabled || !(bid > 0) || !(ask > 0)) return;
    const sec = Math.floor(ts / 1000);
    if (this.lastQuoteSec.get(root) === sec) return;
    this.lastQuoteSec.set(root, sec);
    this.pendingQuotes.push([root, sec * 1000, bid, ask]);
  }

  flush() {
    if (!this.pending.length && !this.pendingQuotes.length) return;
    const started = performance.now();
    const ticks = this.pending;
    const quotes = this.pendingQuotes;
    this.pending = [];
    this.pendingQuotes = [];

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

  /** Latest bid/ask at or before `ts` on the same UTC day. */
  quoteAt(root, ts) {
    const db = this.db(utcDay(ts));
    if (!db) return null;
    const q = tableName('quotes', root);
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(q);
    if (!exists) return null;
    return db.prepare(`SELECT ts, bid, ask FROM ${q} WHERE ts <= ? ORDER BY ts DESC LIMIT 1`).get(ts) || null;
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

  /** Compress old days and drop expired ones. */
  maintain(now = Date.now()) {
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
        const entry = this.open.get(day);
        const db = entry?.db || new Database(full);
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
        this.open.delete(day);
        writeFileSync(`${full}.gz`, gzipSync(readFileSync(full)));
        rmSync(full, { force: true });
        rmSync(`${full}-wal`, { force: true });
        rmSync(`${full}-shm`, { force: true });
      }
    }
  }

  status() {
    return { enabled: this.enabled, dir: this.dir, pending: this.pending.length, ...this.stats };
  }

  close() {
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
