"""
Shared fixtures: an in-process fake projectx-gateway (aiohttp) for the adapter and strategy tests.
"""

from __future__ import annotations

import asyncio
import json
import threading

import pytest
from aiohttp import web

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
        # What /guard answers (None = gateway failure) and what /orderflow/features returns (None = failure).
        self.guard: dict | None = {"status": "active", "canEnter": True, "flatten": False, "reasons": [], "metrics": {}}
        self.features: list | None = []

    def reset(self):
        self.requests.clear()
        self.guard = {"status": "active", "canEnter": True, "flatten": False, "reasons": [], "metrics": {}}
        self.features = []

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
            if p in ("/guard", "/guard/snapshot"):
                if self.guard is None:
                    return web.json_response({"error": "guard down", "kind": "ExchangeNotAvailable"}, status=503)
                return web.json_response(self.guard)
            if p == "/orderflow/features":
                if self.features is None:
                    return web.json_response({"error": "no orderflow", "kind": "ExchangeNotAvailable"}, status=503)
                return web.json_response(self.features)
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
