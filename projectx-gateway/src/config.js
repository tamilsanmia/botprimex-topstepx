import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The gateway shares Freqtrade's config.json so every setting lives in one file.
 * Freqtrade parses it with rapidjson in a mode that allows comments and trailing
 * commas, so the same leniency is needed here.
 */
export function parseLenientJson(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const GATEWAY_DEFAULTS = Object.freeze({
  account: 'auto',
  live_data: false,
  fill_wait_ms: 1500,
  brackets: 'separate',
  reconcile_secs: 30,
  flatten_grace_secs: 30,
  backfill_candles: 1500,
  max_candles: 5000,
  max_order_size: 50,
  account_source: 'auto',
  balance_offset: 'auto',
  rate_limits: { bars_per_30s: 40, other_per_60s: 180, order_reserve: 20, max_queue: 500 },
  // Who protects an open position with a stop: 'gateway' (watchdog places one when
  // Freqtrade has not within grace_secs, flattens after flatten_after_secs),
  // 'native' (only the stopLossBracket path) or 'off'.
  protective_stop: { mode: 'gateway', grace_secs: 10, flatten_after_secs: 30 },
  ticks: { record: true, retention_days: 30, pairs: 'whitelist' },
  history: { continuous: true, adjust: 'back', retention_days: 400, minute_retention_days: 61, second_retention_days: 15 },
  orderflow: { block_multiple: 25, value_area_pct: 70 },
});

function merge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = merge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const flag = (v) => v === '1' || String(v).toLowerCase() === 'true';

export function loadConfig(env = process.env) {
  const configPath = env.FREQTRADE_CONFIG || '/freqtrade/user_data/config.json';
  let ft = {};
  try {
    ft = parseLenientJson(readFileSync(configPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot parse ${configPath}: ${err.message}`);
    console.warn(`[config] ${configPath} not found, using defaults`);
  }

  const gateway = merge(GATEWAY_DEFAULTS, ft.projectx_gateway);
  // .env wins, so one config can serve several stacks, each on its own account.
  if (env.PROJECTX_ACCOUNT_ID) gateway.account = env.PROJECTX_ACCOUNT_ID.trim();
  const dataDir = env.GATEWAY_DATA_DIR || path.dirname(configPath);

  return {
    configPath,
    dataDir,
    port: Number(env.GATEWAY_PORT || 8787),
    secret: env.GATEWAY_SECRET || '',
    bind: (env.GATEWAY_BIND || '').trim() || '0.0.0.0',
    bindSubnet: (env.GATEWAY_BIND_SUBNET || '').trim(),
    allowQuerySecret: flag(env.GATEWAY_ALLOW_QUERY_SECRET),
    dataOnly: flag(env.GATEWAY_DATA_ONLY),
    mock: flag(env.PROJECTX_MOCK),
    projectx: {
      apiBase: (env.PROJECTX_API_BASE || 'https://api.topstepx.com').replace(/\/+$/, ''),
      marketHub: env.PROJECTX_MARKET_HUB || 'https://rtc.topstepx.com/hubs/market',
      userHub: env.PROJECTX_USER_HUB || 'https://rtc.topstepx.com/hubs/user',
      username: env.PROJECTX_USERNAME || '',
      apiKey: env.PROJECTX_API_KEY || '',
      live: env.PROJECTX_LIVE_DATA ? env.PROJECTX_LIVE_DATA === 'true' : Boolean(gateway.live_data),
    },
    dryRun: ft.dry_run !== false,
    whitelist: ft.exchange?.pair_whitelist || [],
    stakeCurrency: ft.stake_currency || 'USD',
    telegram: ft.telegram || {},
    gateway,
    topstep: ft.topstep || {},
    topstepOrderflow: ft.topstep_orderflow || {},
  };
}

/** Pair <-> root. Pairs are `MES/USD:USD`; roots are what the gateway resolves. */
export function rootOf(symbol) {
  return String(symbol || '').split('/')[0].trim().toUpperCase();
}

export function pairOf(root, quote = 'USD') {
  return `${root}/${quote}:${quote}`;
}
