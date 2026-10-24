"""
Freqtrade exchange class for ProjectX (TopstepX) CME futures.

Futures here are dated CME contracts traded in whole contracts with no exchange
leverage, no funding and no liquidation engine (the prop firm's loss limits play
that role, enforced by the gateway's AccountGuard). They are presented to
Freqtrade as linear USD-settled swaps so its futures machinery (shorting,
reduceOnly exits, contract sizes) applies unchanged.
"""

from __future__ import annotations

import logging
from datetime import datetime

import projectx  # noqa: F401  - registers ccxt classes before Exchange initialises

from freqtrade.enums import MarginMode, TradingMode
from freqtrade.exceptions import ConfigurationError, OperationalException
from freqtrade.exchange.exchange import Exchange
from freqtrade.util import FtTTLCache

logger = logging.getLogger(__name__)

RATE_CACHE_TTL_SECS = 1


class Projectx(Exchange):
    _ft_has = {
        "stoploss_on_exchange": True,
        "stop_price_param": "stopPrice",
        "stop_price_prop": "stopPrice",
        "stoploss_order_types": {"market": "stop", "limit": "stop_limit"},
        "order_time_in_force": ["GTC"],
        "ohlcv_candle_limit": 20000,
        "ohlcv_has_history": True,
        "ohlcv_partial_candle": True,
        "ohlcv_late_candle_grace_secs": 2,
        "ws_enabled": True,
        "trades_has_history": True,
        "trades_pagination": "time",
        "trades_pagination_arg": "since",
        "trades_limit": 1000,
        "tickers_have_quoteVolume": False,
        "tickers_have_percentage": True,
        "tickers_have_bid_ask": True,
        "l2_limit_range": None,
        "needs_trading_fees": False,
        "download_data_parallel_quick": False,
        # No exchange leverage tiers exist; get_max_leverage comes from config.
        "uses_leverage_tiers": False,
    }
    _ft_has_futures = {
        "stoploss_order_types": {"market": "stop", "limit": "stop_limit"},
    }

    _supported_trading_mode_margin_pairs: list[tuple[TradingMode, MarginMode]] = [
        (TradingMode.FUTURES, MarginMode.ISOLATED),
    ]

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        # Freqtrade caches entry/exit rates for 5 minutes; prices here come from a
        # live tick stream at no request cost, so a 1 second cache is enough.
        self._entry_rate_cache = FtTTLCache(maxsize=100, ttl=RATE_CACHE_TTL_SECS)
        self._exit_rate_cache = FtTTLCache(maxsize=100, ttl=RATE_CACHE_TTL_SECS)

    def validate_timeframes(self, timeframe: str | None) -> None:
        """
        Same as Freqtrade's check minus the "< 1m is not supported" rule: the gateway
        streams 1s-30s candles built from the live tick tape. Experimental.
        """
        if not hasattr(self._api, "timeframes") or self._api.timeframes is None:
            raise OperationalException(f"The ccxt library does not provide timeframes for {self.name}.")
        if timeframe and timeframe not in self.timeframes:
            raise ConfigurationError(
                f"Invalid timeframe '{timeframe}'. This exchange supports: {self.timeframes}"
            )
        if timeframe and timeframe.endswith("s"):
            logger.warning(
                "Strategy timeframe %s is below 1m. Freqtrade does not officially support this; "
                "candle-count based protections and ROI timing may behave differently.",
                timeframe,
            )

    def get_max_leverage(self, pair: str, stake_amount: float | None) -> float:
        return float(self._api.options.get("maxLeverage", 50))

    def get_maintenance_ratio_and_amt(self, pair: str, notional_value: float) -> tuple[float, float | None]:
        return 0.0, None

    def load_leverage_tiers(self) -> dict:
        return {}

    def get_funding_fees(self, pair: str, amount: float, is_short: bool, open_date: datetime) -> float:
        return 0.0

    def _fetch_and_calculate_funding_fees(self, *args, **kwargs) -> float:
        return 0.0

    def get_liquidation_price(self, *args, **kwargs) -> float | None:
        return None


# ExchangeResolver looks the class up on the freqtrade.exchange package.
import freqtrade.exchange as _ft_exchange  # noqa: E402

_ft_exchange.Projectx = Projectx
