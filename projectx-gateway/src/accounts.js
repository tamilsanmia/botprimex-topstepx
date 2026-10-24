/**
 * Lists the trading accounts on the ProjectX login in .env, and which one the
 * gateway would select with the current settings.
 *
 *   docker compose run --rm --no-deps projectx-gateway node src/accounts.js
 */
import { loadConfig } from './config.js';
import { RateLimiter } from './limiter.js';
import { createMockUpstream } from './mock.js';
import { ProjectXClient } from './projectx.js';

const cfg = loadConfig();
const client = cfg.mock ? createMockUpstream(cfg).client : new ProjectXClient(cfg.projectx, new RateLimiter());

let accounts;
try {
  accounts = await client.searchAccounts({ onlyActive: false });
} catch (err) {
  console.error(`Could not list accounts: ${err.message}`);
  if (err.kind === 'AuthenticationError') console.error('Check PROJECTX_USERNAME and PROJECTX_API_KEY in .env.');
  process.exit(1);
}
if (!accounts.length) {
  console.log('No accounts on this login.');
  process.exit(1);
}

console.log(`Accounts for ${cfg.projectx.username}:\n`);
for (const a of accounts) {
  const flags = [a.canTrade ? 'can trade' : 'cannot trade', a.simulated ? 'practice/sim' : 'LIVE', a.visible ? null : 'hidden']
    .filter(Boolean).join(', ');
  console.log(`  ${String(a.id).padEnd(10)} ${a.name.padEnd(40)} balance ${String(a.balance).padStart(12)}   ${flags}`);
}

const selector = cfg.gateway.account;
const tradeable = accounts.filter((a) => a.canTrade);
const chosen = selector && selector !== 'auto'
  ? accounts.find((a) => String(a.id) === String(selector) || a.name === String(selector))
  : (tradeable.length === 1 ? tradeable[0] : null);

console.log(`\nSelection: ${selector || 'auto'}`);
if (chosen) console.log(`  -> the bot trades ${chosen.id} (${chosen.name})`);
else if (selector && selector !== 'auto') console.log(`  -> "${selector}" is not on this login`);
else console.log('  -> several accounts can trade: set PROJECTX_ACCOUNT_ID in .env to one id above');
