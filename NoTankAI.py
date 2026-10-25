import logging
import warnings
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd
import talib.abstract as ta
from pandas import DataFrame
from scipy.signal import argrelextrema

from freqtrade.persistence import Trade
from freqtrade.strategy import BooleanParameter, DecimalParameter, IntParameter, IStrategy

warnings.filterwarnings("ignore")
warnings.simplefilter(action="ignore", category=pd.errors.PerformanceWarning)

logger = logging.getLogger(__name__)


class NoTankAi(IStrategy):
    timeframe = "5m"
    startup_candle_count: int = 200
    process_only_new_candles = True
    can_short = True
    use_exit_signal = True
    exit_profit_only = True
    ignore_roi_if_entry_signal = True
    trailing_stop = False
    stoploss = -0.99

    # One DCA re-entry per trade.
    position_adjustment_enable = True
    max_entry_position_adjustment = 1

    increment = DecimalParameter(
        low=1.0005, high=1.002, default=1.001, decimals=4, space="entry", optimize=True, load=True
    )
    last_entry_price = None

    cooldown_lookback = IntParameter(2, 48, default=1, space="protection", optimize=True)
    stop_duration = IntParameter(12, 200, default=4, space="protection", optimize=True)
    use_stop_protection = BooleanParameter(default=True, space="protection", optimize=True)

    # MHD (MACD Histogram Displacement) entry filter: longs need the histogram
    # rising versus `displacement` candles ago, shorts need it falling.
    mhd_enabled = BooleanParameter(default=True, space="entry", optimize=False)
    mhd_fast = IntParameter(6, 20, default=12, space="entry", optimize=False)
    mhd_slow = IntParameter(20, 40, default=26, space="entry", optimize=False)
    mhd_signal = IntParameter(5, 15, default=9, space="entry", optimize=False)
    mhd_displacement = IntParameter(1, 5, default=1, space="entry", optimize=False)

    minimal_roi = {
        "0": 0.5,
        "60": 0.45,
        "120": 0.4,
        "240": 0.3,
        "360": 0.25,
        "720": 0.2,
        "1440": 0.15,
        "2880": 0.1,
        "3600": 0.05,
        "7200": 0.02,
    }

    plot_config = {
        "main_plot": {},
        "subplots": {
            "extrema": {
                "&s-extrema": {"color": "#f53580", "type": "line"},
                "minima_sort_threshold": {"color": "#4ae747", "type": "line"},
                "maxima_sort_threshold": {"color": "#5b5e4b", "type": "line"},
            },
            "min_max": {
                "maxima": {"color": "#a29db9", "type": "line"},
                "minima": {"color": "#ac7fc", "type": "line"},
                "maxima_check": {"color": "#a29db9", "type": "line"},
                "minima_check": {"color": "#ac7fc", "type": "line"},
            },
            "MHD": {
                "mhd_hist": {"color": "fuchsia", "type": "line"},
                "mhd_hist_disp": {"color": "aqua", "type": "line"},
            },
        },
    }

    @property
    def protections(self):
        prot = [{"method": "CooldownPeriod", "stop_duration_candles": self.cooldown_lookback.value}]
        if self.use_stop_protection.value:
            prot.append(
                {
                    "method": "StoplossGuard",
                    "lookback_period_candles": 24 * 3,
                    "trade_limit": 2,
                    "stop_duration_candles": self.stop_duration.value,
                    "only_per_pair": False,
                }
            )
        return prot

    def custom_entry_price(
        self,
        pair: str,
        trade: Optional[Trade],
        current_time: datetime,
        proposed_rate: float,
        entry_tag: Optional[str],
        side: str,
        **kwargs,
    ) -> float:
        dataframe, _ = self.dp.get_analyzed_dataframe(pair=pair, timeframe=self.timeframe)
        entry_price = (dataframe["close"].iloc[-1] + dataframe["open"].iloc[-1] + proposed_rate) / 3
        if proposed_rate < entry_price:
            entry_price = proposed_rate

        logger.info(
            f"{pair} Using Entry Price: {entry_price} | close: {dataframe['close'].iloc[-1]} "
            f"open: {dataframe['open'].iloc[-1]} proposed_rate: {proposed_rate}"
        )

        if self.last_entry_price is not None and abs(entry_price - self.last_entry_price) < 0.0005:
            entry_price *= self.increment.value
            logger.info(
                f"{pair} Incremented entry price: {entry_price} based on previous entry price : {self.last_entry_price}."
            )

        self.last_entry_price = entry_price
        return entry_price

    def confirm_trade_exit(
        self,
        pair: str,
        trade: Trade,
        order_type: str,
        amount: float,
        rate: float,
        time_in_force: str,
        exit_reason: str,
        current_time: datetime,
        **kwargs,
    ) -> bool:
        if exit_reason == "partial_exit" and trade.calc_profit_ratio(rate) < 0:
            logger.info(f"{trade.pair} partial exit is below 0")
            self.dp.send_msg(f"{trade.pair} partial exit is below 0")
            return False
        return True

    def adjust_trade_position(
        self,
        trade: Trade,
        current_time: datetime,
        current_rate: float,
        current_profit: float,
        min_stake: Optional[float],
        max_stake: float,
        current_entry_rate: float,
        current_exit_rate: float,
        current_entry_profit: float,
        current_exit_profit: float,
        **kwargs,
    ) -> Optional[float]:
        # Scale out: a quarter at +25%, a third of the rest at +40%.
        if current_profit > 0.25 and trade.nr_of_successful_exits == 0:
            return -(trade.stake_amount / 4)
        if current_profit > 0.40 and trade.nr_of_successful_exits == 1:
            return -(trade.stake_amount / 3)

        # DCA once the trade is down 15%, with the same size as the first entry.
        if trade.nr_of_successful_entries > self.max_entry_position_adjustment:
            return None
        if current_profit > -0.15:
            return None
        filled_entries = trade.select_filled_orders(trade.entry_side)
        if not filled_entries:
            return None
        return filled_entries[0].cost

    def leverage(
        self,
        pair: str,
        current_time: datetime,
        current_rate: float,
        proposed_leverage: float,
        max_leverage: float,
        side: str,
        **kwargs,
    ) -> float:
        dataframe, _ = self.dp.get_analyzed_dataframe(pair=pair, timeframe=self.timeframe)
        window = dataframe.tail(50)
        close, high, low = window["close"], window["high"], window["low"]

        atr = ta.ATR(high, low, close, timeperiod=14)
        macd_line, signal_line, _ = ta.MACD(close, fastperiod=12, slowperiod=26, signalperiod=9)
        sma = ta.SMA(close, timeperiod=20)
        current_atr = atr[-1] if len(atr) > 0 else 0.0
        current_macd = macd_line[-1] - signal_line[-1] if len(macd_line) > 0 and len(signal_line) > 0 else 0.0
        current_sma = sma[-1] if len(sma) > 0 else 0.0

        leverage = 10.0
        if current_atr > current_rate * 0.03:
            leverage *= 0.8
        if side == "long":
            if current_macd > 0:
                leverage *= 1.5
            if current_rate < current_sma:
                leverage *= 0.5
        elif side == "short":
            if current_macd < 0:
                leverage *= 1.5
            if current_rate > current_sma:
                leverage *= 0.5

        return max(min(leverage, max_leverage), 1.0)

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["rsi"] = ta.RSI(dataframe)
        # DI_catch: 1 when -DI leads (sellers in control), 0 when +DI leads.
        # NaN during the DI warm-up, so those candles never count as either side.
        di_values = pd.Series(ta.PLUS_DI(dataframe) - ta.MINUS_DI(dataframe), index=dataframe.index)
        dataframe["DI_catch"] = np.where(di_values.isna(), np.nan, np.where(di_values > 0, 0, 1))

        maxima = np.zeros(len(dataframe))
        minima = np.zeros(len(dataframe))
        maxima[argrelextrema(dataframe["close"].values, np.greater, order=5)] = 1
        minima[argrelextrema(dataframe["close"].values, np.less, order=5)] = 1
        dataframe["maxima"] = maxima
        dataframe["minima"] = minima
        dataframe["&s-extrema"] = maxima - minima

        # 1 when no extreme in the last 4 candles, 0 when one just formed.
        dataframe["maxima_check"] = (
            dataframe["maxima"].rolling(4).apply(lambda x: int((x != 1).all()), raw=True).fillna(0)
        )
        dataframe["minima_check"] = (
            dataframe["minima"].rolling(4).apply(lambda x: int((x != 1).all()), raw=True).fillna(0)
        )

        dataframe["minima_sort_threshold"] = dataframe["close"].rolling(window=10).min()
        dataframe["maxima_sort_threshold"] = dataframe["close"].rolling(window=10).max()

        # MHD, as in TradingView: Pine's ema() is ewm(adjust=False).
        close = dataframe["close"]
        macd = (
            close.ewm(span=self.mhd_fast.value, adjust=False).mean()
            - close.ewm(span=self.mhd_slow.value, adjust=False).mean()
        )
        signal = macd.ewm(span=self.mhd_signal.value, adjust=False).mean()
        dataframe["mhd_hist"] = macd - signal
        dataframe["mhd_hist_disp"] = dataframe["mhd_hist"].shift(self.mhd_displacement.value)
        return dataframe

    def _mhd_filters(self, df: DataFrame) -> tuple:
        if not self.mhd_enabled.value:
            return True, True
        return df["mhd_hist"] > df["mhd_hist_disp"], df["mhd_hist"] < df["mhd_hist_disp"]

    def populate_entry_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        mhd_long, mhd_short = self._mhd_filters(df)

        df.loc[
            (df["minima_check"] == 0) & (df["volume"] > 0) & (df["rsi"] < 30) & mhd_long,
            ["enter_long", "enter_tag"],
        ] = (1, "Minima Full Send")
        # Buy a fresh bottom after sellers (-DI) were in control.
        df.loc[
            (df["DI_catch"] == 1)
            & (df["minima_check"] == 0)
            & (df["minima_check"].shift(5) == 1)
            & (df["volume"] > 0)
            & (df["rsi"] < 30)
            & mhd_long,
            ["enter_long", "enter_tag"],
        ] = (1, "Minima Check")

        df.loc[
            (df["maxima_check"] == 0) & (df["volume"] > 0) & (df["rsi"] > 70) & mhd_short,
            ["enter_short", "enter_tag"],
        ] = (1, "Maxima Full Send")
        # Mirror of "Minima Check": short a fresh top after buyers (+DI) were in control.
        df.loc[
            (df["DI_catch"] == 0)
            & (df["maxima_check"] == 0)
            & (df["maxima_check"].shift(5) == 1)
            & (df["volume"] > 0)
            & (df["rsi"] > 70)
            & mhd_short,
            ["enter_short", "enter_tag"],
        ] = (1, "Maxima Check")
        return df

    def populate_exit_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        df.loc[(df["maxima_check"] == 0) & (df["volume"] > 0), ["exit_long", "exit_tag"]] = (
            1,
            "Maxima Full Send",
        )
        df.loc[(df["minima_check"] == 0) & (df["volume"] > 0), ["exit_short", "exit_tag"]] = (
            1,
            "Minima Full Send",
        )
        return df
