# BotPrimeX for TopstepX

Run the BotPrimeX Freqtrade strategy on a TopstepX (ProjectX) futures account: MES, MNQ, ES, NQ, gold, crude, micro Bitcoin and more. The bot follows Topstep's rules on its own, so it stops before an account limit is broken.

```
Freqtrade  --->  projectx-gateway  --->  TopstepX (api.topstepx.com, live data hubs)
(strategy)       (data, orders, Topstep rules)
```

* **projectx-gateway** is the only part that talks to TopstepX. It streams live prices, builds candles, places orders and enforces the Topstep rules.
* **Freqtrade** runs a TopstepX strategy (`BotPrimeX_TopstepX` or `NoTankAi_TopstepX`) and asks the gateway for everything.

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
| `./topstep setup` | Create `.env` and `user_data/` if missing. Never overwrites: a strategy that differs from the repo copy is kept and reported (`FORCE=1 ./topstep setup` replaces it after saving a backup) |
| `./topstep build` | Build the Docker images |
| `./topstep accounts` | List your TopstepX accounts and which one the bot uses |
| `./topstep start` / `stop` / `restart` | Start, stop or restart the bot |
| `./topstep logs [gateway\|bot]` | Follow the logs |
| `./topstep status` | Connection health: live data, account, rate limits, latency |
| `./topstep guard` | Account protection: day P&L, loss limits, contracts in use |
| `./topstep reset-day` | Clear today's lock |
| `./topstep reset-account` | Clear an account lock |
| `./topstep download` | Download history for backtests (`./topstep download --help`) |
| `./topstep backtest-ui [stop]` | Start or stop the backtest web app (localhost only by default) |
| `./topstep backtest [timerange]` | Run a backtest in the terminal, for example `20260901-` |
| `./topstep test` | Run the gateway and Python unit tests on the files in this folder (not the code baked into the images) |
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
| `BotPrimeX.py`, `BotPrimeX_TopstepX.py` | BotPrimeX and its TopstepX version |
| `NoTankAI.py`, `NoTankAI_TopstepX.py` | NoTankAi and its TopstepX version |
| `projectx/strategy_mixin.py` | The TopstepX layer shared by every `_TopstepX` strategy |
| `docker-compose.yml` | Live / dry-run stack |
| `docker-compose-webserver.yml` | Backtest stack (FreqUI) |
| `docs/topstep-rules-sources.md` | Where each Topstep rule value comes from and how well it is verified |
| `tests/` | Python tests, shared fixtures, and `timeframe_matrix.sh` (see Testing) |

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

Check these against your Topstep dashboard, because Topstep changes them from time to time. [docs/topstep-rules-sources.md](docs/topstep-rules-sources.md) lists the source of every number and says which ones are verified on help.topstep.com pages and which are not (the profit targets, the Express Funded scaling tiers and the Live Funded Account tiers are not).

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
* **Consistency**: `consistency_pct` is 55 in evaluation, Topstep's published consistency target. `consistency_mode` decides what the bot does with it:
  * `cap_day` (default, cautious): no new trades on a day once its profit reaches 55% of the profit target, so the target never has to rise.
  * `raise_target`: Topstep's own rule. The profit target rises to `best day / 0.55`; nothing is blocked.
  * `off`: ignore it.
* **Holidays**: `session.use_holiday_calendar` (default `true`) closes trading on CME holidays and closes positions before early closes. The calendar table is from third-party summaries and is not verified against CME; the 2027 rows are derived from U.S. holiday rules. Re-check it against CME's holiday page before each holiday.
* **Account name**: `topstep.account_name` (for example `50KTC-DRY`) lets `phase` and `preset` `auto` work in backtests and dry-run. In live trading the real account name is used instead.
* **Lots**: a micro counts as 1/10 of a mini. Holding a mini and its micro together (ES with MES, NQ with MNQ, CL with MCL) is blocked. A product the gateway does not know is refused: add it under `lots` in the config.
  * Verified: the 10:1 ratio in the Combine and Express Funded Account, the 5/10/15 mini limits, the equity index, gold and crude products. The ratio does not apply to the Live Funded Account.
  * Not verified (class or weight assumed): NKD, HG, MHG, PL, SI, SIL, QM, NG, QG, MNG, HO, RB, MBT, MET, all FX (6E, E7, M6E, 6B, M6B, 6A, M6A, 6C, 6J, 6M, 6N, 6S), rates (ZT, ZF, ZN, TN, ZB, UB) and agriculture (ZC, ZS, ZW, ZL, ZM, HE, LE). Check them in your Topstep account before trading them.
  * Not modelled: Topstep's lower per-product limits in high-volatility periods (the "Risk Adjustments" article, for example GC at 3/6/9 contracts for 50K/100K/150K, reportedly also CL, HO and RB). The gateway only knows the account-wide limit, so an entry it allows can still be rejected by TopstepX.

