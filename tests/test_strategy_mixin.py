"""
Tests for projectx.strategy_mixin.TopstepXMixin on a minimal strategy without signals.

Backtest-style tests use in-memory LocalTrade objects; the dry-run and live tests talk to the
in-process fake gateway from conftest.py.
"""

from __future__ import annotations

import itertools
import math
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pandas as pd
import pytest
from pandas import DataFrame

import projectx  # noqa: F401
from freqtrade.enums import ExitCheckTuple, ExitType
from freqtrade.persistence import (
    CustomDataWrapper, LocalTrade, Order, Trade, disable_database_use, enable_database_use, init_db,
)
from freqtrade.strategy import IStrategy, stoploss_from_absolute
from freqtrade.strategy.strategy_wrapper import strategy_safe_wrapper

from projectx.costs import COSTS_DEFAULTS
from projectx.strategy_mixin import GUARD_STALE, STOP_KEY, TopstepXMixin

PAIR = "MES/USD:USD"
ES = "ES/USD:USD"
NOW = datetime(2026, 10, 20, 15, 0, tzinfo=timezone.utc)
MES = {
    "symbol": PAIR, "root": "MES", "tickSize": 0.25, "tickValue": 1.25, "contractSize": 5,
    "lot": {"class": "micro", "weight": 0.1, "group": "S&P", "known": True}, "daysToExpiry": 50,
}
ES_ROW = {
    "symbol": ES, "root": "ES", "tickSize": 0.25, "tickValue": 12.5, "contractSize": 50,
    "lot": {"class": "mini", "weight": 1.0, "group": "S&P", "known": True}, "daysToExpiry": 50,
}
TOPSTEP = {"phase": "evaluation", "preset": "50k", "start_balance": 50000, "session": {"news_blackout": []},
           "protection": {"daily_profit_lock": {"enabled": False}}}


class Base(IStrategy):
    """A strategy with no signals whose adjust_trade_position answers `next_adjust`."""

    INTERFACE_VERSION = 3
    timeframe = "5m"
    minimal_roi = {0: 100}
    stoploss = -0.5
    exit_profit_only = True
    exit_profit_offset = 0.0
    ignore_roi_if_entry_signal = False
    use_exit_signal = True
    next_adjust = None

    def populate_indicators(self, dataframe, metadata):
        return dataframe

    def populate_entry_trend(self, dataframe, metadata):
        return dataframe

    def populate_exit_trend(self, dataframe, metadata):
        return dataframe

    def adjust_trade_position(self, trade, current_time, current_rate, current_profit, min_stake, max_stake,
                              current_entry_rate, current_exit_rate, current_entry_profit, current_exit_profit,
                              **kwargs):
        return self.next_adjust


class Strategy(TopstepXMixin, Base):
    pass


class FakeDP:
    def __init__(self, runmode: str):
        self.runmode = SimpleNamespace(value=runmode)
        self.frames: dict[str, DataFrame] = {}
        self.sent: list[str] = []

    def get_analyzed_dataframe(self, pair, timeframe):
        return self.frames.get(pair, DataFrame()), None

    def market(self, pair):
        return None

    def send_msg(self, msg):
        self.sent.append(msg)


def make_strategy(runmode="backtest", dry_run=True, gateway=None, **config):
    cfg = {
        "strategy": "Strategy", "timeframe": "5m", "stake_currency": "USD", "dry_run": dry_run,
        "runmode": runmode, "user_data_dir": "/tmp/projectx-test-ud", "topstep": dict(TOPSTEP),
        **config,
    }
    if gateway is not None:
        cfg["exchange"] = {"ccxt_config": {"options": {"gatewayUrl": gateway.url}}}
    strat = Strategy(cfg)
    strat.dp = FakeDP(runmode)
    strat._markets = {PAIR: MES, ES: ES_ROW}
    return strat


def set_guard(strat, now=NOW, **fields):
    strat._guard = {"status": "active", "canEnter": True, "flatten": False, "flattenReasons": [], "reasons": [],
                    "metrics": {"maxMiniEquivalent": 5, "maxRiskPerTrade": 250}, **fields}
    strat._guard_at = now


def atr_frame(atr: float, close: float = 6000.0, rows: int = 3) -> DataFrame:
    return DataFrame({"close": [close] * rows, "tsx_atr": [atr] * rows})


_ids = itertools.count(100)


def new_trade(pair=PAIR, contracts=1, rate=6000.0, short=False, leverage=50.0, open_=True, model=LocalTrade, **kw):
    cs = 5 if pair == PAIR else 50
    if model is LocalTrade:
        kw["id"] = next(_ids)
    trade = model(
        pair=pair, stake_currency="USD", base_currency="MES", exchange="projectx", is_open=open_,
        amount=contracts * cs, open_rate=rate, stake_amount=contracts * cs * rate / leverage, leverage=leverage,
        is_short=short, contract_size=cs, fee_open=0.0, fee_close=0.0, open_date=NOW - timedelta(hours=1),
        trading_mode="futures", **kw,
    )
    return trade


