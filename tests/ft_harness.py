"""
Runs Freqtrade 2026.9's own FreqtradeBot order handling (update_trade_state, the stoploss on
exchange checks, the on-exchange order recovery) against a stub exchange that answers with the
gateway's order shapes. Built from the replay of the first live trade (2026-10-26 07:56,
short MNQ, signal DCA, stop filled on placement).

The stub is a Projectx instance that skips __init__, so the adapter's own create_stoploss runs;
only Freqtrade's base Exchange.create_stoploss (the gateway call) is replaced, through
`patch_base_create_stoploss`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pandas as pd

import projectx  # noqa: F401
import freqtrade.freqtradebot as ftb
from freqtrade.exceptions import InvalidOrderException
from freqtrade.exchange.exchange import Exchange
from freqtrade.freqtradebot import FreqtradeBot
from freqtrade.persistence import Order, Trade
from freqtrade.strategy import IStrategy

from projectx.ft_exchange import Projectx
from projectx.strategy_mixin import TopstepXMixin

PAIR = "MNQ/USD:USD"
TICK = 0.25
MNQ = {
    "symbol": PAIR, "root": "MNQ", "tickSize": TICK, "tickValue": 0.5, "contractSize": 2,
    "lot": {"class": "micro", "weight": 0.1, "group": "Nasdaq", "known": True}, "daysToExpiry": 50,
}
T0 = datetime(2026, 10, 26, 7, 56, 16, tzinfo=timezone.utc)
# The live trade: 1 MNQ short at 29099.5, a 1 MNQ add at 29102.25, the stop filled at 29102.75.
ENTRY_ID, ENTRY_PRICE = "3682806810", 29099.5
DCA_ID, DCA_PRICE = "3682807404", 29102.25
STOP_ID, STOP_FILL = "3682807443", 29102.75


class HarnessDP:
    runmode = SimpleNamespace(value="live")

    def __init__(self, atr: float = 1.0, close: float = 29102.5):
        # 2 x ATR 1.0 = 2.0 points = 8 ticks, as in the live log.
        self.frame = pd.DataFrame({"date": [T0], "close": [close], "tsx_atr": [atr], "enter_short": [0]})

    def get_analyzed_dataframe(self, pair, timeframe):
        return self.frame, None

    def market(self, pair):
        return {"info": MNQ}

    def send_msg(self, msg):
        pass


class HarnessBase(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "1s"
    minimal_roi = {0: 100}
    stoploss = -0.1

    def populate_indicators(self, dataframe, metadata):
        return dataframe

    def populate_entry_trend(self, dataframe, metadata):
        return dataframe

    def populate_exit_trend(self, dataframe, metadata):
        return dataframe


class HarnessStrategy(TopstepXMixin, HarnessBase):
    pass


def strategy_config(**extra) -> dict:
    return {
        "strategy": "HarnessStrategy", "timeframe": "1s", "stake_currency": "USD", "dry_run": False,
        "runmode": "live", "user_data_dir": "/tmp/projectx-test-ud", "stoploss": -0.1,
        "topstep": {"enabled": False}, **extra,
    }


def prepare_strategy(strat):
    """What StrategyResolver and the bot set on a strategy before it trades."""
    strat.stoploss = -0.1
    strat._ft_stop_uses_after_fill = True  # custom_stoploss takes after_fill
    strat.dp = HarnessDP()
    strat._markets = {PAIR: MNQ}
    return strat


def make_strategy(**extra):
    return prepare_strategy(HarnessStrategy(strategy_config(**extra)))


class StubExchange(Projectx):
    """Projectx without __init__: answers like the gateway, records the stops it is asked for."""

    def __init__(self, ask: float = STOP_FILL, dry_run: bool = False, config: dict | None = None):  # noqa: D107
        self._config = {"dry_run": dry_run, **(config or {})}
        self._markets = {PAIR: {"symbol": PAIR, "contractSize": 2.0, "precision": {"price": TICK, "amount": 1.0},
                                "info": MNQ}}
        self.ask = ask
        self.bid = ask - TICK
        self.last = ask - TICK
        self.ticker_error: Exception | None = None
        self.created: list[tuple[float, float]] = []  # (amount, stop_price) sent to the gateway
        self.flat = False
        self.stop_response = None  # (amount, stop_price) -> ccxt order the gateway answers
        self.orders: dict[str, dict] = {}  # what GET /order/<id> answers
        self.on_exchange: list[dict] = []  # what GET /orders answers

    def close(self):  # the instance skips __init__, so there is nothing to close
        pass

    def get_rate(self, pair, side, is_short, refresh=True):
        return self.ask if is_short else self.bid

    def check_order_canceled_empty(self, order):
        return False

    def get_option(self, name, default=None):
        return default

    def fetch_ticker(self, pair):
        if self.ticker_error:
            raise self.ticker_error
        return {"symbol": pair, "bid": self.bid, "ask": self.ask, "last": self.last}

    def fetch_stoploss_order(self, order_id, pair, params=None):
        return self.orders[order_id]

    def cancel_stoploss_order(self, order_id, pair, params=None):
        return {"id": order_id, "status": "canceled"}

    def fetch_orders(self, pair, since, params=None):
        return self.on_exchange

    def gateway_create_stoploss(self, pair, amount, stop_price, order_types, side, leverage):
        self.created.append((amount, stop_price))
        if self.flat:
            raise InvalidOrderException(f"projectx No short {pair.split('/')[0]} position to reduce")
        return self.stop_response(amount, stop_price)


def patch_base_create_stoploss(monkeypatch):
    """Freqtrade's Exchange.create_stoploss sends the order; route it to the stub instead."""

    def fake(self, pair, amount, stop_price, order_types, side, leverage):
        return self.gateway_create_stoploss(pair, amount, stop_price, order_types, side, leverage)

    monkeypatch.setattr(Exchange, "create_stoploss", fake)


