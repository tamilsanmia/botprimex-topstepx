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
from datetime import UTC, datetime, timedelta

import projectx  # noqa: F401  - registers ccxt classes before Exchange initialises

from freqtrade.enums import ExitType, MarginMode, RunMode, TradingMode
from freqtrade.exceptions import ConfigurationError, OperationalException
from freqtrade.exchange.exchange import Exchange
from freqtrade.exchange.exchange_utils_timeframe import timeframe_to_prev_date, timeframe_to_seconds
from freqtrade.util import FtTTLCache

from .costs import cost_ratio, costs_config
from .startup_checks import check_startup

logger = logging.getLogger(__name__)

RATE_CACHE_TTL_SECS = 1


def _date_minus_candles(timeframe: str, candle_count: int, date: datetime | None = None) -> datetime:
    """
    Freqtrade's date_minus_candles() in seconds instead of whole minutes.

    The original subtracts timeframe_to_minutes(timeframe) * candle_count minutes, and
    timeframe_to_minutes("1s".."30s") is 0, so on seconds timeframes it returns "now".
    In refresh_latest_ohlcv that made every iteration see a "time jump", evict the
    candle cache and reload the full history over REST, and it made the websocket
    candle check compare against the current candle instead of the previous one.
    Together that delayed entries by several seconds on 1s candles. For whole-minute
    timeframes the result is identical to the original.
    """
    if not date:
        date = datetime.now(UTC)
    tf_secs = timeframe_to_seconds(timeframe)
    return timeframe_to_prev_date(timeframe, date) - timedelta(seconds=tf_secs * candle_count)


# Seconds timeframes: Freqtrade's main loop wakes 1 s after each candle boundary
# (Worker passes timeframe_offset=1), a whole candle late on 1s. Wake 0.3 s after the
# boundary instead. Minute timeframes keep the 1 s offset.
SECONDS_TF_LOOP_OFFSET_SECS = 0.3
# Seconds timeframes: a just-closed candle counts as final this long after its close
# even if no newer candle was issued yet (Freqtrade: half a candle, 500 ms on 1s).
# Must stay below the loop offset, or the loop reads the closed candle as unfinished.
SECONDS_TF_GRACE_MS = 250
# Seconds timeframes, live and dry-run: candles kept in the cache (see ohlcv_candle_limit).
SECONDS_TF_LIVE_CANDLES = 2000


def _patch_seconds_timeframes() -> None:
    """Install the seconds-timeframe fixes where Freqtrade bound the originals."""
    import freqtrade.data.history.history_utils as history_utils
    import freqtrade.exchange as ft_exchange_pkg
    import freqtrade.exchange.exchange as ft_exchange_mod
    import freqtrade.exchange.exchange_utils as ft_exchange_utils
    import freqtrade.worker as ft_worker

    for module in (ft_exchange_utils, ft_exchange_mod, ft_exchange_pkg, history_utils):
        if getattr(module, "date_minus_candles", None) is not _date_minus_candles:
            module.date_minus_candles = _date_minus_candles

    original = ft_worker.Worker._throttle
    if getattr(original, "_projectx_seconds", False):
        return

    def _throttle(self, func, throttle_secs, timeframe=None, timeframe_offset=1.0, *args, **kwargs):
        if timeframe and timeframe.endswith("s"):
            timeframe_offset = min(timeframe_offset, SECONDS_TF_LOOP_OFFSET_SECS)
        return original(self, func, throttle_secs, timeframe, timeframe_offset, *args, **kwargs)

    _throttle._projectx_seconds = True
    ft_worker.Worker._throttle = _throttle


def _last_exit_if_net_flat(trade):
    """The latest filled exit or stop when the trade's filled orders net to zero (or less), else None."""
    from freqtrade.exchange import amount_to_contract_precision

    filled = [o for o in trade.orders if not o.ft_is_open and o.filled]
    exits = [o for o in filled if o.ft_order_side != trade.entry_side]
    if not exits:
        return None
    net = sum(o.safe_amount_after_fee for o in filled if o.ft_order_side == trade.entry_side)
    net -= sum(o.safe_amount_after_fee for o in exits)
    net = amount_to_contract_precision(net, trade.amount_precision, trade.precision_mode, trade.contract_size)
    if net > 0:
        return None
    return max(exits, key=lambda o: o.order_filled_utc or o.order_date_utc)


def _settle_from_orders(trade, last) -> None:
    """
    Closes the trade at `last`'s price with amount and open rate taken from the orders before it,
    as Freqtrade's own close leaves them. Freqtrade's recovery leaves them at the last entry's
    values when the fills net to zero, and recalc_trade_from_orders keeps them as they are then.
    """
    last.ft_is_open = True
    try:
        trade.recalc_trade_from_orders()
    finally:
        last.ft_is_open = False
    trade.close(last.safe_price, show_msg=False)


