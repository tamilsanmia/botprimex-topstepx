# BotPrimeX for TopstepX

Run the BotPrimeX Freqtrade strategy on a TopstepX (ProjectX) futures account: MES, MNQ, ES, NQ, gold, crude, micro Bitcoin and more. The bot follows Topstep's rules on its own, so it stops before an account limit is broken.

```
Freqtrade  --->  projectx-gateway  --->  TopstepX (api.topstepx.com, live data hubs)
(strategy)       (data, orders, Topstep rules)
```

* **projectx-gateway** is the only part that talks to TopstepX. It streams live prices, builds candles, places orders and enforces the Topstep rules.
* **Freqtrade** runs the `BotPrimeX_TopstepX` strategy and asks the gateway for everything.

---

## Requirements

* A Linux server with Docker (`./install-docker.sh` installs it on Ubuntu)
* A TopstepX account with API access: create a key at **topstepx.com > Settings > API**

---

## Quick start

```bash
./topstep setup        # creates .env and user_data/ (configs + strategies)
nano .env              # PROJECTX_USERNAME, PROJECTX_API_KEY, PROJECTX_ACCOUNT_ID
./topstep build        # builds the Docker images
./topstep accounts     # lists your accounts: copy the id into .env
nano user_data/config.json   # set your account rules (see "Topstep rules")
./topstep start        # starts in dry-run (no real orders)
./topstep logs
```

When dry-run looks right, set `"dry_run": false` in `user_data/config.json` and run `./topstep restart`.

---

## Commands

Run `./topstep --help` at any time.

| Command | What it does |
| --- | --- |
| `./topstep setup` | Create `.env` and `user_data/` if missing |
| `./topstep build` | Build the Docker images |
| `./topstep accounts` | List your TopstepX accounts and which one the bot uses |
| `./topstep start` / `stop` / `restart` | Start, stop or restart the bot |
| `./topstep logs [gateway\|bot]` | Follow the logs |
| `./topstep status` | Connection health: live data, account, rate limits, latency |
| `./topstep guard` | Account protection: day P&L, loss limits, contracts in use |
| `./topstep reset-day` | Clear today's lock |
| `./topstep reset-account` | Clear an account lock |
| `./topstep download` | Download history for backtests (`./topstep download --help`) |
| `./topstep backtest-ui [stop]` | Start or stop the backtest web app |
| `./topstep backtest [timerange]` | Run a backtest in the terminal, for example `20260901-` |
| `./topstep test` | Run all unit tests |
| `./topstep config` | Check the compose files and configs |

---

## Choosing your account

The bot trades **one** account, set in `.env`:

```
PROJECTX_ACCOUNT_ID=27790619
```

* `./topstep accounts` shows every account on your login, and which one is selected.
* If it is left empty, the bot uses the only account that can trade. With several accounts it refuses to start until you choose one.
* To trade several accounts at the same time, use one copy of this folder per account. Give each copy its own `.env`, its own `user_data/`, and different `container_name`s and ports in `docker-compose.yml`.

---

## Files

| File | Purpose |
| --- | --- |
| `.env` | TopstepX login, API key, account id, gateway secret (never commit) |
| `user_data/config.json` | Live / dry-run settings: pairs, Topstep rules, protection |
| `user_data/config-futures-backtest.json` | Backtest settings |
| `config_projectx.example.json`, `config_backtest.example.json` | Templates for the two configs |
| `BotPrimeX.py`, `BotPrimeX_TopstepX.py` | The strategy and its TopstepX layer |
| `docker-compose.yml` | Live / dry-run stack |
| `docker-compose-webserver.yml` | Backtest stack (FreqUI) |

---

## Topstep rules

The TopstepX API does not report your account's rules, so you set them in the `topstep` block of `user_data/config.json`:

```json
"topstep": {
  "phase": "evaluation",
  "preset": "50k",
  "start_balance": 50000
}
```

