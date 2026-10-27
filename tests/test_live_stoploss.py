"""
Live stoploss handling on the Projectx exchange class, replayed through Freqtrade's own bot
methods (tests/ft_harness.py) with the values of the first live trade (2026-10-26 07:56).
"""

from __future__ import annotations

import pytest
from freqtrade.exchange.exchange import Exchange
from freqtrade.persistence import Trade, init_db

import ft_harness as h
from freqtrade.freqtradebot import FreqtradeBot
from freqtrade.persistence import Order
from projectx.ft_exchange import Projectx, _patch_onexchange_recovery, report_stop_as_open
from projectx.strategy_mixin import STOP_KEY


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


# ------------------------------------------------- recovery of a trade that is already flat --


@pytest.fixture
def recovery(monkeypatch):
    """Installs the recovery wrapper for one test; monkeypatch restores Freqtrade's method afterwards."""
    original = FreqtradeBot.handle_onexchange_order
    monkeypatch.setattr(FreqtradeBot, "handle_onexchange_order", original)
    _patch_onexchange_recovery()
    return original


def stop_stored_as_closed(bot, trade):
    """What Freqtrade did before the fix: the stop filled on placement was stored as not open."""
    stop = h.filled_stop()
    trade.orders.append(Order.parse_from_ccxt_object(stop, trade.pair, "stoploss", trade.amount, 29102.25))
    Trade.commit()
    bot.exchange.on_exchange = [o.to_ccxt_object("stopPrice") | {"side": o.side} for o in trade.orders]
    return stop


def test_the_patch_wraps_once(recovery):
    wrapped = FreqtradeBot.handle_onexchange_order
    _patch_onexchange_recovery()
    assert FreqtradeBot.handle_onexchange_order is wrapped
    assert wrapped is not recovery and wrapped._projectx_recovery is True


def test_a_trade_whose_fills_net_to_zero_is_closed_instead_of_recovered(db, monkeypatch, recovery):
    ex = h.StubExchange()
    bot = h.make_bot(monkeypatch, h.make_strategy(), ex)
    trade = h.incident_trade(bot)
    stop_stored_as_closed(bot, trade)
    assert trade.is_open and trade.open_sl_orders == []
    bot.notified_exits.clear()  # the entry fills

    assert bot.handle_onexchange_order(trade) is False
    assert_closed_by_the_stop(trade)
    assert trade.close_date_utc == trade.orders[-1].order_filled_utc
    assert bot.notified_exits == [("exit", "stoploss", True)]
    assert bot.protections_handled == [h.PAIR]

    # Again (FreqUI "reload trade"): no error, still closed, nothing more sent.
    bot.handle_onexchange_order(trade)
    assert_closed_by_the_stop(trade)
    assert [n for n in bot.notified_exits if n[0] == "exit" or n[2]] == [("exit", "stoploss", True)]


def test_a_trade_left_open_by_freqtrades_recovery_is_closed_on_the_next_call(db, monkeypatch, recovery):
    ex = h.StubExchange()
    bot = h.make_bot(monkeypatch, h.make_strategy(), ex)
    trade = h.incident_trade(bot)
    stop_stored_as_closed(bot, trade)
    recovery(bot, trade)  # Freqtrade's own recovery, as it ran live
    assert trade.is_open and trade.amount == 2.0 and trade.open_rate == h.DCA_PRICE, "the live corruption"

    assert bot.handle_onexchange_order(trade) is False
    assert_closed_by_the_stop(trade)


def test_without_a_filled_exit_the_recovery_is_freqtrades(db, monkeypatch, recovery):
    ex = h.StubExchange()
    bot = h.make_bot(monkeypatch, h.make_strategy(), ex)
    trade = h.short_mnq_trade()
    h.fill_entry(bot, trade, h.ENTRY_ID, h.ENTRY_PRICE, h.T0, ask=29100.25)
    ex.on_exchange = [o.to_ccxt_object("stopPrice") | {"side": o.side} for o in trade.orders]
    bot.notified_exits.clear()  # the entry fill

    assert bot.handle_onexchange_order(trade) is False
    assert trade.is_open and trade.amount == 2.0
    assert [n for n in bot.notified_exits if n[0] == "exit" or n[2]] == [], "nothing sent"
    assert bot.protections_handled == []


# ------------------------------------------------ never a stop at or through the market --


class AtrDcaStrategy(h.HarnessStrategy):
    """A signal-DCA strategy with an ATR stop on adds: no stored stop on the first entry, 8 ticks from each add."""

    def order_filled(self, pair, trade, order, current_time, **kwargs):
        if order.ft_order_side == trade.entry_side and len(trade.select_filled_orders(trade.entry_side)) >= 2:
            trade.set_custom_data(STOP_KEY, order.safe_price + 8 * h.TICK)