def _close_if_net_flat(bot, trade) -> bool:
    """
    Closes an open trade whose filled orders already net to zero, at its last exit's price.

    Freqtrade's on-exchange recovery re-applies every order with `recalculating=True`: each
    entry resets the trade amount to that order's amount, and an exit larger than that amount
    does not close the trade. A trade whose stop filled for the whole position therefore stayed
    open (amount and open rate of the last entry) and the recovery ran again every loop.
    """
    from freqtrade.persistence import Trade

    if not trade.is_open:
        return False
    last = _last_exit_if_net_flat(trade)
    if last is None:
        return False
    stoploss = last.ft_order_side == "stoploss"
    if stoploss:
        trade.exit_reason = ExitType.STOPLOSS_ON_EXCHANGE.value
    elif not trade.exit_reason:
        trade.exit_reason = ExitType.SOLD_ON_EXCHANGE.value
    logger.warning(
        "%s: filled orders net to zero, so the position is flat; closing the trade at %s (order %s, %s)",
        trade, last.safe_price, last.order_id, trade.exit_reason,
    )
    _settle_from_orders(trade, last)
    trade.close_date = last.order_filled_utc or trade.close_date
    Trade.commit()
    if stoploss:
        bot._notify_exit(trade, "stoploss", True)
        bot.handle_protections(trade.pair, trade.trade_direction)
    else:
        bot.order_close_notify(trade, last, False, send_msg=True)
    return True


def _patch_onexchange_recovery() -> None:
    """Wrap FreqtradeBot.handle_onexchange_order so a net-flat trade is closed, not recovered again."""
    import freqtrade.freqtradebot as ft_bot

    original = ft_bot.FreqtradeBot.handle_onexchange_order
    if getattr(original, "_projectx_recovery", False):
        return

    def handle_onexchange_order(self, trade) -> bool:
        from freqtrade.persistence import Trade

        if not isinstance(self.exchange, Projectx):
            return original(self, trade)
        if _close_if_net_flat(self, trade):
            return False
        result = original(self, trade)
        if result:  # the trade was deleted
            return result
        if trade.is_open:
            # The recovery may have added exit orders it did not know before.
            _close_if_net_flat(self, trade)
        else:
            # Re-applying the orders of a closed trade (FreqUI "reload trade") leaves amount and
            # open rate at the last entry's values; put back the values the close had.
            last = _last_exit_if_net_flat(trade)
            if last is not None:
                _settle_from_orders(trade, last)
                Trade.commit()
        return result

    handle_onexchange_order._projectx_recovery = True
    ft_bot.FreqtradeBot.handle_onexchange_order = handle_onexchange_order


