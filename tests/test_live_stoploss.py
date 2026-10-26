"""
Live stoploss handling on the Projectx exchange class, replayed through Freqtrade's own bot
methods (tests/ft_harness.py) with the values of the first live trade (2026-10-26 07:56).
"""

from __future__ import annotations

import pytest
from freqtrade.exchange.exchange import Exchange
from freqtrade.persistence import Trade, init_db

import ft_harness as h
from projectx.ft_exchange import Projectx, report_stop_as_open


@pytest.fixture
def db():
    init_db("sqlite://")
    yield
    Trade.session.remove()


# --------------------------------------------------------------- report_stop_as_open --


def test_a_closed_stop_is_reported_open_with_nothing_filled():
    closed = h.filled_stop()
    closed["fee"] = {"cost": 1.0, "currency": "USD"}
    reported = report_stop_as_open(closed)
    assert reported["status"] == "open"
    assert (reported["filled"], reported["remaining"], reported["average"], reported["cost"]) == (0.0, 4.0, None, 0.0)
    assert reported["fee"] is None and reported["trades"] == [] and reported["lastTradeTimestamp"] is None
    assert reported["info"]["projectx_status_on_create"] == "closed"
    assert (reported["id"], reported["stopPrice"], reported["amount"]) == (closed["id"], closed["stopPrice"], 4.0)
    assert closed["status"] == "closed" and closed["filled"] == 4.0, "the original answer is not modified"


@pytest.mark.parametrize("status", ["open", "canceled", "rejected"])
def test_other_stop_states_are_unchanged(status):
    order = dict(h.filled_stop(), status=status)
    assert report_stop_as_open(order) is order


@pytest.mark.parametrize("dry_run, status", [(False, "open"), (True, "closed")])
def test_create_stoploss_reports_a_filled_stop_as_open_only_when_live(monkeypatch, dry_run, status):
    monkeypatch.setattr(Exchange, "create_stoploss", lambda self, *a, **k: h.filled_stop())
    ex = h.StubExchange(dry_run=dry_run)
    ex.fetch_ticker = lambda pair: {}  # no quote: the stop price is not touched
    order = ex.create_stoploss(h.PAIR, 4.0, 29104.25, {"stoploss": "market"}, "buy", 50.0)
    assert order["status"] == status


# ------------------------------------------------------- the stop fill closes the trade --


def two_entry_trade(bot):
    trade = h.short_mnq_trade()
    h.fill_entry(bot, trade, h.ENTRY_ID, h.ENTRY_PRICE, h.T0, ask=29100.25)
    h.fill_entry(bot, trade, h.DCA_ID, h.DCA_PRICE, h.T0, ask=h.STOP_FILL)
    assert trade.amount == 4.0
    return trade


def assert_closed_by_the_stop(trade):
    assert not trade.is_open
    assert trade.exit_reason == "stoploss_on_exchange"
    assert trade.close_rate == h.STOP_FILL
    assert trade.amount == 4.0
    # 1 MNQ x (29099.5 - 29102.75) x $2 + 1 MNQ x (29102.25 - 29102.75) x $2, fees stubbed to 0
    assert trade.close_profit_abs == pytest.approx(-7.5)


def test_a_stop_filled_on_placement_closes_the_trade_on_the_next_stoploss_check(db, monkeypatch):
    ex = h.StubExchange()
    bot = h.make_bot(monkeypatch, h.make_strategy(), ex)
    trade = two_entry_trade(bot)
    ex.stop_response = lambda amount, stop: h.filled_stop(amount, stop)

    assert bot.create_stoploss_order(trade, 29104.25) is True
    assert [o.order_id for o in trade.open_sl_orders] == [h.STOP_ID]
    assert trade.is_open

    ex.orders[h.STOP_ID] = h.filled_stop()
    assert bot.handle_stoploss_on_exchange(trade) is True
    assert_closed_by_the_stop(trade)
    assert len(ex.created) == 1
    assert bot.emergency_exits == []


def test_a_resting_stop_that_fills_later_closes_the_trade_the_same_way(db, monkeypatch):
    ex = h.StubExchange()
    bot = h.make_bot(monkeypatch, h.make_strategy(), ex)
    trade = two_entry_trade(bot)
    resting = dict(h.filled_stop(), status="open", filled=0.0, remaining=4.0, average=None, cost=0)
    ex.stop_response = lambda amount, stop: dict(resting, stopPrice=stop)

    assert bot.create_stoploss_order(trade, 29104.25) is True
    ex.orders[h.STOP_ID] = dict(resting)
    assert bot.handle_stoploss_on_exchange(trade) is False
    assert trade.is_open and len(trade.open_sl_orders) == 1

    ex.orders[h.STOP_ID] = h.filled_stop()
    assert bot.handle_stoploss_on_exchange(trade) is True
    assert_closed_by_the_stop(trade)
    assert len(ex.created) == 1
    assert bot.emergency_exits == []