def add_order(trade, side, contracts, price, when, cs=None):
    cs = cs or trade.contract_size
    n = len(trade.orders) + 1
    order = Order(
        id=n, ft_trade_id=trade.id or 1, ft_is_open=True, ft_pair=trade.pair, order_id=f"o{n}", symbol=trade.pair,
        ft_order_side=side, side=side, order_type="market", status="open", order_date=when,
        order_filled_date=when, order_update_date=when, ft_price=price, price=price, average=price,
        amount=contracts * cs, filled=0, remaining=contracts * cs, cost=contracts * cs * price,
    )
    if isinstance(trade, LocalTrade) and not isinstance(trade, Trade):
        order._trade_bt = trade
    trade.orders.append(order)
    order.close_bt_order(when, trade)
    return order


@pytest.fixture
def backtest_mode():
    disable_database_use("5m")
    LocalTrade.reset_trades()
    CustomDataWrapper.reset_custom_data()
    yield
    LocalTrade.reset_trades()
    CustomDataWrapper.reset_custom_data()
    enable_database_use()


@pytest.fixture
def db():
    init_db("sqlite://")
    yield
    Trade.session.remove()


# ----------------------------------------------------------------------------- sizing --


def test_stake_is_whole_risk_contracts_plus_a_hair(backtest_mode):
    strat = make_strategy()
    strat.dp.frames[PAIR] = atr_frame(5.0)  # 5 x 2.0 / 0.25 = 40 ticks = $50 per contract
    set_guard(strat)
    stake = strat.custom_stake_amount(PAIR, NOW, 6000.0, 1000.0, None, 100000.0, 50.0, None, "long")
    assert stake == pytest.approx((5 + 0.001) * 5 * 6000.0 / 50.0)  # 250 / 50 = 5 contracts
    assert strat._planned_stop_ticks[PAIR] == 40


def test_stake_is_capped_by_max_contracts_and_min_stop(backtest_mode):
    strat = make_strategy(topstep_strategy={"max_contracts_per_trade": 3})
    strat.dp.frames[PAIR] = atr_frame(0.5)  # 4 ticks, raised to min_stop_ticks 8 = $10 -> 25 contracts by risk
    set_guard(strat)
    stake = strat.custom_stake_amount(PAIR, NOW, 6000.0, 1000.0, None, 100000.0, 50.0, None, "long")
    assert stake == pytest.approx(3.001 * 5 * 6000.0 / 50.0)
    assert strat._planned_stop_ticks[PAIR] == 8


def test_stake_is_capped_by_the_mini_equivalent_limit(backtest_mode):
    strat = make_strategy()
    strat.dp.frames[ES] = atr_frame(5.0, close=6000.0)  # 40 ticks x $12.50 = $500 per contract
    set_guard(strat, metrics={"maxMiniEquivalent": 2, "maxRiskPerTrade": 5000})
    stake = strat.custom_stake_amount(ES, NOW, 6000.0, 1000.0, None, 10_000_000.0, 50.0, None, "long")
    assert stake == pytest.approx(2.001 * 50 * 6000.0 / 50.0)  # risk allows 10, the cap 2


def test_held_positions_use_up_the_cap(backtest_mode):
    strat = make_strategy()
    strat.dp.frames[PAIR] = atr_frame(5.0)
    other = new_trade(pair="NQ/USD:USD", contracts=1)
    strat._markets["NQ/USD:USD"] = {**ES_ROW, "symbol": "NQ/USD:USD", "contractSize": 20,
                                   "lot": {"class": "mini", "weight": 1.0, "group": "Nasdaq", "known": True}}
    other.contract_size = 20
    other.amount = 20
    LocalTrade.add_bt_trade(other)
    set_guard(strat, metrics={"maxMiniEquivalent": 1, "maxRiskPerTrade": 250})
    # NQ uses the whole cap of one mini; a micro weighs 0.1.
    assert strat.custom_stake_amount(PAIR, NOW, 6000.0, 1000.0, None, 100000.0, 50.0, None, "long") == 0.0


def test_mini_micro_overlap_blocks_the_entry(backtest_mode):
    strat = make_strategy()
    strat.dp.frames[PAIR] = atr_frame(5.0)
    LocalTrade.add_bt_trade(new_trade(pair=ES))
    set_guard(strat)
    assert strat.custom_stake_amount(PAIR, NOW, 6000.0, 1000.0, None, 100000.0, 50.0, None, "long") == 0.0
    assert strat.confirm_trade_entry(PAIR, "market", 5, 6000.0, "GTC", NOW, None, "long") is False
    strat.config["topstep"]["lots"] = {"block_mini_micro_overlap": False}
    assert strat.custom_stake_amount(PAIR, NOW, 6000.0, 1000.0, None, 100000.0, 50.0, None, "long") > 0


def test_unknown_contract_root_is_refused(backtest_mode):
    strat = make_strategy()
    strat._markets[PAIR] = {**MES, "lot": {"class": "mini", "weight": 1.0, "group": "XX", "known": False}}
    strat.dp.frames[PAIR] = atr_frame(5.0)
    set_guard(strat)
    assert strat.custom_stake_amount(PAIR, NOW, 6000.0, 1000.0, None, 100000.0, 50.0, None, "long") == 0.0
    assert strat.confirm_trade_entry(PAIR, "market", 5, 6000.0, "GTC", NOW, None, "long") is False