def report_stop_as_open(order: dict) -> dict:
    """
    A stop order as Freqtrade should record it when it was placed.

    The gateway waits briefly after placing a stop and answers with its current state, so a
    stop placed at or through the market comes back already filled ("closed"). Freqtrade
    stores such an order as not open and never reads its fill: the trade stays open on a flat
    account, and the next loop places another stop (refused) and an emergency exit (refused).
    Reported as open, the order is fetched on the next stoploss check, which sees the fill
    and closes the trade through Freqtrade's normal stoploss path.
    """
    if order.get("status") != "closed":
        return order
    amount = order.get("amount")
    return {
        **order,
        "status": "open",
        "filled": 0.0,
        "remaining": amount,
        "average": None,
        "cost": 0.0,
        "fee": None,
        "trades": [],
        "lastTradeTimestamp": None,
        "info": {**(order.get("info") or {}), "projectx_status_on_create": "closed"},
    }


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

    def __init__(self, config, *args, **kwargs) -> None:
        # Refuse placeholder API credentials before anything connects (trade and webserver only).
        # close() runs from __del__ even for an object that never finished __init__.
        self._exchange_ws = None
        self._ws_async = None
        check_startup(config)
        # Patched here, not at import: freqtrade.exchange imports this module while it initialises.
        _patch_seconds_timeframes()
        _patch_onexchange_recovery()
        super().__init__(config, *args, **kwargs)
        # Freqtrade caches entry/exit rates for 5 minutes; prices here come from a
        # live tick stream at no request cost, so a 1 second cache is enough.
        self._entry_rate_cache = FtTTLCache(maxsize=100, ttl=RATE_CACHE_TTL_SECS)
        self._exit_rate_cache = FtTTLCache(maxsize=100, ttl=RATE_CACHE_TTL_SECS)

    def ohlcv_candle_limit(self, timeframe: str, candle_type, since_ms: int | None = None) -> int:
        limit = super().ohlcv_candle_limit(timeframe, candle_type, since_ms)
        # The live/dry-run candle cache holds this many candles (plus the startup count) and
        # the strategy re-analyses all of them every loop. On seconds timeframes keep it small
        # so analysis stays well inside one candle. Downloads and backtests keep the full limit.
        if timeframe.endswith("s") and self._config.get("runmode") in (RunMode.LIVE, RunMode.DRY_RUN):
            return min(limit, SECONDS_TF_LIVE_CANDLES)
        return limit

    def create_stoploss(self, pair: str, amount: float, stop_price: float, order_types: dict, side,
                        leverage: float) -> dict:
        stop_price = self._guard_stop_price(pair, stop_price, side)
        order = super().create_stoploss(pair, amount, stop_price, order_types, side, leverage)
        if self._config.get("dry_run"):
            return order
        reported = report_stop_as_open(order)
        if reported is not order:
            logger.warning(
                "stop order %s for %s filled on placement; Freqtrade reads the fill on its next stoploss check",
                order.get("id"), pair,
            )
        return reported

    def _guard_stop_price(self, pair: str, stop_price: float, side: str) -> float:
        """
        Last line against a stop that fills on placement: a buy stop goes at least
        stop_min_distance_ticks above max(ask, last), a sell stop that far below min(bid, last).
        Without a quote the stop is placed as asked.
        """
        # Same key and default as STRATEGY_DEFAULTS["stop_min_distance_ticks"] in strategy_mixin.py.
        ticks = (self._config.get("topstep_strategy") or {}).get("stop_min_distance_ticks", 4)
        try:
            ticks = float(ticks or 0)
            tick = float(self.markets[pair]["precision"]["price"] or 0)
            ticker = self.fetch_ticker(pair) or {}
        except Exception as e:  # noqa: BLE001
            logger.warning("stop for %s placed as asked at %s: no quote to check it against (%s)", pair, stop_price, e)
            return stop_price
        if ticks <= 0 or tick <= 0:
            return stop_price
        if side == "buy":
            refs = [float(v) for v in (ticker.get("ask"), ticker.get("last")) if v]
            bound = max(refs) + ticks * tick if refs else None
            moved = bound is not None and stop_price < bound
        else:
            refs = [float(v) for v in (ticker.get("bid"), ticker.get("last")) if v]
            bound = min(refs) - ticks * tick if refs else None
            moved = bound is not None and stop_price > bound
        if not moved:
            return stop_price
        bound = round(round(bound / tick) * tick, 10)
        logger.warning(
            "%s stop for %s at %s is within %s ticks of the market (%s %s); placing it at %s",
            side, pair, stop_price, ticks, "ask/last" if side == "buy" else "bid/last", refs, bound,
        )
        return bound

    def _ohlcv_candle_grace_ms(self, timeframe: str) -> int:
        grace = super()._ohlcv_candle_grace_ms(timeframe)
        return min(grace, SECONDS_TF_GRACE_MS) if timeframe.endswith("s") else grace

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

    def _costs_apply(self) -> dict | None:
        """The topstep_costs block while costs apply: backtest, hyperopt and dry-run (all run with dry_run)."""
        costs = costs_config(self._config)
        return costs if self._config.get("dry_run") and costs.get("enabled") else None

    def get_fee(self, symbol: str, order_type: str = "", side: str = "", amount: float = 1,
                price: float = 1, taker_or_maker="maker") -> float:
        costs = self._costs_apply()
        if costs is None:
            return super().get_fee(symbol, order_type, side, amount, price, taker_or_maker)
        # A call without a price (Freqtrade's own rate lookups) or for an unknown market costs nothing;
        # the per-contract cost is applied to the trade once its fill price is known.
        if not price or price <= 1:
            return 0.0
        market = (self._markets.get(symbol) or {}).get("info") or {}
        return cost_ratio(costs, market, price) or 0.0

    def add_dry_order_fee(self, pair: str, dry_order: dict, taker_or_maker) -> dict:
        # The base class asks for the fee without the order's price, which would drop the costs.
        price = dry_order.get("average") or dry_order.get("price")
        fee = self.get_fee(pair, dry_order.get("type") or "", dry_order.get("side") or "",
                           dry_order.get("amount") or 1, price or 1, taker_or_maker)
        dry_order.update({
            "fee": {
                "currency": self.get_pair_quote_currency(pair),
                "cost": dry_order["cost"] * fee,
                "rate": fee,
            }
        })
        return dry_order

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
