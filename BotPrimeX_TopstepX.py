"""
BotPrimeX for TopstepX (ProjectX) CME futures, through the projectx-gateway.

BotPrimeX's signals, unchanged, plus the TopstepX layer from
projectx.strategy_mixin (account protection, risk-based whole contracts,
protective stop, mini/micro limits, roll guard, backtest rule simulation).
"""

from __future__ import annotations

import os
import sys

import numpy as np
from pandas import DataFrame

from freqtrade.exchange import timeframe_to_seconds

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from BotPrimeX import BotPrimeX  # noqa: E402

from projectx.strategy_mixin import TopstepXMixin  # noqa: E402


class BotPrimeX_TopstepX(TopstepXMixin, BotPrimeX):
    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe = super().populate_indicators(dataframe, metadata)
        # BotPrimeX's 24h change assumes 5m candles (shift 288); derive it per timeframe.
        per_day = max(1, int(86400 / timeframe_to_seconds(self.timeframe)))
        prev = dataframe["close"].shift(per_day)
        dataframe["chg_pct"] = np.where(prev > 0, (dataframe["close"] - prev) / prev * 100, np.nan)
        return dataframe