def make_bot(monkeypatch, strategy, exchange: StubExchange):
    monkeypatch.setattr(ftb, "update_liquidation_prices", lambda *a, **k: None)
    patch_base_create_stoploss(monkeypatch)
    bot = object.__new__(FreqtradeBot)
    bot.exchange = exchange
    bot.strategy = strategy
    bot.config = {"dry_run": exchange._config.get("dry_run", False), "stake_currency": "USD"}
    bot.margin_mode = None
    bot.wallets = SimpleNamespace(update=lambda *a, **k: None, get_owned=lambda *a: 0.0)
    bot.handle_order_fee = lambda *a, **k: None
    bot.notified_exits = []
    bot.order_close_notify = lambda trade, order, stoploss_order, send_msg: bot.notified_exits.append(
        ("order_close", order.order_id, send_msg))
    bot._notify_exit = lambda trade, order_type, fill=False, **k: bot.notified_exits.append(("exit", order_type, fill))
    bot.protections_handled = []
    bot.handle_protections = lambda pair, side: bot.protections_handled.append(pair)
    bot.emergency_exits = []
    bot.emergency_exit = lambda trade, rate: bot.emergency_exits.append(rate)
    bot.cancel_stoploss_on_exchange = lambda trade: trade
    return bot


def ccxt_order(oid, side, typ, status, amount, filled, price, ts, stop=None) -> dict:
    """A gateway order in Freqtrade amount units (contracts x contractSize)."""
    ms = int(ts.timestamp() * 1000)
    return {
        "id": oid, "symbol": PAIR, "type": typ, "side": side, "status": status, "amount": amount,
        "filled": filled, "remaining": amount - filled if status == "open" else 0, "price": price,
        "average": price if filled else None, "cost": price * filled if filled else 0, "stopPrice": stop,
        "timestamp": ms, "lastTradeTimestamp": ms if filled else None, "fee": None, "info": {},
    }


def short_mnq_trade(strategy_name: str = "HarnessStrategy") -> Trade:
    """The live trade before its first fill was applied: 1 MNQ (amount 2.0) short, leverage 50."""
    trade = Trade(
        pair=PAIR, stake_currency="USD", base_currency="MNQ", exchange="projectx", is_open=True,
        amount=2.0, amount_requested=2.1, open_rate=ENTRY_PRICE, stake_amount=1163.98, leverage=50.0,
        is_short=True, contract_size=2.0, fee_open=0.0, fee_close=0.0, open_date=T0,
        trading_mode="futures", amount_precision=1.0, price_precision=TICK, precision_mode=4,
        precision_mode_price=4, strategy=strategy_name,
    )
    Trade.session.add(trade)
    Trade.commit()
    return trade


def fill_entry(bot, trade, oid, price, ts, ask, tag=None, passes=1) -> dict:
    """Records a filled market entry and lets Freqtrade apply it (`passes` 2 adds the fee-update pass)."""
    order = ccxt_order(oid, "sell" if trade.is_short else "buy", "market", "closed", 2.0, 2.0, price, ts)
    trade.orders.append(Order.parse_from_ccxt_object(order, trade.pair, trade.entry_side))
    if tag:
        trade.orders[-1].ft_order_tag = tag
    Trade.commit()
    bot.exchange.ask, bot.exchange.bid, bot.exchange.last = ask, ask - TICK, ask - TICK
    bot.update_trade_state(trade, oid, order)
    if passes > 1:
        # Freqtrade resets fee_open_currency for an added entry; update_trades_without_assigned_fees
        # then applies the same order again with send_msg=False.
        bot.update_trade_state(trade, oid, order, send_msg=False)
    return order


def incident_trade(bot, strategy_name: str = "HarnessStrategy", passes: int = 2) -> Trade:
    """The live trade after its DCA: 2 MNQ short, average 29100.875, the ask at 29102.75."""
    trade = short_mnq_trade(strategy_name)
    fill_entry(bot, trade, ENTRY_ID, ENTRY_PRICE, T0, ask=29100.25)
    fill_entry(bot, trade, DCA_ID, DCA_PRICE, T0 + timedelta(seconds=16), ask=STOP_FILL, tag="signal_dca",
               passes=passes)
    return trade


def filled_stop(amount: float = 4.0, stop: float | None = 29102.25) -> dict:
    return ccxt_order(STOP_ID, "buy", "stop", "closed", amount, amount, STOP_FILL, T0 + timedelta(seconds=17),
                      stop=stop)