## Account protection

On top of Topstep's own rules, the `protection` block adds:

| Setting | Effect |
| --- | --- |
| `dll_soft_pct` (70) | No new trades once 70% of the Daily Loss Limit is used |
| `dll_hard_pct` (90) | Close everything and stop for the day at 90% |
| `mll_buffer` ($300) | Close everything and lock the account $300 before the Max Loss Limit |
| `max_risk_per_trade` ($250) | Each trade's contracts and stop are sized to risk at most this |
| `max_trades_per_day` (10), `max_consecutive_losses` (3) | Stop new trades for the day (`0` turns them off) |
| `daily_profit_lock` | After a good day, stop if too much profit is given back |

The bot is always in one of 4 states:

* **active**: trading normally.
* **entries_blocked**: no new trades, open trades keep running.
* **day_locked**: everything is closed until 18:00 ET.
* **account_locked**: everything is closed until you run `./topstep reset-account`.

If Freqtrade does not close a position within 30 seconds of a lock, the gateway closes it directly. Check the current state with `./topstep guard`.

**Protective stop watchdog** (`projectx_gateway.protective_stop`). Every 2 seconds the gateway checks that each open position has a working stop order. If one has none for `grace_secs` (10), the gateway places a stop at the `max_risk_per_trade` distance. If that fails, or there is still no stop after `flatten_after_secs` (30), it closes the position and sends a notification. `mode` is `gateway` (default), `native` (stop attached to the entry order; the account must be in Auto OCO mode) or `off`. Entries are refused when the gateway could not protect them. It needs `max_risk_per_trade` to size a stop; with that off, the gateway neither places stops nor refuses entries.

**Stale data gate** (`projectx_gateway.stale`). If the live market or account data stops arriving, no new entries are allowed after `block_entries_secs` (15), and open positions are closed after `flatten_secs` (120; `0` never closes). It is ignored outside trading hours. A contract that is genuinely silent for that long (a thinly traded product) triggers it too: lengthen the times or set `flatten_secs` to `0` if that happens to you.

**Order capacity** (`projectx_gateway.rate_limits`). `order_reserve` (20) keeps that many of the 200 requests a minute for orders, so reads and background syncs cannot delay a stop or an exit. `max_queue` (500) bounds the waiting reads. Entries are placed one at a time, and contracts of an entry that is still being placed count toward the limits.

---

## Pairs

Pairs are written `ROOT/USD:USD`, for example `MES/USD:USD`. Each one always trades the current front-month contract and follows rolls automatically. The default list in the config:

* **Index**: MES, ES, MNQ, NQ, M2K, RTY, MYM, YM
* **Metals**: MGC, GC, SIL, MHG
* **Energy**: MCL, CL
* **Crypto**: MBT, MET

More are available, including FX, rates, agriculture, natural gas and silver. They are listed in the config comments.

## Strategies

| Strategy | Signals | Use on TopstepX |
| --- | --- | --- |
| `BotPrimeX_TopstepX` | BotPrimeX (multi-timeframe extrema, RSI, DI, 24h change) | yes |
| `NoTankAi_TopstepX` | NoTankAi (5m extrema, RSI, DI) from `NoTankAI.py` in this folder | yes |
| `BotPrimeX`, `NoTankAi` | the original crypto versions | no: no Topstep rules, -99% stop |

Choose the live bot's strategy in `.env` with `STRATEGY=NoTankAi_TopstepX`, then run `./topstep restart`. In the backtest web app, pick it from the strategy list.

The `_TopstepX` versions keep the signals, ROI and partial exits of the strategy file in this folder. For NoTankAi that is the rewritten `NoTankAI.py`, not an older `user_data/NoTankAI.original.py` you may have. They add the TopstepX layer:
* the Topstep rules and account protection
* risk-based whole contracts and a real protective stop
* the mini/micro limits and the roll guard

Any strategy's crypto leverage is replaced by `topstep_strategy.leverage`. Profit-based settings (ROI, partial exits at +25%, DCA at -15%) are measured on stake, so they change with that leverage.

**Make any other Freqtrade strategy TopstepX-ready.** Create `MyStrategy_TopstepX.py` next to it:

```python
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from MyStrategy import MyStrategy
from projectx.strategy_mixin import TopstepXMixin

class MyStrategy_TopstepX(TopstepXMixin, MyStrategy):
    pass
```

