"""
Tests for the projectx Python adapter against an in-process fake gateway.

Run inside the custom image (it has Freqtrade, ccxt and aiohttp):

    docker run --rm -v "$PWD/tests:/tests:ro" --entrypoint bash botprimex/freqtrade-projectx:latest \
      -c "pip install --user -q pytest && python -m pytest -q /tests"
"""

from __future__ import annotations

import asyncio
import json
import threading
import time

import ccxt
import ccxt.async_support
import ccxt.pro
import pytest
from aiohttp import web

import projectx  # noqa: F401
from projectx.ft_exchange import Projectx

SECRET = "test-secret"
MARKET = {
    "symbol": "MES/USD:USD", "root": "MES", "contractId": "CON.F.US.MES.Z26", "name": "MESZ6",
    "tickSize": 0.25, "tickValue": 1.25, "contractSize": 5, "active": True,
    "lot": {"class": "micro", "weight": 0.1, "group": "S&P"}, "daysToExpiry": 50,
}


class FakeGateway:
    def __init__(self):
        self.requests: list[tuple[str, str, dict, object]] = []
        self.port = None
        self.loop = asyncio.new_event_loop()
        self.ready = threading.Event()

    def app(self):
        app = web.Application()

        async def handler(request: web.Request):
            body = await request.json() if request.can_read_body else None
            self.requests.append((request.method, request.path, dict(request.query), body))
            if request.path != "/health" and request.headers.get("X-Gateway-Secret") != SECRET:
                return web.json_response({"error": "Bad secret", "kind": "AuthenticationError"}, status=401)
            p = request.path
            if p == "/health":
                return web.json_response({"ok": True, "ready": True})
            if p == "/markets":
                return web.json_response([MARKET])
            if p == "/ohlcv":
                return web.json_response([[1_000_000, 1, 2, 0.5, 1.5, 10]])
            if p == "/ticker":
                return web.json_response({"symbol": "MES/USD:USD", "last": 6000, "bid": 5999.75, "ask": 6000.25})
            if p == "/order" and request.method == "POST":
                if body["symbol"] == "ES/USD:USD":
                    return web.json_response({"error": "Refused by account protection: overlap", "kind": "InvalidOrder"}, status=400)
                return web.json_response({"id": "1", "status": "closed", "filled": body["amount"], "average": 6000.25})
            if p == "/positions":
                return web.json_response([])
            if p == "/balance":
                return web.json_response({"USD": {"free": 50000, "used": 0, "total": 50000}})
            if p == "/limited":
                return web.json_response({"error": "slow down"}, status=429)
            if p == "/weird":
                return web.json_response({"error": "odd", "kind": "NotAnException"}, status=500)
            return web.json_response({"error": "no route", "kind": "BadRequest"}, status=404)

        async def ws_handler(request: web.Request):
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            async for msg in ws:
                sub = json.loads(msg.data)
                for i in range(3):
                    await ws.send_str(json.dumps({
                        "channel": "ohlcv", "symbol": sub["symbol"], "timeframe": sub["timeframe"],
                        "data": [[60_000, 1, 1 + i, 1, 1 + i, i + 1]],
                    }))
                    await asyncio.sleep(0.05)
            return ws

        app.router.add_get("/ws", ws_handler)
        app.router.add_route("*", "/{tail:.*}", handler)
        return app

    def start(self):
        def run():
            asyncio.set_event_loop(self.loop)
            runner = web.AppRunner(self.app())
            self.loop.run_until_complete(runner.setup())
            site = web.TCPSite(runner, "127.0.0.1", 0)
            self.loop.run_until_complete(site.start())
            self.port = site._server.sockets[0].getsockname()[1]
            self.ready.set()
            self.loop.run_forever()

        threading.Thread(target=run, daemon=True).start()
        self.ready.wait(5)
        return f"http://127.0.0.1:{self.port}"


@pytest.fixture(scope="module")
def gateway(monkeypatch_module):
    gw = FakeGateway()
    url = gw.start()
    monkeypatch_module.setenv("GATEWAY_SECRET", SECRET)
    gw.url = url
    return gw


@pytest.fixture(scope="module")
def monkeypatch_module():
    mp = pytest.MonkeyPatch()
    yield mp
    mp.undo()


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