def test_stake_is_limited_by_what_the_wallet_can_afford(backtest_mode):
    strat = make_strategy()
    strat.dp.frames[PAIR] = atr_frame(5.0)
    set_guard(strat)
    # 1,500 x 50 / (5 x 6000) = 2.5 contracts
    stake = strat.custom_stake_amount(PAIR, NOW, 6000.0, 1000.0, None, 1500.0, 50.0, None, "long")
    assert stake == pytest.approx(2.001 * 5 * 6000.0 / 50.0)
    assert strat.custom_stake_amount(PAIR, NOW, 6000.0, 1000.0, None, 100.0, 50.0, None, "long") == 0.0


def test_confirm_entry_rejects_more_contracts_than_the_cap_allows(backtest_mode):
    strat = make_strategy()
    set_guard(strat, metrics={"maxMiniEquivalent": 1, "maxRiskPerTrade": 250})
    assert strat.confirm_trade_entry(PAIR, "market", 5 * 10, 6000.0, "GTC", NOW, None, "long") is True
    assert strat.confirm_trade_entry(PAIR, "market", 5 * 11, 6000.0, "GTC", NOW, None, "long") is False


# ------------------------------------------------------------------------- stoploss --


def test_custom_stoploss_is_the_tighter_of_strategy_and_atr_stop(backtest_mode):
    strat = make_strategy()
    trade = new_trade(contracts=2)
    trade.set_custom_data(STOP_KEY, 5990.0)
    protective = abs(stoploss_from_absolute(5990.0, 6000.0, is_short=False, leverage=trade.leverage))
    assert 0 < protective < 0.5
    # Strategy stoploss -0.5 is wider: the ATR stop wins.
    assert strat.custom_stoploss(PAIR, trade, NOW, 6000.0, 0.0, False) == pytest.approx(-protective)
    # A strategy stop tighter than the ATR stop wins instead.
    strat.stoploss = -protective / 2
    assert strat.custom_stoploss(PAIR, trade, NOW, 6000.0, 0.0, False) == pytest.approx(-protective / 2)


def test_custom_stoploss_without_a_stored_stop_is_the_strategy_stop(backtest_mode):
    strat = make_strategy()
    assert strat.custom_stoploss(PAIR, new_trade(), NOW, 6000.0, 0.0, False) == strat.stoploss


def test_custom_stoploss_is_never_closer_than_the_minimum_distance_live(backtest_mode):
    strat = make_strategy(runmode="dry_run")
    four_ticks = stoploss_from_absolute(6001.0, 6000.0, is_short=True, leverage=50.0)
    for stored in (5999.0, 6000.25):  # wrong side of the price, and 1 tick away
        trade = new_trade(short=True)
        trade.set_custom_data(STOP_KEY, stored)
        assert strat.custom_stoploss(PAIR, trade, NOW, 6000.0, 0.0, False) == pytest.approx(-four_ticks)
    far = new_trade(short=True)
    far.set_custom_data(STOP_KEY, 6010.0)
    assert strat.custom_stoploss(PAIR, far, NOW, 6000.0, 0.0, False) == pytest.approx(
        -stoploss_from_absolute(6010.0, 6000.0, is_short=True, leverage=50.0))
    # Backtests keep the stored stop as it is.
    bt = make_strategy()
    near = new_trade(short=True)
    near.set_custom_data(STOP_KEY, 6000.25)
    assert bt.custom_stoploss(PAIR, near, NOW, 6000.0, 0.0, False) == pytest.approx(
        -stoploss_from_absolute(6000.25, 6000.0, is_short=True, leverage=50.0))


def short_with_recorded_stop(strat, rate=5995.0):
    """A short at 6000 whose stop the strategy has seen valid (strategy stop -0.5 at 50x from `rate`)."""
    trade = new_trade(short=True)
    strat.ft_stoploss_adjust(rate, trade, NOW, 0.0, 0)
    assert trade.stop_loss == pytest.approx(rate * 1.01)
    return trade


def test_a_stop_moved_through_the_price_goes_back_to_the_last_valid_stop(backtest_mode):
    strat = make_strategy(runmode="dry_run")
    trade = short_with_recorded_stop(strat)
    valid = trade.stop_loss
    trade.stop_loss = 5995.5  # re-anchored by Freqtrade to 2 ticks above the price
    strat.ft_stoploss_adjust(5995.0, trade, NOW, 0.0, 0)
    assert trade.stop_loss == pytest.approx(valid)


def test_without_a_valid_last_stop_the_stop_goes_to_the_strategy_stop_from_the_average(backtest_mode):
    strat = make_strategy(runmode="dry_run")
    trade = short_with_recorded_stop(strat)  # last valid 6054.95
    trade.stop_loss = 6054.0  # re-anchored while the price is at 6054.5
    strat.ft_stoploss_adjust(6054.5, trade, NOW, 0.0, 0)
    assert trade.stop_loss == pytest.approx(6000.0 * 1.01)  # -0.5 at 50x from the average 6000


def test_a_price_that_comes_to_an_unchanged_stop_does_not_move_it(backtest_mode):
    strat = make_strategy(runmode="dry_run")
    trade = short_with_recorded_stop(strat)
    valid = trade.stop_loss
    strat.ft_stoploss_adjust(valid - 0.25, trade, NOW, 0.0, 0)
    assert trade.stop_loss == pytest.approx(valid), "the stop fills; it is not moved away"
    long = new_trade()
    strat.ft_stoploss_adjust(6005.0, long, NOW, 0.0, 0)
    long_stop = long.stop_loss
    strat.ft_stoploss_adjust(long_stop + 0.25, long, NOW, 0.0, 0)
    assert long.stop_loss == pytest.approx(long_stop)