Note: both BotPrimeX and NoTankAi find tops and bottoms with `argrelextrema`, which needs candles after the turning point to confirm it. Backtests therefore look better than live trading will be. Confirm results in dry-run before going live.

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
./topstep backtest-ui    # open http://127.0.0.1:8095
```

Log in with `api_server.username` / `password` from `user_data/config-futures-backtest.json`. Then pick `BotPrimeX_TopstepX` or `NoTankAi_TopstepX`, a timeframe and dates, and run.

Both web apps listen on localhost only. Reach them from your PC with an SSH tunnel, or put a TLS reverse proxy in front:

```bash
ssh -L 8095:127.0.0.1:8095 <user>@<server>    # backtest app, then open http://127.0.0.1:8095
ssh -L 8001:127.0.0.1:8001 <user>@<server>    # live bot's UI, then open http://127.0.0.1:8001
```

To expose the backtest app on the network anyway, set `WEBSERVER_BIND=0.0.0.0` in `.env` (and `WEBSERVER_PORT` to change the port). Do that only behind TLS. In every case the `api_server` `password`, `jwt_secret_key` and `ws_token` must be real secrets: the web app and the live bot refuse to start when one is empty or contains `change-me` (while `api_server.enabled` is true). Edit them in `user_data/config.json` and `user_data/config-futures-backtest.json`.

The backtest stack has its own gateway that is **data-only** (`GATEWAY_DATA_ONLY=1`): it cannot place, change or cancel orders, and it starts no account connection or guard. It still logs in to ProjectX to read history and market information, so `PROJECTX_USERNAME` and `PROJECTX_API_KEY` in `.env` are needed for downloads and for starting the backtest app.

**How far back data goes** (a TopstepX limit):

| Timeframe | History |
| --- | --- |
| 1h, 2h, 4h, 1d | about 1 year |
| 1m, 5m, 15m, 30m | about 60 days |
| seconds | about 2 weeks |

* Run `./topstep download` every few weeks. New data is added to your files, so your own minute history keeps growing.
* Each pair is one continuous series across contract rolls, with older contracts price-adjusted at each roll. Set `"adjust": "none"` in `projectx_gateway.history` for raw prices.
* The Topstep rules are simulated in backtests with the same rule set as the live guard (a shared test fixture keeps the two in step). That covers open P&L, the Daily Loss Limit (`intraday` or `eod`), the Max Loss Limit (`trailing_eod`, `trailing_intraday` or `static`), the profit giveback lock, the consistency mode, the session windows and the holiday calendar. You will see `session_flat` and `account_protection` exits.
* A backtest stops trading early if the simulated account gets locked, just like a real account would.
* `stop_on_target` is `false` in the backtest config, so the backtest keeps trading after the profit target is reached.
* Backtest, hyperopt and dry-run charge costs from the `topstep_costs` block: `fee_per_contract` (0.37) plus `commission_per_contract` (0.25) per contract and side, and `slippage_ticks` (1) per side. Live trading uses the real fills and never adds them. The exit fee is approximated with the entry price, a difference of a few cents. `"enabled": false` turns the costs off.
* Not simulated: partial fills, queue position, rejected orders, and the gateway's protective stop watchdog and stale data gate.
* Back-adjusted prices change the price level of old data. For a cross-check on raw prices, set `"adjust": "none"` in `projectx_gateway.history`, run `ERASE=1 ./topstep download` for a recent window, and compare the results.

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
* **1-second timeframes**: set `"timeframe": "1s"` (also `5s`, `10s`, `15s`, `30s`). This is experimental: keep the pair list short. `projectx/ft_exchange.py` adjusts Freqtrade for seconds candles: candle-count date maths in seconds (Freqtrade rounds to whole minutes, which reloaded the whole history every loop), the main loop wakes 0.3 s after each candle instead of 1 s, a closed candle counts as final after 250 ms, and live/dry-run analyse the last 2,000 candles.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Gateway exits with "Invalid topstep config" | Set `topstep.phase`, `preset` and `start_balance` in `user_data/config.json` |
| "Several ProjectX accounts can trade" | Set `PROJECTX_ACCOUNT_ID` in `.env` (see `./topstep accounts`) |
| Login fails (error code 3) | Check `PROJECTX_USERNAME` and `PROJECTX_API_KEY`, or create a new key |
| No trades at all | Run `./topstep guard`. It may be outside trading hours, a weekend, or locked |
| "no whole contract fits risk" in the logs | Raise `max_risk_per_trade`, or trade micros instead of minis |
| "api_server is enabled but ... is empty or still a placeholder" | Set real values for `api_server.password`, `jwt_secret_key` and `ws_token` in the config (the message names the keys, never the values) |
| `./topstep setup` prints "differs: ..." | Your copy of a strategy differs from the repo. Keep it, or run `FORCE=1 ./topstep setup` (a backup goes to `user_data/strategies/.backup/`) |
| `./topstep start` warns that the image does not match | Run `./topstep build` so the image contains the current `projectx/` code |
| Entries blocked with `data_stale` | Live data stopped arriving. See `./topstep status`; for a quiet product, lengthen `projectx_gateway.stale` |
| "port is already allocated" | Set `WEBSERVER_PORT` in `.env`, or change the port in the compose file |
| Empty contract list | Set `projectx_gateway.live_data` to match your data subscription |

---

## Known limits

* TopstepX gives top-of-book prices only (no full order book).
* Backtest history depth is limited by TopstepX (see Backtesting).
* Topstep presets and contract roll dates are estimates. Check them against your dashboard; see [docs/topstep-rules-sources.md](docs/topstep-rules-sources.md) for what is verified.
* Lot weights for products that are not verified, the CME holiday table and Topstep's per-product limits in high-volatility periods have the caveats described under "Topstep rules".
* The Combine Max Loss Limit is modelled as never locking at the starting balance, which is the cautious side.

---

## Server setup (Ubuntu, optional)

```bash
chmod +x install-docker.sh && ./install-docker.sh
```

The script installs Docker Engine and the compose plugin from Docker's apt repository. Run it as root or as a user with `sudo`.

To serve a web app under a domain, point a DNS `A` record at the server and put a TLS reverse proxy in front of the localhost port.

---

## Operations

**Rebuild after pulling changes.** The images hold a copy of `projectx/` and the gateway code. `./topstep build` rebuilds them and `./topstep start` warns when the Freqtrade image no longer matches `projectx/` (it compares a hash stored in the image) or when a file in `user_data/strategies/` differs from the repo copy.

**Freqtrade version.** The Freqtrade image is pinned by version tag and digest in `docker/Dockerfile.freqtrade`, and the build fails if the version differs. The build patches Freqtrade in two places (the `projectx` exchange import and the seconds timeframes in FreqUI). If a future FreqUI no longer has the expected timeframe list, the build fails; `--build-arg FREQUI_PATCH=optional` builds without the seconds timeframes in the UI.

**Backups.** `user_data/` holds your configs (with the API secrets), the trade database, the guard state (`topstep_state.*.json`, which keeps the Max Loss Limit high-water mark) and the downloaded data. Back it up with a file only you can read:

```bash
(umask 077; tar czf ~/botprimex-backup-$(date -u +%Y%m%d).tar.gz user_data .env)
```

**Settings added for safety** (all optional; the defaults are shown in `config_projectx.example.json` and `.env.example`):

| Setting | Where | Default |
| --- | --- | --- |
| `GATEWAY_BIND`, `GATEWAY_BIND_SUBNET`, `GATEWAY_HEALTH_HOST` | `.env` | `0.0.0.0`, unset, `127.0.0.1` |
| `GATEWAY_ALLOW_QUERY_SECRET` | `.env` | off |
| `GATEWAY_DATA_ONLY` | the backtest compose file | on there, never on the live stack |
| `WEBSERVER_BIND`, `WEBSERVER_PORT` | `.env` | `127.0.0.1`, `8095` |
| `projectx_gateway.protective_stop` | config | `gateway`, 10 s, 30 s |
| `projectx_gateway.stale` | config | 15 s, 120 s, notify on |
| `projectx_gateway.user_retention` | config | orders 2 days, trades 14 days |
| `projectx_gateway.rate_limits.order_reserve`, `max_queue` | config | 20, 500 |
| `topstep.account_name`, `topstep.session.use_holiday_calendar` | config | unset, on |
| `topstep.phases.<phase>.consistency_mode` | config | `cap_day` |
| `topstep_costs` | config | 0.37 + 0.25 per contract, 1 tick |

The gateway refuses to start (exit code 2) with an empty `GATEWAY_SECRET` unless `PROJECTX_MOCK=1`, with mock mode and `dry_run: false` together, or with an invalid `protective_stop` or `stale` block. The containers run with all capabilities dropped, `no-new-privileges` and a process limit; every container has a read-only root filesystem (only the mounted data directories and `/tmp` are writable), and logs rotate at 3 files of 10 MB. Orders older than `user_retention` are dropped from the gateway's memory, so fills older than 14 days no longer show in the fee and trade details of an order.

---

## Testing without TopstepX

* `PROJECTX_MOCK=1` in `.env` replaces TopstepX with a simulator (fake prices and fills). Never use it for real trading.
* `./topstep test` runs the unit tests on the files in this folder.
* `tests/timeframe_matrix.sh` runs a separate stack (`tests/docker-compose.matrix.yml`, project `pxmatrix`, API on `127.0.0.1:18001`) on the simulator for each of `BotPrimeX_TopstepX` and `NoTankAi_TopstepX` at several timeframes and prints a table. It uses its own containers and a scratch directory, never the live or backtest stack. `MATRIX_TAG=fixcheck` tests an image built with another tag.
