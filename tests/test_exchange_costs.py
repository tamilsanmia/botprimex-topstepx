"""Tests for the per-contract cost model on the Projectx exchange class (get_fee, dry-run order fees)."""

from __future__ import annotations

import pytest
from freqtrade.exchange.exchange import Exchange

import projectx  # noqa: F401
from projectx.costs import cost_ratio, costs_config
from projectx.ft_exchange import Projectx

PAIR = "MES/USD:USD"
MES = {"tickSize": 0.25, "tickValue": 1.25, "contractSize": 5}
PER_SIDE = 0.37 + 0.25 + 1.25


def exchange(dry_run=True, **config) -> Projectx:
    ex = Projectx.__new__(Projectx)
    ex._config = {"dry_run": dry_run, **config}
    ex._markets = {PAIR: {"symbol": PAIR, "contractSize": 5.0, "info": MES}}
    ex.get_pair_quote_currency = lambda pair: "USD"
    ex.close = lambda: None  # the instance skips __init__
    return ex


@pytest.fixture
def base_fee(monkeypatch):
    calls = []

    def fake(self, symbol, order_type="", side="", amount=1, price=1, taker_or_maker="maker"):
        calls.append((symbol, price))
        return 0.0007

    monkeypatch.setattr(Exchange, "get_fee", fake)
    return calls


def test_cost_ratio_charges_the_dollar_cost_at_the_given_price():
    ratio = cost_ratio(costs_config({}), MES, 6000.0)
    assert ratio == pytest.approx(PER_SIDE / (5 * 6000.0))
    # One contract is 5 x 6000 = 30,000 of notional: the ratio gives back the dollars.
    assert ratio * 5 * 6000.0 == pytest.approx(PER_SIDE)
    assert cost_ratio({**costs_config({}), "enabled": False}, MES, 6000.0) is None
    assert cost_ratio(costs_config({}), None, 6000.0) is None
    assert cost_ratio(costs_config({}), {"tickValue": 1.25}, 6000.0) is None
    assert cost_ratio(costs_config({}), MES, 0) is None


def test_get_fee_with_a_price_is_the_per_contract_ratio(base_fee):
    ex = exchange()
    assert ex.get_fee(PAIR, "market", "buy", 3, 6000.0, "taker") == pytest.approx(PER_SIDE / 30000.0)
    assert base_fee == []


def test_get_fee_without_a_price_or_for_an_unknown_market_costs_nothing(base_fee):
    ex = exchange()
    assert ex.get_fee(PAIR, taker_or_maker="maker") == 0.0
    assert ex.get_fee("NQ/USD:USD", price=20000.0) == 0.0
    assert base_fee == []


def test_costs_follow_the_topstep_costs_block(base_fee):
    ex = exchange(topstep_costs={"fee_per_contract": 1.0, "commission_per_contract": 0.0, "slippage_ticks": 0})
    assert ex.get_fee(PAIR, price=6000.0) == pytest.approx(1.0 / 30000.0)


def test_live_trading_and_disabled_costs_use_the_exchange_fee(base_fee):
    assert exchange(dry_run=False).get_fee(PAIR, price=6000.0) == 0.0007
    assert exchange(topstep_costs={"enabled": False}).get_fee(PAIR, price=6000.0) == 0.0007
    assert len(base_fee) == 2


def test_dry_run_orders_carry_the_cost_of_their_fill_price():
    ex = exchange()
    order = {"type": "market", "side": "buy", "amount": 15.0, "price": 6000.0, "average": 6000.5,
             "cost": 15.0 * 6000.5}
    out = ex.add_dry_order_fee(PAIR, order, "taker")
    assert out is order
    assert out["fee"]["currency"] == "USD"
    assert out["fee"]["rate"] == pytest.approx(PER_SIDE / (5 * 6000.5))
    assert out["fee"]["cost"] == pytest.approx(3 * PER_SIDE)  # 3 contracts


def test_dry_run_orders_are_free_when_costs_are_off():
    ex = exchange(topstep_costs={"enabled": False})
    ex.get_fee = lambda *a, **k: 0.0  # the base class would need a loaded ccxt market
    order = {"type": "limit", "side": "sell", "amount": 5.0, "price": 6000.0, "cost": 30000.0}
    assert ex.add_dry_order_fee(PAIR, order, "maker")["fee"]["cost"] == 0.0