def test_a_long_stop_moved_through_the_price_is_repaired_too(backtest_mode):
    strat = make_strategy(runmode="dry_run")
    trade = new_trade()
    strat.ft_stoploss_adjust(6005.0, trade, NOW, 0.0, 0)
    valid = trade.stop_loss
    trade.stop_loss = 6004.5
    strat.ft_stoploss_adjust(6005.0, trade, NOW, 0.0, 0)
    assert trade.stop_loss == pytest.approx(valid)


def test_backtests_leave_a_stop_near_the_price_alone(backtest_mode):
    strat = make_strategy()
    trade = short_with_recorded_stop(strat)
    trade.stop_loss = 5995.5
    strat.ft_stoploss_adjust(5995.0, trade, NOW, 0.0, 0)
    assert trade.stop_loss == 5995.5


def test_order_filled_stores_the_planned_stop_distance(backtest_mode):
    strat = make_strategy()
    trade = new_trade()
    LocalTrade.add_bt_trade(trade)
    strat._planned_stop_ticks[PAIR] = 40
    order = add_order(trade, "buy", 1, 6000.0, NOW)
    strat.order_filled(PAIR, trade, order, NOW)
    assert trade.get_custom_data(STOP_KEY) == pytest.approx(5990.0)
    short = new_trade(short=True)
    strat._planned_stop_ticks[PAIR] = 40
    strat.order_filled(PAIR, short, add_order(short, "sell", 1, 6000.0, NOW), NOW)
    assert short.get_custom_data(STOP_KEY) == pytest.approx(6010.0)


# ---------------------------------------------------------------- position adjustment --


def adjust(strat, trade, rate=6000.0):
    return strat.adjust_trade_position(trade, NOW, rate, 0.0, None, 1e9, rate, rate, 0.0, 0.0)


def test_partial_exit_needs_at_least_two_contracts(backtest_mode):
    strat = make_strategy()
    set_guard(strat)
    one = new_trade(contracts=1)
    strat.next_adjust = -one.stake_amount * 0.5
    assert adjust(strat, one) is None
    four = new_trade(contracts=4)
    strat.next_adjust = -four.stake_amount * 0.5
    assert adjust(strat, four) == pytest.approx(-(2.001 / 4) * four.stake_amount)
    # Never the whole position: asking for all of it still leaves one contract.
    strat.next_adjust = -four.stake_amount
    assert adjust(strat, four) == pytest.approx(-(3.001 / 4) * four.stake_amount)


def test_dca_is_capped_by_the_risk_budget(backtest_mode):
    strat = make_strategy()
    set_guard(strat)  # max risk $250
    trade = new_trade(contracts=2)
    trade.set_custom_data(STOP_KEY, 5990.0)  # 10 points = $50 per contract; 2 held = $100
    strat.next_adjust = 3000.0  # worth 5 contracts at leverage 50
    # (250 - 100) / 50 = 3 more contracts
    assert adjust(strat, trade) == pytest.approx(3.001 * 5 * 6000.0 / 50.0)


def test_dca_is_capped_by_the_mini_equivalent_limit(backtest_mode):
    strat = make_strategy()
    set_guard(strat, metrics={"maxMiniEquivalent": 3, "maxRiskPerTrade": 1_000_000})
    trade = new_trade(pair=ES, contracts=2)
    trade.set_custom_data(STOP_KEY, 5999.0)
    strat.next_adjust = 3 * 50 * 6000.0 / 50.0
    assert adjust(strat, trade) == pytest.approx(1.001 * 50 * 6000.0 / 50.0)  # 3 minis - 2 held
    full = new_trade(pair=ES, contracts=3)
    assert adjust(strat, full) is None


def test_dca_is_refused_when_entries_are_not_allowed(backtest_mode):
    strat = make_strategy()
    set_guard(strat, canEnter=False, status="entries_blocked")
    trade = new_trade(contracts=1)
    strat.next_adjust = 1000.0
    assert adjust(strat, trade) is None


# ------------------------------------------------------------------- guard handling --


def test_entries_need_a_fresh_guard(backtest_mode):
    strat = make_strategy()
    assert strat._entries_allowed(NOW) == (False, "guard state unavailable")
    set_guard(strat)
    assert strat._entries_allowed(NOW + GUARD_STALE) == (True, "")
    ok, why = strat._entries_allowed(NOW + GUARD_STALE + timedelta(seconds=1))
    assert not ok and why == "guard state unavailable"


def test_a_blocked_guard_names_its_reasons(backtest_mode):
    strat = make_strategy()
    set_guard(strat, canEnter=False, status="entries_blocked", reasons=[{"code": "dll_soft"}, {"code": "no_entry_window"}])
    assert strat._entries_allowed(NOW) == (False, "entries_blocked: dll_soft, no_entry_window")


def test_a_disabled_guard_lets_entries_through(backtest_mode):
    strat = make_strategy()
    set_guard(strat, status="disabled", canEnter=False)
    assert strat._entries_allowed(NOW) == (True, "")


