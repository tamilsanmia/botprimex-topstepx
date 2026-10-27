"""
Tests for the projectx Python adapter against an in-process fake gateway.

Run inside the custom image (it has Freqtrade, ccxt and aiohttp):

    docker run --rm -v "$PWD/tests:/tests:ro" --entrypoint bash botprimex/freqtrade-projectx:latest \
      -c "pip install --user -q pytest && python -m pytest -q /tests"
"""

from __future__ import annotations

import asyncio

import ccxt
import ccxt.async_support
import ccxt.pro
import pytest

import projectx  # noqa: F401
from projectx.ft_exchange import Projectx

def make_sync(gateway):
    return ccxt.projectx({"options": {"gatewayUrl": gateway.url}})


def test_registered_in_all_ccxt_flavours():
    assert "projectx" in ccxt.exchanges
    assert hasattr(ccxt.async_support, "projectx")
    assert hasattr(ccxt.pro, "projectx")


def test_freqtrade_exchange_validation_accepts_projectx():
    # check_exchange instantiates every flavour with no config at all.
    from freqtrade.exchange import validate_exchange

    valid, reason, _, _ = validate_exchange("projectx")
    assert valid, reason
    for module in (ccxt, ccxt.async_support, ccxt.pro):
        assert module.projectx().id == "projectx"


def test_markets_are_linear_usd_swaps_in_whole_contracts(gateway):
    ex = make_sync(gateway)
    m = ex.load_markets()["MES/USD:USD"]
    assert (m["type"], m["swap"], m["linear"], m["settle"]) == ("swap", True, True, "USD")
    assert m["contractSize"] == 5.0
    assert m["precision"] == {"amount": 1.0, "price": 0.25}
    assert ex.amount_to_precision("MES/USD:USD", 2.9) == "2"
    assert ex.price_to_precision("MES/USD:USD", 6000.13) == "6000.25"


def test_secret_header_and_order_body(gateway):
    ex = make_sync(gateway)
    order = ex.create_order("MES/USD:USD", "market", "sell", 2, None, {"reduceOnly": True, "junk": object()})
    assert order["status"] == "closed"
    method, path, _, body = gateway.requests[-1]
    assert (method, path) == ("POST", "/order")
    assert body["params"] == {"reduceOnly": True}
    assert body["amount"] == 2


def test_gateway_errors_map_to_ccxt_exceptions(gateway):
    ex = make_sync(gateway)
    with pytest.raises(ccxt.InvalidOrder, match="overlap"):
        ex.create_order("ES/USD:USD", "market", "buy", 1)
    with pytest.raises(ccxt.RateLimitExceeded):
        ex.gateway.get("/limited")
    with pytest.raises(ccxt.ExchangeError):
        ex.gateway.get("/weird")
    bad = ccxt.projectx({"options": {"gatewayUrl": gateway.url}})
    bad.gateway.secret = "wrong"
    bad.gateway._session = None
    with pytest.raises(ccxt.AuthenticationError):
        bad.fetch_balance()
    down = ccxt.projectx({"options": {"gatewayUrl": "http://127.0.0.1:1"}})
    with pytest.raises(ccxt.ExchangeNotAvailable):
        down.fetch_ticker("MES/USD:USD")


def test_async_candles(gateway):
    async def run():
        ex = ccxt.async_support.projectx({"options": {"gatewayUrl": gateway.url}})
        try:
            return await ex.fetch_ohlcv("MES/USD:USD", "1s", since=0, limit=5)
        finally:
            await ex.close()

    bars = asyncio.run(run())
    assert bars == [[1_000_000, 1, 2, 0.5, 1.5, 10]]
    _, path, query, _ = gateway.requests[-1]
    assert path == "/ohlcv" and query["timeframe"] == "1s"


def test_pro_watch_ohlcv_merges_live_updates(gateway):
    async def run():
        ex = ccxt.pro.projectx({"options": {"gatewayUrl": gateway.url}})
        seen = []
        try:
            for _ in range(3):
                candles = await asyncio.wait_for(ex.watch_ohlcv("MES/USD:USD", "1s"), 5)
                seen.append([list(c) for c in candles])
        finally:
            await ex.close()
        return ex, seen

    ex, seen = asyncio.run(run())
    assert len(seen[-1]) == 1, "same-timestamp updates replace the candle"
    assert seen[-1][0][5] == 3
    assert ex.ohlcvs["MES/USD:USD"]["1s"][0][4] == 3


def test_freqtrade_exchange_allows_seconds_timeframes_and_has_no_funding():
    from freqtrade.enums import TradingMode
    from freqtrade.exchange.exchange import Exchange

    ex = Projectx.__new__(Projectx)

    class Api:
        timeframes = {"1s": "1s", "5m": "5m"}
        options = {"maxLeverage": 40}

    ex._api = Api()
    ex._config = {}
    ex.trading_mode = TradingMode.FUTURES
    ex._ft_has = {**Exchange._ft_has_default, **Projectx._ft_has}
    ex.close = lambda: None
    Projectx.validate_timeframes(ex, "1s")
    with pytest.raises(Exception, match="Invalid timeframe"):
        Projectx.validate_timeframes(ex, "7m")
    assert Projectx.get_max_leverage(ex, "MES/USD:USD", None) == 40.0
    assert Projectx.get_funding_fees(ex, "MES/USD:USD", 1.0, False, None) == 0.0
    assert Projectx.get_liquidation_price(ex, "MES/USD:USD") is None
    assert Projectx._ft_has["ws_enabled"] and Projectx._ft_has["trades_has_history"]
    assert Projectx._ft_has["stoploss_order_types"]["market"] == "stop"
