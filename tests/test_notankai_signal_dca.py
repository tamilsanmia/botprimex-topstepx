"""
NoTankAi_TopstepX signal DCA: the stop after an add (dca_stop), the add's risk sizing and the
idempotent order_filled, on the values of the first live trade (2026-10-26 07:56, short MNQ).
"""

from __future__ import annotations

import logging
import sys
from datetime import timedelta

import pandas as pd
import pytest
from freqtrade.exceptions import OperationalException
from freqtrade.persistence import Order, Trade, init_db
from freqtrade.strategy import stoploss_from_absolute

import ft_harness as h
from projectx.ft_exchange import report_stop_as_open
from projectx.strategy_mixin import STOP_KEY

sys.path.insert(0, "/strategies")
try:
    from NoTankAI_TopstepX import DCA_FILLED_KEY, SIGNAL_DCA_DEFAULTS, NoTankAi_TopstepX  # noqa: E402
except ImportError:  # strategies are not in the repo; tests/run_python_tests.sh mounts user_data/strategies
    pytest.skip("NoTankAI_TopstepX strategy not available in /strategies", allow_module_level=True)

SIGNAL_DCA = {"enabled": True, "first_contracts": 1, "max_adds": 2, "only_in_loss": True, "target_atr_mult": 1.0}


@pytest.fixture
def db():
    init_db("sqlite://")
    yield
    Trade.session.remove()


def make_strategy(dca_stop=None, **signal_dca):
    sd = {**SIGNAL_DCA, **signal_dca}
    if dca_stop is not None:
        sd["dca_stop"] = dca_stop
    strat = NoTankAi_TopstepX(h.strategy_config(strategy="NoTankAi_TopstepX", topstep_strategy={"signal_dca": sd}))
    h.prepare_strategy(strat)
    return strat


def set_guard(strat, max_risk=250):
    strat._guard = {"status": "active", "canEnter": True, "flatten": False, "reasons": [],
                    "metrics": {"maxMiniEquivalent": 5, "maxRiskPerTrade": max_risk}}
    strat._guard_at = h.T0


def counting(strat):
    """Records order_filled calls and every change to the trade's custom data they make."""
    calls, changes = [], []
    original = strat.order_filled

    def wrapped(pair, trade, order, current_time, **kw):
        before = (trade.get_custom_data(STOP_KEY), trade.get_custom_data(DCA_FILLED_KEY))
        original(pair, trade, order, current_time, **kw)
        after = (trade.get_custom_data(STOP_KEY), trade.get_custom_data(DCA_FILLED_KEY))
        calls.append(order.order_id)
        if after != before:
            changes.append(order.order_id)

    strat.order_filled = wrapped
    return calls, changes


# ---------------------------------------------------------------------------- config --


def test_the_default_dca_stop_is_the_strategy_stoploss():
    assert SIGNAL_DCA_DEFAULTS["dca_stop"] == "strategy"
    assert make_strategy().signal_dca["dca_stop"] == "strategy"
    assert make_strategy("atr").signal_dca["dca_stop"] == "atr"


def test_an_unknown_dca_stop_is_refused():
    with pytest.raises(OperationalException, match="dca_stop"):
        make_strategy("trailing")


# ---------------------------------------------------------------- "strategy" stop --


def test_with_the_strategy_stop_a_dca_fill_stores_no_atr_stop(db, monkeypatch):
    strat = make_strategy()
    bot = h.make_bot(monkeypatch, strat, h.StubExchange())
    trade = h.incident_trade(bot, "NoTankAi_TopstepX")
    assert trade.get_custom_data(STOP_KEY) is None
    assert trade.get_custom_data(DCA_FILLED_KEY) == h.DCA_ID
    assert trade.open_rate == 29101.0  # 29100.875 at tick precision


def test_custom_stoploss_after_an_add_is_the_strategy_stop_from_the_average(db, monkeypatch):
    strat = make_strategy()
    bot = h.make_bot(monkeypatch, strat, h.StubExchange())
    trade = h.incident_trade(bot, "NoTankAi_TopstepX")
    ratio = strat.custom_stoploss(h.PAIR, trade, h.T0, h.STOP_FILL, 0.0, False)
    stop = h.STOP_FILL * (1 + abs(ratio) / trade.leverage)
    assert stop == pytest.approx(29101.0 * 1.002, abs=h.TICK)
    assert trade.stop_loss == pytest.approx(29101.0 * 1.002, abs=h.TICK)


def test_the_first_entry_keeps_the_strategy_stoploss_as_a_ratio(db, monkeypatch):
    strat = make_strategy()
    bot = h.make_bot(monkeypatch, strat, h.StubExchange())
    trade = h.short_mnq_trade("NoTankAi_TopstepX")
    h.fill_entry(bot, trade, h.ENTRY_ID, h.ENTRY_PRICE, h.T0, ask=29100.25)
    assert strat.custom_stoploss(h.PAIR, trade, h.T0, 29100.25, 0.0, False) == -0.1
    assert trade.get_custom_data(STOP_KEY) is None


def dca_frame(close=29102.5):
    """A short signal that switched on after the first fill."""
    dates = [h.T0 + timedelta(seconds=i) for i in range(1, 4)]
    return pd.DataFrame({"date": dates, "close": [close] * 3, "tsx_atr": [1.0] * 3, "enter_short": [0, 1, 1]})


def held_short(strat, contracts=1, rate=h.ENTRY_PRICE):
    trade = h.short_mnq_trade("NoTankAi_TopstepX")
    trade.amount = contracts * 2.0
    order = h.ccxt_order(h.ENTRY_ID, "sell", "market", "closed", contracts * 2.0, contracts * 2.0, rate, h.T0)
    trade.orders.append(Order.parse_from_ccxt_object(order, h.PAIR, "sell"))
    trade.recalc_trade_from_orders()
    Trade.commit()
    return trade