def test_dry_run_loop_posts_a_snapshot_and_uses_the_answer(gateway, db):
    gateway.reset()
    gateway.guard = {"status": "entries_blocked", "canEnter": False, "flatten": False,
                     "reasons": [{"code": "dll_soft"}], "metrics": {}}
    strat = make_strategy(runmode="dry_run", gateway=gateway)
    strat.bot_loop_start(NOW)
    posts = [r for r in gateway.requests if r[:2] == ("POST", "/guard/snapshot")]
    assert len(posts) == 1
    body = posts[0][3]
    assert set(body) == {"realized_total", "day_realized", "closed_results", "entries_today", "positions"}
    assert body["positions"] == [] and body["entries_today"] == 0
    assert strat._guard["status"] == "entries_blocked"
    assert not any(r[1] == "/guard" for r in gateway.requests)
    assert strat._entries_allowed(NOW) == (False, "entries_blocked: dll_soft")


def test_dry_run_snapshot_reports_open_positions(gateway, db):
    strat = make_strategy(runmode="dry_run", gateway=gateway)
    trade = new_trade(contracts=3, short=True, model=Trade)
    Trade.session.add(trade)
    Trade.commit()
    snap = strat._dry_run_snapshot(NOW)
    assert snap["positions"] == [{"pair": PAIR, "side": "short", "contracts": 3.0, "entry_price": 6000.0}]


def test_live_loop_reads_the_guard_and_never_posts_a_snapshot(gateway):
    gateway.reset()
    strat = make_strategy(runmode="live", dry_run=False, gateway=gateway)
    strat.bot_loop_start(NOW)
    assert ("GET", "/guard") in [r[:2] for r in gateway.requests]
    assert not any(r[1] == "/guard/snapshot" for r in gateway.requests)
    assert strat._guard["status"] == "active"
    assert strat._entries_allowed(NOW) == (True, "")


def test_a_gateway_failure_blocks_entries(gateway):
    gateway.reset()
    strat = make_strategy(runmode="live", dry_run=False, gateway=gateway)
    gateway.guard = None
    strat.bot_loop_start(NOW)
    assert strat._entries_allowed(NOW) == (False, "guard state unavailable")
    # A good answer, then a failing loop: the last answer is trusted for 15 s and no longer.
    gateway.guard = {"status": "active", "canEnter": True, "flatten": False, "reasons": [], "metrics": {}}
    strat.bot_loop_start(NOW)
    assert strat._entries_allowed(NOW)[0]
    gateway.guard = None
    later = NOW + timedelta(seconds=16)
    strat.bot_loop_start(later)
    assert strat._entries_allowed(later) == (False, "guard state unavailable")


def test_guard_changes_are_announced_once_after_the_first(gateway):
    gateway.reset()
    strat = make_strategy(runmode="live", dry_run=False, gateway=gateway)
    strat.bot_loop_start(NOW)
    assert strat.dp.sent == []  # the first state is only logged
    strat.bot_loop_start(NOW)
    assert strat.dp.sent == []
    gateway.guard = {"status": "entries_blocked", "canEnter": False, "flatten": False,
                     "reasons": [{"code": "dll_soft"}], "metrics": {}}
    strat.bot_loop_start(NOW)
    strat.bot_loop_start(NOW)
    assert len(strat.dp.sent) == 1 and "dll_soft" in strat.dp.sent[0]


# ------------------------------------------------------------------ backtest wiring --


def test_backtest_loop_never_touches_the_database_trades(backtest_mode, monkeypatch):
    calls = []

    def broken(*args, **kwargs):
        calls.append(kwargs)
        raise AttributeError("type object 'Trade' has no attribute 'session'")

    monkeypatch.setattr(Trade, "get_trades_proxy", staticmethod(broken))
    strat = make_strategy(runmode="backtest")
    strat.bot_start()
    LocalTrade.add_bt_trade(new_trade())
    strat.bot_loop_start(NOW)
    assert calls == []
    assert strat._guard["status"] == "active"
    assert strat._held_legs() == [(PAIR, 1.0)]
    # The same call outside a backtest does go to the database model.
    live = make_strategy(runmode="dry_run")
    with pytest.raises(AttributeError, match="session"):
        live._trades(is_open=True)
    assert len(calls) == 1


def test_trades_helper_uses_local_trades_in_hyperopt(backtest_mode):
    strat = make_strategy(runmode="hyperopt")
    trade = new_trade()
    LocalTrade.add_bt_trade(trade)
    assert strat._trades(is_open=True) == [trade]
    assert strat._trades(is_open=False) == []


def test_backtest_guard_sees_open_pnl_marked_at_the_last_close(backtest_mode):
    strat = make_strategy(runmode="backtest")
    strat.bot_start()
    LocalTrade.add_bt_trade(new_trade(contracts=2, rate=6000.0))
    strat.dp.frames[PAIR] = DataFrame({"close": [6001.0, 5800.0]})  # 200 points x $5 x 2 contracts lost
    strat.bot_loop_start(NOW)
    m = strat._guard["metrics"]
    assert m["unrealized"] == pytest.approx(-2000.0)
    assert strat._guard["status"] == "account_locked"  # 50K MLL is $2,000
    assert strat._guard["flatten"]


def test_backtest_open_pnl_falls_back_to_the_entry_price_without_candles(backtest_mode):
    strat = make_strategy(runmode="backtest")
    strat.bot_start()
    LocalTrade.add_bt_trade(new_trade(contracts=2))
    strat.bot_loop_start(NOW)
    assert strat._guard["metrics"]["unrealized"] == pytest.approx(0.0)


