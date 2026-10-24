/**
 * Session clock in an IANA timezone, DST-safe via Intl (no offset tables).
 *
 * Topstep's trading day starts at the CME reopen (18:00 ET = 17:00 CT) and ends
 * at the next afternoon's close; a day is named by the date it ENDS on, so the
 * session that opens Sunday evening is Monday's.
 */
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false,
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(ts, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(ts))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(String(parts.weekday).slice(0, 3).toLowerCase()),
    minutes: hour * 60 + Number(parts.minute),
  };
}

function offsetMs(ts, tz) {
  const p = localParts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Epoch ms of a wall-clock time in `tz`. */
export function zonedToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - offsetMs(guess, tz);
  // Second pass settles DST transitions.
  ts = guess - offsetMs(ts, tz);
  return ts;
}

export function parseHHMM(value, name = 'time') {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) throw new Error(`${name} must be HH:MM, got "${value}"`);
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) throw new Error(`${name} out of range: "${value}"`);
  return h * 60 + m;
}

/** True when `minutes` falls in [start, end), wrapping past midnight. */
export function inWindow(minutes, start, end) {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

const dateKey = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n, 12));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

/** Parses "mon-fri", "mon,wed,fri", "*" or an array into a Set of weekday numbers. */
export function parseDays(spec) {
  if (!spec || spec === '*' || spec === 'all') return new Set([0, 1, 2, 3, 4, 5, 6]);
  const tokens = Array.isArray(spec) ? spec : String(spec).split(',');
  const out = new Set();
  for (const token of tokens) {
    const t = String(token).trim().toLowerCase();
    const range = t.split('-');
    if (range.length === 2) {
      let a = WEEKDAYS.indexOf(range[0].slice(0, 3));
      const b = WEEKDAYS.indexOf(range[1].slice(0, 3));
      if (a < 0 || b < 0) throw new Error(`bad day range "${t}"`);
      for (;;) {
        out.add(a);
        if (a === b) break;
        a = (a + 1) % 7;
      }
    } else {
      const d = WEEKDAYS.indexOf(t.slice(0, 3));
      if (d < 0) throw new Error(`bad day "${t}"`);
      out.add(d);
    }
  }
  return out;
}

export class SessionClock {
  constructor({ timezone = 'America/New_York', reset_time = '18:00', eod_time = '16:10' } = {}) {
    this.tz = timezone;
    this.reset = parseHHMM(reset_time, 'session.reset_time');
    this.eod = parseHHMM(eod_time, 'session.eod_time');
    // Validates the timezone eagerly.
    formatter(this.tz).format(new Date());
  }

  /** { start, end, key, eodTs } for the trading day containing `ts`. */
  tradingDay(ts) {
    const p = localParts(ts, this.tz);
    let [y, m, d] = [p.year, p.month, p.day];
    if (p.minutes < this.reset) [y, m, d] = addDays(y, m, d, -1);
    const start = zonedToUtc(y, m, d, Math.floor(this.reset / 60), this.reset % 60, this.tz);
    const [ey, em, ed] = addDays(y, m, d, 1);
    const end = zonedToUtc(ey, em, ed, Math.floor(this.reset / 60), this.reset % 60, this.tz);
    // The day is named by the date it closes on, and so is its EOD.
    const [ky, km, kd] = this.reset >= 12 * 60 ? [ey, em, ed] : [y, m, d];
    const eodTs = zonedToUtc(ky, km, kd, Math.floor(this.eod / 60), this.eod % 60, this.tz);
    return { start, end, key: dateKey(ky, km, kd), eodTs };
  }

  sessionStart(ts) {
    return this.tradingDay(ts).start;
  }

  local(ts) {
    return localParts(ts, this.tz);
  }
}