* `phase`: `evaluation`, `funded` or `live_funded`. `auto` works only for standard account names (`50KTC...`, `...XFA...`).
* `preset`: `50k`, `100k` or `150k`. It fills in the numbers below, and any value you set in `phases` overrides it.
* `start_balance`: the balance the account started with. Express Funded accounts start at `0`.

| Preset | Profit target | Daily Loss Limit | Max Loss Limit | Max contracts |
| --- | --- | --- | --- | --- |
| 50K | $3,000 | $1,000 | $2,000 | 5 minis / 50 micros |
| 100K | $6,000 | $2,000 | $3,000 | 10 minis / 100 micros |
| 150K | $9,000 | $3,000 | $4,500 | 15 minis / 150 micros |

Check these against your Topstep dashboard, because Topstep changes them from time to time.

**Other settings** (all in the `topstep` block):

* **Session times**, in `session`:
  * No entries from 15:45 to 18:05 ET.
  * Positions closed by 16:05 ET.
  * The trading day resets at 18:00 ET.
  * No weekends.
  * A news blackout window around the 8:30 ET data releases.
* **Loss limit timing**:
  * `max_loss_type`: `trailing_eod` (Topstep's default), `trailing_intraday` or `static`.
  * `daily_loss_type`: `intraday` (realized plus open P&L) or `eod` (realized only).
* **Consistency**: `consistency_pct` (50 in evaluation) caps any single day's profit.
* **Lots**: a micro counts as 1/10 of a mini. Holding a mini and its micro together (ES with MES, NQ with MNQ, CL with MCL) is blocked.

## Account protection

On top of Topstep's own rules, the `protection` block adds:

| Setting | Effect |
| --- | --- |
| `dll_soft_pct` (70) | No new trades once 70% of the Daily Loss Limit is used |
| `dll_hard_pct` (90) | Close everything and stop for the day at 90% |
| `mll_buffer` ($300) | Close everything and lock the account $300 before the Max Loss Limit |
| `max_risk_per_trade` ($250) | Each trade's contracts and stop are sized to risk at most this |
| `max_trades_per_day` (10), `max_consecutive_losses` (3) | Stop new trades for the day |
| `daily_profit_lock` | After a good day, stop if too much profit is given back |

The bot is always in one of 4 states:

* **active**: trading normally.
* **entries_blocked**: no new trades, open trades keep running.
* **day_locked**: everything is closed until 18:00 ET.
* **account_locked**: everything is closed until you run `./topstep reset-account`.

If Freqtrade does not close a position within 30 seconds of a lock, the gateway closes it directly. Check the current state with `./topstep guard`.

---

## Pairs

Pairs are written `ROOT/USD:USD`, for example `MES/USD:USD`. Each one always trades the current front-month contract and follows rolls automatically. The default list in the config:

* **Index**: MES, ES, MNQ, NQ, M2K, RTY, MYM, YM
* **Metals**: MGC, GC, SIL, MHG
* **Energy**: MCL, CL
* **Crypto**: MBT, MET

More are available, including FX, rates, agriculture, natural gas and silver. They are listed in the config comments.

## How trades are sized

* **Stop distance**: 2 × ATR, kept between 8 and 400 ticks.
* **Contracts**: `max_risk_per_trade / (stop ticks × tick value)`, rounded down. Also capped by the contract limit and `max_contracts_per_trade`.
* **Too risky**: if not even 1 contract fits, the trade is skipped.

Tune these in `topstep_strategy`.

---

## Backtesting

A separate web app (FreqUI) for backtests, with its own gateway, so it never touches the live bot.

```bash
./topstep download       # history for all pairs and timeframes
./topstep backtest-ui    # open http://<server-ip>:8095
```

Log in with `api_server.username` / `password` from `user_data/config-futures-backtest.json`. Then pick `BotPrimeX_TopstepX`, a timeframe and dates, and run.

The backtest UI is public on port 8095, so use a strong password. To make it private, set `WEBSERVER_BIND=127.0.0.1` in `.env` and use an SSH tunnel. The live bot's UI (port 8001) is always localhost-only:

```bash
ssh -L 8001:127.0.0.1:8001 <user>@<server>    # then open http://127.0.0.1:8001
```

**How far back data goes** (a TopstepX limit):

| Timeframe | History |
| --- | --- |
| 1h, 2h, 4h, 1d | about 1 year |
| 1m, 5m, 15m, 30m | about 60 days |
| seconds | about 2 to 3 weeks |

* Run `./topstep download` every few weeks. New data is added to your files, so your own minute history keeps growing.
* Each pair is one continuous series across contract rolls, with older contracts price-adjusted at each roll. Set `"adjust": "none"` in `projectx_gateway.history` for raw prices.
* The Topstep rules and protection are simulated in backtests too, so you will see `session_flat` and `account_protection` exits.
* A backtest stops trading early if the simulated account gets locked, just like a real account would.
* `stop_on_target` is `false` in the backtest config, so the backtest keeps trading after the profit target is reached.

---

## Speed and rate limits

TopstepX allows 50 history requests per 30 seconds and 200 other requests per minute. The bot stays well under this:

* **Live data**: candles and prices come from the live data stream, so they cost no requests.
* **Account data**: orders, fills and positions arrive live too. A safety check runs every 30 seconds.
* **Market orders**: one request each. The bot sees the fill price in the same second.
* **Startup**: history is only requested once, plus repairs after a disconnect.

`./topstep status` shows hub state, latency and rate-limit use. A server near Chicago or the US East coast gives the fastest orders.

---

## Optional features

* **Order flow**: every trade print is recorded with its buy/sell side.
  * Set `exchange.use_public_trades: true` for Freqtrade's footprint, delta and imbalance columns.
  * Set `topstep_orderflow.enabled: true` for the extra features and filters (session CVD, large prints, volume profile).
  * History starts when recording starts.
* **1-second timeframes**: set `"timeframe": "1s"` (also `5s`, `15s`, `30s`). This is experimental: keep the pair list short.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Gateway exits with "Invalid topstep config" | Set `topstep.phase`, `preset` and `start_balance` in `user_data/config.json` |
| "Several ProjectX accounts can trade" | Set `PROJECTX_ACCOUNT_ID` in `.env` (see `./topstep accounts`) |
| Login fails (error code 3) | Check `PROJECTX_USERNAME` and `PROJECTX_API_KEY`, or create a new key |
| No trades at all | Run `./topstep guard`. It may be outside trading hours, a weekend, or locked |
| "no whole contract fits risk" in the logs | Raise `max_risk_per_trade`, or trade micros instead of minis |
| "port is already allocated" | Set `WEBSERVER_PORT` in `.env`, or change the port in the compose file |
| Empty contract list | Set `projectx_gateway.live_data` to match your data subscription |

---

## Known limits

* TopstepX gives top-of-book prices only (no full order book).
* Backtest history depth is limited by TopstepX (see Backtesting).
* Topstep presets and contract roll dates are estimates. Check them against your dashboard.

---

## Server setup (Ubuntu, optional)

```bash
sudo hostnamectl set-hostname b1.freqai.pro      # optional: match your subdomain
echo "127.0.0.1 b1.freqai.pro" | sudo tee -a /etc/hosts
chmod +x install-docker.sh && ./install-docker.sh
```

For a domain, add a Cloudflare `A` record (for example `b1`) pointing to the server IP, with the proxy turned off ("DNS only").

---

## Testing without TopstepX

* `PROJECTX_MOCK=1` in `.env` replaces TopstepX with a simulator (fake prices and fills). Never use it for real trading.
* `./topstep test` runs the unit tests.
* `tests/timeframe_matrix.sh` runs the full stack on the simulator at several timeframes.