def test_bot_start_builds_the_guard_and_rejects_a_bad_topstep_block(backtest_mode):
    from freqtrade.exceptions import ConfigurationError

    strat = make_strategy(runmode="backtest")
    strat.bot_start()
    assert strat._bt_guard is not None
    bad = make_strategy(runmode="backtest", topstep={"phase": "auto", "preset": "auto"})
    with pytest.raises(ConfigurationError, match="Invalid topstep config"):
        bad.bot_start()


def lose_the_account(day: datetime):
    LocalTrade.add_bt_trade(new_trade(contracts=1, open_=False, close_date=day, close_profit_abs=-2500.0))


def test_bot_start_resets_state_between_hyperopt_epochs(backtest_mode):
    strat = make_strategy(runmode="hyperopt")
    strat.bot_start()
    # Epoch 1 blows the account.
    lose_the_account(NOW - timedelta(minutes=30))
    strat._planned_stop_ticks[PAIR] = 12
    strat._guard_signature = "left over from epoch 1"
    strat.bot_loop_start(NOW)
    assert strat._guard["status"] == "account_locked"
    # Epoch 2 replays the same period on the same strategy instance with no trades.
    LocalTrade.reset_trades()
    strat.bot_start()
    assert (strat._guard, strat._guard_at, strat._guard_signature, strat._planned_stop_ticks) == ({}, None, None, {})
    strat.bot_loop_start(NOW)
    assert strat._guard["status"] == "active", "the account lock of epoch 1 must not leak into epoch 2"


def test_time_going_backwards_resets_the_backtest_guard(backtest_mode):
    strat = make_strategy(runmode="hyperopt")
    strat.bot_start()
    lose_the_account(NOW - timedelta(minutes=30))
    strat.bot_loop_start(NOW)
    assert strat._guard["status"] == "account_locked"
    LocalTrade.reset_trades()
    strat.bot_loop_start(NOW - timedelta(days=1))  # next epoch starts earlier; bot_start was not called
    assert strat._guard["status"] == "active"


# -------------------------------------------------------------------- H4 should_exit --


def protection(reason):
    return ExitCheckTuple(exit_type=ExitType.CUSTOM_EXIT, exit_reason=reason)


def losing_trade():
    return new_trade(contracts=1, rate=6000.0)


def exits_for(strat, trade, rate=5990.0, **kw):
    kw.setdefault("enter", False)
    kw.setdefault("exit_", True)
    return strat.should_exit(trade, rate, NOW, **kw)


def test_flatten_comes_first_even_when_exit_profit_only_vetoes_the_exit_signal(backtest_mode):
    strat = make_strategy()
    assert strat.exit_profit_only
    trade = losing_trade()
    # Today's behaviour, no flatten: a losing trade with an exit signal stays open.
    assert exits_for(strat, trade) == []
    set_guard(strat, flatten=True, flattenReasons=["session_flat_by"])
    assert exits_for(strat, trade) == [protection("session_flat")]
    set_guard(strat, flatten=True, flattenReasons=["day_locked"])
    assert exits_for(strat, trade)[0] == protection("account_protection")
    set_guard(strat, flatten=True, flattenReasons=["account_locked"])
    assert exits_for(strat, trade)[0] == protection("account_protection")


def test_flatten_goes_ahead_of_every_other_exit(backtest_mode):
    strat = make_strategy()
    strat.stoploss = -0.001  # 6000 -> 5990 is far past it with leverage
    trade = losing_trade()
    set_guard(strat)
    plain = exits_for(strat, trade)
    assert plain and plain[0].exit_type == ExitType.STOP_LOSS
    set_guard(strat, flatten=True, flattenReasons=["session_flat_by"])
    flat = exits_for(strat, trade)
    assert flat[0] == protection("session_flat")
    assert flat[1:] == plain, "the other exits stay behind the protection exit, in their order"


def test_a_protection_exit_is_listed_once_when_custom_exit_also_returns_it(backtest_mode):
    strat = make_strategy()
    trade = new_trade(contracts=1, rate=6000.0)
    set_guard(strat, flatten=True, flattenReasons=["session_flat_by"])
    # No exit signal: Freqtrade itself asks custom_exit, which answers the same reason.
    assert exits_for(strat, trade, rate=6100.0, exit_=False) == [protection("session_flat")]


def test_exit_signal_on_a_winner_is_kept_behind_the_protection_exit(backtest_mode):
    strat = make_strategy()
    trade = new_trade(contracts=1, rate=6000.0)
    set_guard(strat, flatten=True, flattenReasons=["session_flat_by"])
    out = exits_for(strat, trade, rate=6100.0)
    assert out == [protection("session_flat"), ExitCheckTuple(ExitType.EXIT_SIGNAL)]


def test_exits_are_unchanged_without_a_protection_reason(backtest_mode):
    strat = make_strategy()
    set_guard(strat)
    trade = new_trade(contracts=1, rate=6000.0)
    winner = exits_for(strat, trade, rate=6100.0)
    assert winner == [ExitCheckTuple(ExitType.EXIT_SIGNAL)]
    assert exits_for(strat, trade, rate=6100.0, exit_=False) == []


def test_contract_roll_exit_applies_outside_backtests_only(backtest_mode):
    expired = {**MES, "daysToExpiry": -1}
    strat = make_strategy(runmode="dry_run")
    strat._markets[PAIR] = expired
    set_guard(strat)
    assert exits_for(strat, losing_trade())[0] == protection("contract_roll")
    bt = make_strategy(runmode="backtest")
    bt._markets[PAIR] = expired
    set_guard(bt)
    assert exits_for(bt, losing_trade()) == []


