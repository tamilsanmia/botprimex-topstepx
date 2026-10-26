"""
EmaRsiCross: a basic EMA 20/200 cross strategy with an RSI 30/70 filter.

entry_mode "cross" (default):
  * Long when EMA 20 crosses above EMA 200 and RSI is below 70 (not overbought).
  * Short when EMA 20 crosses below EMA 200 and RSI is above 30 (not oversold).
entry_mode "pullback":
  * Long while EMA 20 is above EMA 200 when RSI crosses back up through 30.
  * Short while EMA 20 is below EMA 200 when RSI crosses back down through 70.

Exits (both modes): a long closes when EMA 20 crosses below EMA 200 or RSI goes
above 70; a short closes when EMA 20 crosses above EMA 200 or RSI goes below 30.
The stoploss is the only other exit (ROI is off).

Every value is computed from the current and earlier candles only, so backtest
and live signals are the same.
"""

from __future__ import annotations

import pandas as pd
import talib.abstract as ta
from pandas import DataFrame

from freqtrade.strategy import CategoricalParameter, IntParameter, IStrategy


def _crossed_above(a: pd.Series, b) -> pd.Series:
    """a was at or below b on the previous candle and is above it now (b: series or number)."""
    b_prev = b.shift(1) if isinstance(b, pd.Series) else b
    return (a > b) & (a.shift(1) <= b_prev)


def _crossed_below(a: pd.Series, b) -> pd.Series:
    b_prev = b.shift(1) if isinstance(b, pd.Series) else b
    return (a < b) & (a.shift(1) >= b_prev)


class EmaRsiCross(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "5m"
    can_short = True
    # EMA 200 needs a few hundred candles before it settles.
    startup_candle_count: int = 600
    process_only_new_candles = True

    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False
    # ROI off: trades close on the exit signals or the stoploss.
    minimal_roi = {"0": 100.0}
    stoploss = -0.10
    trailing_stop = False

    entry_mode = CategoricalParameter(["cross", "pullback"], default="cross", space="entry", optimize=False)
    ema_fast = IntParameter(5, 50, default=20, space="entry", optimize=False)
    ema_slow = IntParameter(100, 300, default=200, space="entry", optimize=False)
    rsi_period = IntParameter(7, 21, default=14, space="entry", optimize=False)
    rsi_low = IntParameter(10, 40, default=30, space="entry", optimize=True)
    rsi_high = IntParameter(60, 90, default=70, space="exit", optimize=True)

    plot_config = {
        "main_plot": {
            "ema_fast": {"color": "#f5b041", "type": "line"},
            "ema_slow": {"color": "#5dade2", "type": "line"},
        },
        "subplots": {
            "RSI": {
                "rsi": {"color": "#af7ac5", "type": "line"},
                "rsi_high_line": {"color": "rgba(216,76,26,0.6)", "type": "line"},
                "rsi_low_line": {"color": "rgba(26,216,194,0.6)", "type": "line"},
            },
        },
    }

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["ema_fast"] = ta.EMA(dataframe, timeperiod=self.ema_fast.value)
        dataframe["ema_slow"] = ta.EMA(dataframe, timeperiod=self.ema_slow.value)
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=self.rsi_period.value)
        dataframe["rsi_low_line"] = float(self.rsi_low.value)
        dataframe["rsi_high_line"] = float(self.rsi_high.value)
        return dataframe

    def populate_entry_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        low, high = self.rsi_low.value, self.rsi_high.value
        trading = df["volume"] > 0
        if self.entry_mode.value == "pullback":
            long = (df["ema_fast"] > df["ema_slow"]) & _crossed_above(df["rsi"], low)
            short = (df["ema_fast"] < df["ema_slow"]) & _crossed_below(df["rsi"], high)
            long_tag, short_tag = "rsi_pullback_long", "rsi_pullback_short"
        else:
            long = _crossed_above(df["ema_fast"], df["ema_slow"]) & (df["rsi"] < high)
            short = _crossed_below(df["ema_fast"], df["ema_slow"]) & (df["rsi"] > low)
            long_tag, short_tag = "ema_cross_up", "ema_cross_down"

        df.loc[long & trading, ["enter_long", "enter_tag"]] = (1, long_tag)
        df.loc[short & trading, ["enter_short", "enter_tag"]] = (1, short_tag)
        return df

    def populate_exit_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        low, high = self.rsi_low.value, self.rsi_high.value
        cross_down = _crossed_below(df["ema_fast"], df["ema_slow"])
        cross_up = _crossed_above(df["ema_fast"], df["ema_slow"])

        df.loc[cross_down, ["exit_long", "exit_tag"]] = (1, "ema_cross_down")
        df.loc[~cross_down & (df["rsi"] > high), ["exit_long", "exit_tag"]] = (1, f"rsi_above_{high}")
        df.loc[cross_up, ["exit_short", "exit_tag"]] = (1, "ema_cross_up")
        df.loc[~cross_up & (df["rsi"] < low), ["exit_short", "exit_tag"]] = (1, f"rsi_below_{low}")
        return df