def adjust(strat, trade, rate):
    profit = trade.calc_profit_ratio(rate)
    return strat.adjust_trade_position(trade, h.T0 + timedelta(seconds=10), rate, profit, None, 1e9, rate, rate,
                                       profit, profit)


def test_the_add_is_sized_by_the_loss_to_the_strategy_stop(db):
    strat = make_strategy(target_points=0.25)  # needs many contracts to pull the average in
    strat.dp.frame = dca_frame()
    set_guard(strat, max_risk=250)
    trade = held_short(strat)
    # +1: 0.2% x avg 29101.1 x 2 contracts x $2 = $233 <= 250; +2: 3 contracts = $349 > 250.
    stake, tag = adjust(strat, trade, h.STOP_FILL)
    assert tag == "signal_dca"
    assert stake == pytest.approx(strat._stake_for(h.PAIR, 1, h.STOP_FILL, 50.0))
    set_guard(strat, max_risk=349.3)
    stake, _ = adjust(strat, trade, h.STOP_FILL)
    assert stake == pytest.approx(strat._stake_for(h.PAIR, 2, h.STOP_FILL, 50.0))
    set_guard(strat, max_risk=230)
    assert adjust(strat, trade, h.STOP_FILL) is None


# --------------------------------------------------------------------- "atr" stop --


def test_with_the_atr_stop_the_old_behaviour_stays(db, monkeypatch):
    strat = make_strategy("atr")
    bot = h.make_bot(monkeypatch, strat, h.StubExchange())
    trade = h.incident_trade(bot, "NoTankAi_TopstepX")
    assert trade.get_custom_data(STOP_KEY) == h.DCA_PRICE + 8 * h.TICK  # 8 ticks from the fill
    ratio = strat.custom_stoploss(h.PAIR, trade, h.T0, h.STOP_FILL, 0.0, False)
    assert ratio == pytest.approx(-stoploss_from_absolute(29104.25, h.STOP_FILL, is_short=True, leverage=50.0))


def test_with_the_atr_stop_the_add_is_sized_by_the_risk_to_that_stop(db):
    strat = make_strategy("atr", target_points=0.25)
    strat.dp.frame = dca_frame()
    set_guard(strat, max_risk=250)
    trade = held_short(strat)
    # stop 29104.75 (8 ticks): existing (29104.75 - 29099.5) x 1 x 2 = $10.5, $4 per contract more.
    stake, _ = adjust(strat, trade, h.STOP_FILL)
    assert stake == pytest.approx(strat._stake_for(h.PAIR, 9, h.STOP_FILL, 50.0))  # max_contracts 10 - 1 held
    assert strat._dca_stop_ticks[trade.id] == 8


# ------------------------------------------------------------------ order_filled --


@pytest.mark.parametrize("dca_stop", ["strategy", "atr"])
def test_order_filled_acts_once_per_add(db, monkeypatch, caplog, dca_stop):
    caplog.set_level(logging.INFO)
    strat = make_strategy(dca_stop)
    calls, changes = counting(strat)
    bot = h.make_bot(monkeypatch, strat, h.StubExchange())
    trade = h.incident_trade(bot, "NoTankAi_TopstepX")  # the DCA fill is applied twice
    stored = trade.get_custom_data(STOP_KEY)
    # Order recovery re-applies the first entry and the add.
    for oid in (h.ENTRY_ID, h.DCA_ID):
        bot.update_trade_state(trade, oid, trade.select_order_by_order_id(oid).to_ccxt_object("stopPrice"),
                               send_msg=False)
    assert calls == [h.ENTRY_ID, h.DCA_ID, h.DCA_ID, h.ENTRY_ID, h.DCA_ID]
    assert changes == [h.DCA_ID], "custom data changes once, on the first call for the add"
    assert trade.get_custom_data(STOP_KEY) == stored
    assert sum("DCA filled at" in r.getMessage() for r in caplog.records) == 1


# --------------------------------------------------------------- the live incident --


@pytest.mark.parametrize("dca_stop", ["strategy", "atr"])
def test_the_live_incident_closes_by_the_stop_and_never_places_it_at_the_ask(db, monkeypatch, dca_stop):
    strat = make_strategy(dca_stop)
    calls, changes = counting(strat)
    ex = h.StubExchange()
    bot = h.make_bot(monkeypatch, strat, ex)
    trade = h.incident_trade(bot, "NoTankAi_TopstepX")
    assert trade.stop_loss >= h.STOP_FILL + 4 * h.TICK

    # The gateway answers a filled stop (status closed), as it did live.
    ex.stop_response = lambda amount, stop: h.filled_stop(amount, stop)
    assert bot.handle_stoploss_on_exchange(trade) is False
    assert len(ex.created) == 1 and ex.created[0][1] >= h.STOP_FILL + 4 * h.TICK
    assert [o.order_id for o in trade.open_sl_orders] == [h.STOP_ID], "reported open, so it is fetched"

    ex.orders[h.STOP_ID] = h.filled_stop()
    assert bot.handle_stoploss_on_exchange(trade) is True
    assert not trade.is_open
    assert (trade.exit_reason, trade.close_rate, trade.amount) == ("stoploss_on_exchange", h.STOP_FILL, 4.0)
    assert trade.close_profit_abs == pytest.approx(-7.5)
    assert bot.emergency_exits == [] and len(ex.created) == 1
    assert len(changes) == len(set(changes)) <= 1, "custom data changes at most once per order"
    assert report_stop_as_open(h.filled_stop())["status"] == "open"