def test_protection_exits_are_never_vetoed_on_exit(backtest_mode):
    strat = make_strategy()
    strat.confirm_trade_exit = lambda *a, **k: False  # noqa: E731 - irrelevant: the mixin bypasses before super
    assert TopstepXMixin.confirm_trade_exit(strat, PAIR, losing_trade(), "market", 5, 5990.0, "GTC",
                                            "session_flat", NOW) is True


# ----------------------------------------------------------------- H5 cost model --

PER_SIDE = 0.37 + 0.25 + 1.25  # fee + commission + 1 tick of slippage at $1.25


def round_trip(strat, contracts, entry, exit_, short=False, model=LocalTrade):
    """Enter and exit the way the backtest engine does; the callback gets a copy of the trade."""
    trade = new_trade(contracts=contracts, rate=entry, short=short, model=model)
    if model is Trade:
        Trade.session.add(trade)
        Trade.commit()
    else:
        LocalTrade.add_bt_trade(trade)
    entry_side, exit_side = ("sell", "buy") if short else ("buy", "sell")
    order = add_order(trade, entry_side, contracts, entry, NOW)
    strategy_safe_wrapper(strat.order_filled, supress_error=True)(
        pair=PAIR, trade=trade, order=order, current_time=NOW)
    out = add_order(trade, exit_side, contracts, exit_, NOW + timedelta(minutes=5))
    trade.recalc_trade_from_orders()
    trade.close_date = NOW + timedelta(minutes=5)
    trade.close(exit_, show_msg=False)
    if model is LocalTrade:
        LocalTrade.close_bt_trade(trade)
    return trade


def test_default_costs_mirror_the_mock_gateway():
    assert COSTS_DEFAULTS == {"enabled": True, "fee_per_contract": 0.37, "commission_per_contract": 0.25,
                              "slippage_ticks": 1}


def test_backtest_round_trip_pays_fee_commission_and_slippage_on_both_sides(backtest_mode):
    strat = make_strategy(runmode="backtest")
    trade = round_trip(strat, 3, 6000.0, 6000.0)
    assert trade.close_profit_abs == pytest.approx(-2 * 3 * PER_SIDE, abs=1e-3)
    # The stored trade is changed even though Freqtrade hands the callback a deep copy.
    assert trade.fee_open == pytest.approx(PER_SIDE / (5 * 6000.0))


def test_a_winning_round_trip_nets_the_costs_off_the_gross_profit(backtest_mode):
    strat = make_strategy(runmode="backtest")
    trade = round_trip(strat, 3, 6000.0, 6010.0)
    gross = 10 * 3 * 5
    assert trade.close_profit_abs == pytest.approx(gross - 2 * 3 * PER_SIDE, abs=0.01)


def test_short_trades_pay_the_same_costs(backtest_mode):
    strat = make_strategy(runmode="backtest")
    trade = round_trip(strat, 3, 6000.0, 6000.0, short=True)
    assert trade.close_profit_abs == pytest.approx(-2 * 3 * PER_SIDE, abs=1e-3)


def test_costs_follow_the_config_values(backtest_mode):
    cfg = {"fee_per_contract": 1.0, "commission_per_contract": 0.0, "slippage_ticks": 2}
    strat = make_strategy(runmode="backtest", topstep_costs=cfg)
    trade = round_trip(strat, 2, 6000.0, 6000.0)
    assert trade.close_profit_abs == pytest.approx(-2 * 2 * (1.0 + 2 * 1.25), abs=1e-3)


def test_disabled_costs_leave_the_trade_free(backtest_mode):
    strat = make_strategy(runmode="backtest", topstep_costs={"enabled": False})
    trade = round_trip(strat, 3, 6000.0, 6000.0)
    assert trade.close_profit_abs == pytest.approx(0.0, abs=1e-9)
    assert trade.fee_open == 0.0


def test_dry_run_pays_the_costs_too(db):
    strat = make_strategy(runmode="dry_run", dry_run=True)
    trade = round_trip(strat, 3, 6000.0, 6000.0, model=Trade)
    assert trade.close_profit_abs == pytest.approx(-2 * 3 * PER_SIDE, abs=1e-3)


def test_live_trading_adds_nothing(db):
    strat = make_strategy(runmode="live", dry_run=False)
    trade = round_trip(strat, 3, 6000.0, 6000.0, model=Trade)
    assert trade.fee_open == 0.0 and trade.fee_close == 0.0
    assert trade.close_profit_abs == pytest.approx(0.0, abs=1e-9)


def test_unknown_market_adds_no_cost(backtest_mode):
    strat = make_strategy(runmode="backtest")
    strat._markets = {}
    trade = round_trip(strat, 1, 6000.0, 6000.0)
    assert trade.fee_open == 0.0


# --------------------------------------------------------------- order flow filters --


def of_strategy(**of):
    return make_strategy(topstep_orderflow={"enabled": True, **of})


def entry_frame(**cols):
    n = len(next(iter(cols.values())))
    df = DataFrame({"enter_long": [1] * n, "enter_short": [1] * n})
    for k, v in cols.items():
        df[k] = v
    return df