def test_the_live_dca_never_leaves_the_stop_at_or_through_the_ask(db, monkeypatch):
    strat = h.prepare_strategy(AtrDcaStrategy(h.strategy_config()))
    ex = h.StubExchange()
    bot = h.make_bot(monkeypatch, strat, ex)
    trade = h.short_mnq_trade()
    h.fill_entry(bot, trade, h.ENTRY_ID, h.ENTRY_PRICE, h.T0, ask=29100.25)
    h.fill_entry(bot, trade, h.DCA_ID, h.DCA_PRICE, h.T0, ask=h.STOP_FILL, tag="signal_dca")
    assert trade.stop_loss == 29104.25, "DCA pass 1, as live"
    bot.update_trade_state(trade, h.DCA_ID, trade.orders[-1].to_ccxt_object("stopPrice"), send_msg=False)
    # Live, pass 2 re-anchored the stop to 29102.25, below the ask.
    assert trade.stop_loss >= h.STOP_FILL + 4 * h.TICK
    assert trade.stop_loss == 29104.25

    ex.stop_response = lambda amount, stop: dict(h.filled_stop(amount, stop), status="open", filled=0.0,
                                                 remaining=amount, average=None, cost=0)
    bot.handle_stoploss_on_exchange(trade)
    assert ex.created == [(4.0, 29104.25)]


def test_with_the_minimum_distance_off_the_dca_reproduces_the_live_stop(db, monkeypatch):
    strat = h.prepare_strategy(AtrDcaStrategy(h.strategy_config(topstep_strategy={"stop_min_distance_ticks": 0})))
    bot = h.make_bot(monkeypatch, strat, h.StubExchange())
    trade = h.short_mnq_trade()
    h.fill_entry(bot, trade, h.ENTRY_ID, h.ENTRY_PRICE, h.T0, ask=29100.25)
    h.fill_entry(bot, trade, h.DCA_ID, h.DCA_PRICE, h.T0, ask=h.STOP_FILL, tag="signal_dca", passes=2)
    assert trade.stop_loss == 29102.25


@pytest.mark.parametrize("side, stop, expected", [
    ("buy", 29102.25, 29103.75),  # the live stop: below the ask 29102.75
    ("buy", 29103.5, 29103.75),   # 3 ticks above the ask
    ("buy", 29104.25, 29104.25),  # far enough
    ("sell", 29102.5, 29101.5),   # long: above min(bid, last) 29102.5 - 4 ticks
    ("sell", 29100.0, 29100.0),
])
def test_the_exchange_moves_a_stop_that_would_fill_on_placement(side, stop, expected):
    ex = h.StubExchange(ask=29102.75)  # bid and last 29102.5
    assert ex._guard_stop_price(h.PAIR, stop, side) == expected


def test_the_exchange_reads_the_minimum_distance_from_the_config():
    ex = h.StubExchange(ask=29102.75, config={"topstep_strategy": {"stop_min_distance_ticks": 8}})
    assert ex._guard_stop_price(h.PAIR, 29102.25, "buy") == 29104.75
    off = h.StubExchange(ask=29102.75, config={"topstep_strategy": {"stop_min_distance_ticks": 0}})
    assert off._guard_stop_price(h.PAIR, 29102.25, "buy") == 29102.25


def test_without_a_quote_the_stop_is_placed_as_asked():
    ex = h.StubExchange()
    ex.ticker_error = RuntimeError("no ticker")
    assert ex._guard_stop_price(h.PAIR, 29102.25, "buy") == 29102.25
    ex.ticker_error = None
    ex.fetch_ticker = lambda pair: {"ask": None, "bid": None, "last": None}
    assert ex._guard_stop_price(h.PAIR, 29102.25, "buy") == 29102.25


def test_create_stoploss_sends_the_moved_price(monkeypatch):
    sent = []
    monkeypatch.setattr(Exchange, "create_stoploss",
                        lambda self, pair, amount, stop_price, *a, **k: sent.append(stop_price) or {"status": "open"})
    h.StubExchange(ask=29102.75).create_stoploss(h.PAIR, 4.0, 29102.25, {"stoploss": "market"}, "buy", 50.0)
    assert sent == [29103.75]


def test_the_exchange_default_matches_the_strategy_default():
    import inspect

    from projectx.strategy_mixin import STRATEGY_DEFAULTS

    source = inspect.getsource(Projectx._guard_stop_price)
    assert f'.get("stop_min_distance_ticks", {STRATEGY_DEFAULTS["stop_min_distance_ticks"]})' in source
