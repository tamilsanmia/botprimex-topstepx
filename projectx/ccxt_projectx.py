"""
ccxt exchange classes for ProjectX (TopstepX), backed by the projectx-gateway.

The gateway holds the ProjectX session, hubs, candle store and order router, and
already answers in ccxt shapes, so these classes are thin: build a request, send
it over the internal network, return the payload. Three flavours are registered,
because Freqtrade uses all of them:

    ccxt.projectx               sync   - markets, orders, balance, positions
    ccxt.async_support.projectx async  - candles, public trades
    ccxt.pro.projectx           ws     - watch_ohlcv / watch_ticker (live candles)

All amounts are in contracts; Freqtrade converts with the market's contractSize.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import aiohttp
import ccxt
import ccxt.async_support as ccxt_async
from ccxt.base.decimal_to_precision import TICK_SIZE

from .gateway_client import DEFAULT_TIMEOUT, GatewayClient, gateway_settings, raise_for_payload

TIMEFRAMES = [
    "1s", "5s", "10s", "15s", "30s",
    "1m", "3m", "5m", "15m", "30m",
    "1h", "2h", "4h", "6h", "8h", "12h", "1d",
]

WS_CANDLE_CACHE = 1000

# The gateway's book is Level 1 with size 0 when the hub has not sent one. ccxt's
# fetch_l2_order_book drops zero-size levels, which leaves Freqtrade's dry-run with an
# empty book: market buys then fill at 0, market sells at its 5% worst-case price, and
# dry-run stops never trigger. An unknown size is reported as deep instead, so dry-run
# fills at the best bid/ask (costs come from topstep_costs). Live orders never read it.
UNKNOWN_DEPTH = 1e9


def _with_known_depth(book: dict) -> dict:
    for side in ("bids", "asks"):
        book[side] = [
            [price, size if size and size > 0 else UNKNOWN_DEPTH]
            for price, size, *_ in (book.get(side) or [])
            if price and price > 0
        ]
    return book


class _ProjectxBase:
    """Request builders and market parsing shared by the sync and async classes."""

    def describe(self):
        return self.deep_extend(super().describe(), {
            "id": "projectx",
            "name": "ProjectX (TopstepX)",
            "countries": ["US"],
            "version": "v1",
            "rateLimit": 1,
            "pro": True,
            "has": {
                "CORS": None,
                "spot": False,
                "margin": False,
                "swap": True,
                "future": False,
                "option": False,
                "cancelOrder": True,
                "createOrder": True,
                "createMarketOrder": True,
                "createLimitOrder": True,
                "createStopOrder": True,
                "createStopMarketOrder": True,
                "createReduceOnlyOrder": True,
                "editOrder": True,
                "fetchBalance": True,
                "fetchClosedOrders": False,
                "fetchCurrencies": False,
                "fetchFundingRate": False,
                # CME futures have no funding and no separate mark price; these exist so
                # Freqtrade's futures backtesting finds the data it expects.
                "fetchFundingRateHistory": True,
                "fetchMarkOHLCV": True,
                "fetchL2OrderBook": True,
                "fetchLeverageTiers": False,
                "fetchMarkets": True,
                "fetchMyTrades": True,
                "fetchOHLCV": True,
                "fetchOpenOrders": True,
                "fetchOrder": True,
                "fetchOrderBook": True,
                "fetchOrders": True,
                "fetchPositions": True,
                "fetchTicker": True,
                "fetchTickers": True,
                "fetchTime": False,
                "fetchTrades": True,
                "fetchTradingFees": False,
                "setLeverage": False,
                "setMarginMode": False,
                "watchOHLCV": True,
                "watchTicker": True,
            },
            "timeframes": {tf: tf for tf in TIMEFRAMES},
            "urls": {
                "logo": None,
                "api": {"gateway": "http://projectx-gateway:8787"},
                "www": "https://www.projectx.com",
                "doc": "https://gateway.docs.projectx.com/",
            },
            "precisionMode": TICK_SIZE,
            "requiredCredentials": {"apiKey": False, "secret": False},
            "options": {
                "gatewayUrl": "http://projectx-gateway:8787",
                "maxLeverage": 50,
                "maxOrderSize": 50,
            },
        })

    def _gateway_settings(self) -> tuple[str, str]:
        url, secret = gateway_settings(options=self.options)
        return url, secret or (self.secret or "")

    def parse_projectx_market(self, row: dict) -> dict:
        root = row["root"]
        tick = float(row["tickSize"])
        max_lev = float(self.options.get("maxLeverage", 50))
        return {
            "id": row["contractId"],
            "symbol": row["symbol"],
            "base": root,
            "quote": "USD",
            "settle": "USD",
            "baseId": root,
            "quoteId": "USD",
            "settleId": "USD",
            "type": "swap",
            "spot": False,
            "margin": False,
            "swap": True,
            "future": False,
            "option": False,
            "active": bool(row.get("active", True)),
            "contract": True,
            "linear": True,
            "inverse": False,
            "contractSize": float(row["contractSize"]),
            "expiry": None,
            "expiryDatetime": None,
            "strike": None,
            "optionType": None,
            "taker": 0.0,
            "maker": 0.0,
            "precision": {"amount": 1.0, "price": tick},
            "limits": {
                "leverage": {"min": 1.0, "max": max_lev},
                "amount": {"min": 1.0, "max": float(self.options.get("maxOrderSize", 50))},
                "price": {"min": tick, "max": None},
                "cost": {"min": None, "max": None},
            },
            "created": None,
            "info": row,
        }

    def zero_funding_history(self, symbol, since=None, limit=None) -> list[dict]:
        """Hourly funding rates of 0: dated CME contracts never pay funding."""
        hour = 3_600_000
        now = self.milliseconds()
        count = min(int(limit or 1000), 1000)
        start = (since // hour) * hour if since is not None else (now // hour - count) * hour
        rows = []
        for ts in range(start, min(now + 1, start + count * hour), hour):
            rows.append({"info": {}, "symbol": symbol, "fundingRate": 0.0, "timestamp": ts, "datetime": self.iso8601(ts)})
        return rows

    @staticmethod
    def _symbols_param(symbols) -> str | None:
        if not symbols:
            return None
        return ",".join(symbols)

    @staticmethod
    def _order_body(symbol, type, side, amount, price, params) -> dict:
        return {
            "symbol": symbol,
            "type": type,
            "side": side,
            "amount": amount,
            "price": price,
            "params": {k: v for k, v in (params or {}).items() if isinstance(v, (str, int, float, bool)) or v is None},
        }


class projectx(_ProjectxBase, ccxt.Exchange):
    """Synchronous ccxt class (Freqtrade's ``_api``)."""

    def __init__(self, config=None):
        super().__init__(config or {})
        url, secret = self._gateway_settings()
        self.gateway = GatewayClient(url, secret, timeout=self.timeout / 1000 if self.timeout else DEFAULT_TIMEOUT)

    def fetch_markets(self, params={}):
        return [self.parse_projectx_market(r) for r in self.gateway.get("/markets")]

    def fetch_ticker(self, symbol, params={}):
        return self.gateway.get("/ticker", {"symbol": symbol})

    def fetch_tickers(self, symbols=None, params={}):
        return self.gateway.get("/tickers", {"symbols": self._symbols_param(symbols)})

    def fetch_order_book(self, symbol, limit=None, params={}):
        return _with_known_depth(self.gateway.get("/orderbook", {"symbol": symbol}))

    def fetch_ohlcv(self, symbol, timeframe="1m", since=None, limit=None, params={}):
        return self.gateway.get("/ohlcv", {"symbol": symbol, "timeframe": timeframe, "since": since, "limit": limit})

    def fetch_trades(self, symbol, since=None, limit=None, params={}):
        return self.gateway.get("/trades", {"symbol": symbol, "since": since, "limit": limit})

    def fetch_funding_rate_history(self, symbol=None, since=None, limit=None, params={}):
        return self.zero_funding_history(symbol, since, limit)

    def fetch_balance(self, params={}):
        return self.gateway.get("/balance")

    def fetch_positions(self, symbols=None, params={}):
        return self.gateway.get("/positions", {"symbols": self._symbols_param(symbols)})

    def create_order(self, symbol, type, side, amount, price=None, params={}):
        return self.gateway.post("/order", self._order_body(symbol, type, side, amount, price, params))

    def cancel_order(self, id, symbol=None, params={}):
        return self.gateway.post(f"/order/{id}/cancel")

    def edit_order(self, id, symbol, type, side, amount=None, price=None, params={}):
        body = {"amount": amount, "price": price, "stopPrice": (params or {}).get("stopPrice")}
        return self.gateway.post(f"/order/{id}/modify", body)

    def fetch_order(self, id, symbol=None, params={}):
        return self.gateway.get(f"/order/{id}")

    def fetch_orders(self, symbol=None, since=None, limit=None, params={}):
        return self.gateway.get("/orders", {"symbol": symbol, "since": since})

    def fetch_open_orders(self, symbol=None, since=None, limit=None, params={}):
        return self.gateway.get("/orders/open", {"symbol": symbol})

    def fetch_my_trades(self, symbol=None, since=None, limit=None, params={}):
        return self.gateway.get("/mytrades", {"symbol": symbol, "since": since})

    def set_leverage(self, leverage, symbol=None, params={}):
        return {"info": "leverage is synthetic on ProjectX"}

    def set_margin_mode(self, marginMode, symbol=None, params={}):
        return {"info": "margin mode is fixed on ProjectX"}


class projectx_async(_ProjectxBase, ccxt_async.Exchange):
    """Async ccxt class (Freqtrade's ``_api_async``: candles and public trades)."""

    def _gw_headers(self) -> dict:
        _, secret = self._gateway_settings()
        headers = {"Content-Type": "application/json"}
        if secret:
            headers["X-Gateway-Secret"] = secret
        return headers

    async def _gw(self, method: str, path: str, query: dict | None = None, body: dict | None = None) -> Any:
        url, _ = self._gateway_settings()
        # ccxt's own session, so Freqtrade's shutdown (which closes `session`) closes it.
        self.open()
        params = {k: str(v) for k, v in (query or {}).items() if v is not None}
        try:
            async with self.session.request(
                method,
                f"{url}{path}",
                params=params,
                data=json.dumps(body) if body is not None else None,
                headers=self._gw_headers(),
                timeout=aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT * 4),
            ) as resp:
                try:
                    payload = await resp.json(content_type=None)
                except (aiohttp.ContentTypeError, ValueError):
                    payload = None
                raise_for_payload(resp.status, payload, method, path)
                return payload
        except asyncio.TimeoutError as e:
            raise ccxt.RequestTimeout(f"projectx-gateway timeout on {path}") from e
        except aiohttp.ClientError as e:
            raise ccxt.ExchangeNotAvailable(f"projectx-gateway unreachable on {path}: {e}") from e

    async def fetch_markets(self, params={}):
        return [self.parse_projectx_market(r) for r in await self._gw("GET", "/markets")]

    async def fetch_ticker(self, symbol, params={}):
        return await self._gw("GET", "/ticker", {"symbol": symbol})

    async def fetch_tickers(self, symbols=None, params={}):
        return await self._gw("GET", "/tickers", {"symbols": self._symbols_param(symbols)})

    async def fetch_order_book(self, symbol, limit=None, params={}):
        return _with_known_depth(await self._gw("GET", "/orderbook", {"symbol": symbol}))

    async def fetch_ohlcv(self, symbol, timeframe="1m", since=None, limit=None, params={}):
        return await self._gw("GET", "/ohlcv", {"symbol": symbol, "timeframe": timeframe, "since": since, "limit": limit})

    async def fetch_trades(self, symbol, since=None, limit=None, params={}):
        return await self._gw("GET", "/trades", {"symbol": symbol, "since": since, "limit": limit})

    async def fetch_funding_rate_history(self, symbol=None, since=None, limit=None, params={}):
        return self.zero_funding_history(symbol, since, limit)

    async def fetch_balance(self, params={}):
        return await self._gw("GET", "/balance")

    async def fetch_positions(self, symbols=None, params={}):
        return await self._gw("GET", "/positions", {"symbols": self._symbols_param(symbols)})

    async def create_order(self, symbol, type, side, amount, price=None, params={}):
        return await self._gw("POST", "/order", body=self._order_body(symbol, type, side, amount, price, params))

    async def cancel_order(self, id, symbol=None, params={}):
        return await self._gw("POST", f"/order/{id}/cancel", body={})

    async def fetch_order(self, id, symbol=None, params={}):
        return await self._gw("GET", f"/order/{id}")

    async def fetch_open_orders(self, symbol=None, since=None, limit=None, params={}):
        return await self._gw("GET", "/orders/open", {"symbol": symbol})

    async def fetch_my_trades(self, symbol=None, since=None, limit=None, params={}):
        return await self._gw("GET", "/mytrades", {"symbol": symbol, "since": since})