def test_entry_signals_need_positive_delta_for_longs_and_negative_for_shorts():
    strat = of_strategy(confirm_delta_candles=2, block_against_stacked_imbalance=False)
    df = entry_frame(of_delta=[5, -3, 4, -8, -2, 6])
    out = strat.populate_entry_trend(df, {"pair": PAIR})
    # rolling sum of the last 2 candles: 5, 2, 1, -4, -10, 4
    assert out["enter_long"].tolist() == [1, 1, 1, 0, 0, 1]
    assert out["enter_short"].tolist() == [0, 0, 0, 1, 1, 0]


def test_stacked_imbalances_block_entries_against_them():
    strat = of_strategy(confirm_delta_candles=0)
    sell = [[], [100.0], []]
    buy = [[], [], [200.0]]
    df = entry_frame(of_delta=[1, 1, 1], stacked_imbalances_bid=sell, stacked_imbalances_ask=buy)
    out = strat.populate_entry_trend(df, {"pair": PAIR})
    assert out["enter_long"].tolist() == [1, 0, 1]
    assert out["enter_short"].tolist() == [1, 1, 0]


def test_order_flow_filters_do_nothing_when_disabled_or_without_features():
    off = make_strategy()
    df = entry_frame(of_delta=[-5, -5])
    assert off.populate_entry_trend(df, {"pair": PAIR})["enter_long"].tolist() == [1, 1]
    on = of_strategy()
    plain = DataFrame({"enter_long": [1, 1]})
    assert on.populate_entry_trend(plain, {"pair": PAIR})["enter_long"].tolist() == [1, 1]


def test_confirm_entry_applies_the_order_flow_filter(backtest_mode):
    strat = of_strategy(confirm_delta_candles=3)
    set_guard(strat)
    strat.dp.frames[PAIR] = DataFrame({"close": [1.0] * 4, "of_delta": [4.0, -1.0, 2.0, 3.0]})
    assert strat._orderflow_confirms(PAIR, "long") is True  # last 3 sum to 4
    assert strat._orderflow_confirms(PAIR, "short") is False
    assert strat.confirm_trade_entry(PAIR, "market", 5, 6000.0, "GTC", NOW, None, "long") is True
    assert strat.confirm_trade_entry(PAIR, "market", 5, 6000.0, "GTC", NOW, None, "short") is False
    strat.dp.frames[PAIR] = DataFrame()
    assert strat._orderflow_confirms(PAIR, "short") is True, "no features means no filter"


def test_cvd_divergence_detects_price_extremes_the_cvd_does_not_confirm():
    strat = of_strategy(cvd_divergence_lookback=4)
    long_trade, short_trade = new_trade(), new_trade(short=True)
    # Price at a new high while the session CVD is below its high: divergence for a long.
    strat.dp.frames[PAIR] = DataFrame({"close": [1, 2, 3, 4.0], "of_cvd_session": [10, 20, 30, 25.0]})
    assert strat._cvd_divergence(PAIR, long_trade) is True
    assert strat._cvd_divergence(PAIR, short_trade) is False
    strat.dp.frames[PAIR] = DataFrame({"close": [4, 3, 2, 1.0], "of_cvd_session": [30, 20, 10, 15.0]})
    assert strat._cvd_divergence(PAIR, short_trade) is True
    assert strat._cvd_divergence(PAIR, long_trade) is False
    # CVD confirms the high: no divergence. Too little history: none either.
    strat.dp.frames[PAIR] = DataFrame({"close": [1, 2, 3, 4.0], "of_cvd_session": [10, 20, 30, 40.0]})
    assert strat._cvd_divergence(PAIR, long_trade) is False
    strat.dp.frames[PAIR] = DataFrame({"close": [1, 2.0], "of_cvd_session": [1, 0.0]})
    assert strat._cvd_divergence(PAIR, long_trade) is False


def test_cvd_divergence_exit_is_opt_in(backtest_mode):
    strat = of_strategy(cvd_divergence_lookback=4, cvd_divergence_exit=True)
    set_guard(strat)
    strat.dp.frames[PAIR] = DataFrame({"close": [1, 2, 3, 4.0], "of_cvd_session": [10, 20, 30, 25.0]})
    trade = new_trade()
    assert strat.custom_exit(PAIR, trade, NOW, 6000.0, 0.0) == "cvd_divergence"
    quiet = of_strategy(cvd_divergence_lookback=4)
    set_guard(quiet)
    quiet.dp.frames[PAIR] = strat.dp.frames[PAIR]
    assert quiet.custom_exit(PAIR, trade, NOW, 6000.0, 0.0) is None
    # A protection reason beats it.
    set_guard(strat, flatten=True, flattenReasons=["session_flat_by"])
    assert strat.custom_exit(PAIR, trade, NOW, 6000.0, 0.0) == "session_flat"


def test_stop_ticks_follow_atr_within_the_configured_range(backtest_mode):
    strat = make_strategy()
    strat.dp.frames[PAIR] = atr_frame(5.0)
    assert strat._stop_ticks(PAIR) == 40
    strat.dp.frames[PAIR] = atr_frame(1000.0)
    assert strat._stop_ticks(PAIR) == 400
    strat.dp.frames[PAIR] = DataFrame({"close": [1.0], "tsx_atr": [math.nan]})
    assert strat._stop_ticks(PAIR) == 8
    strat.dp.frames[PAIR] = pd.DataFrame()
    assert strat._stop_ticks(PAIR) == 8