class projectx_pro(projectx_async):
    """
    Websocket flavour for Freqtrade's ExchangeWS: live candles from the gateway's
    tick-built candle store, pushed as each trade prints.
    """

    def __init__(self, config=None):
        super().__init__(config or {})
        self.ohlcvs: dict[str, dict[str, list]] = {}
        self.tickers: dict[str, dict] = {}
        self._ws = None
        self._ws_reader: asyncio.Task | None = None
        self._ws_lock: asyncio.Lock | None = None
        self._subs: set[tuple] = set()
        self._events: dict[tuple, asyncio.Event] = {}
        self._ws_error: Exception | None = None

    async def _ensure_ws(self):
        if self._ws_lock is None:
            self._ws_lock = asyncio.Lock()
        async with self._ws_lock:
            if self._ws is not None and not self._ws.closed:
                return self._ws
            url, secret = self._gateway_settings()
            await self._gw("GET", "/health")
            ws_url = url.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
            headers = {"X-Gateway-Secret": secret} if secret else {}
            self._ws = await self.session.ws_connect(ws_url, headers=headers, heartbeat=20)
            self._ws_error = None
            for sub in self._subs:
                await self._send_sub(*sub)
            self._ws_reader = asyncio.ensure_future(self._read_ws(self._ws))
            return self._ws

    async def _send_sub(self, channel, symbol, timeframe):
        msg = {"op": "subscribe", "channel": channel, "symbol": symbol}
        if timeframe:
            msg["timeframe"] = timeframe
        await self._ws.send_str(json.dumps(msg))

    async def _read_ws(self, ws):
        try:
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                data = json.loads(msg.data)
                channel = data.get("channel")
                symbol = data.get("symbol")
                if data.get("error"):
                    self._ws_error = getattr(ccxt, data.get("kind") or "", ccxt.ExchangeError)(data["error"])
                    key = (channel, symbol, data.get("timeframe"))
                    if key in self._events:
                        self._events[key].set()
                    continue
                if channel == "ohlcv":
                    tf = data.get("timeframe")
                    self._merge_candles(symbol, tf, data.get("data") or [])
                    key = ("ohlcv", symbol, tf)
                elif channel == "ticker":
                    self.tickers[symbol] = data.get("data")
                    key = ("ticker", symbol, None)
                else:
                    continue
                ev = self._events.get(key)
                if ev:
                    ev.set()
        except Exception as e:  # noqa: BLE001 - surface any reader failure to the watcher
            self._ws_error = ccxt.NetworkError(f"projectx-gateway websocket failed: {e}")
        finally:
            self._ws_error = self._ws_error or ccxt.NetworkError("projectx-gateway websocket closed")
            for ev in self._events.values():
                ev.set()

    def _merge_candles(self, symbol, timeframe, bars):
        series = self.ohlcvs.setdefault(symbol, {}).setdefault(timeframe, [])
        for bar in bars:
            if series and series[-1][0] == bar[0]:
                series[-1] = list(bar)
            elif not series or bar[0] > series[-1][0]:
                series.append(list(bar))
            else:
                for i in range(len(series) - 1, -1, -1):
                    if series[i][0] == bar[0]:
                        series[i] = list(bar)
                        break
        if len(series) > WS_CANDLE_CACHE:
            del series[: len(series) - WS_CANDLE_CACHE]

    async def _watch(self, key):
        if key not in self._subs:
            self._subs.add(key)
            await self._ensure_ws()
            await self._send_sub(*key)
        else:
            await self._ensure_ws()
        ev = self._events.setdefault(key, asyncio.Event())
        ev.clear()
        await ev.wait()
        if self._ws_error is not None and (self._ws is None or self._ws.closed):
            err = self._ws_error
            raise err
        if self._ws_error is not None:
            err, self._ws_error = self._ws_error, None
            raise err

    async def watch_ohlcv(self, symbol, timeframe="1m", since=None, limit=None, params={}):
        await self._watch(("ohlcv", symbol, timeframe))
        return self.ohlcvs.get(symbol, {}).get(timeframe, [])

    async def watch_ticker(self, symbol, params={}):
        await self._watch(("ticker", symbol, None))
        return self.tickers.get(symbol)

    async def un_watch_ohlcv(self, symbol, timeframe="1m", params={}):
        key = ("ohlcv", symbol, timeframe)
        self._subs.discard(key)
        if self._ws is not None and not self._ws.closed:
            await self._ws.send_str(json.dumps({"op": "unsubscribe", "channel": "ohlcv", "symbol": symbol, "timeframe": timeframe}))

    async def close(self):
        if self._ws is not None and not self._ws.closed:
            await self._ws.close()
        if self._ws_reader is not None:
            self._ws_reader.cancel()
        self._ws = None
        await super().close()
