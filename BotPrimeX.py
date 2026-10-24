import logging
import warnings
from datetime import datetime, timedelta

warnings.filterwarnings('ignore')

logger = logging.getLogger(__name__)
import talib.abstract as ta

import numpy as np
from pandas import DataFrame
from typing import Optional, Dict, Any
from freqtrade.persistence import Trade
from freqtrade.strategy import (
    IStrategy,
    informative,
    merge_informative_pair,
    stoploss_from_open,
)
from scipy.signal import argrelextrema
import pandas as pd

warnings.simplefilter(action="ignore", category=pd.errors.PerformanceWarning)

class BotPrimeX(IStrategy):
    # Base strategy timeframes
    use_custom_stoploss = True
    timeframe = "5m"
    informative_timeframe = "4h"

    # Strategy/runtime settings
    process_only_new_candles = True
    startup_candle_count: int = 800
    can_short = True
    use_exit_signal = True

    # Core trade behavior
    exit_profit_only = True
    trailing_stop = False
    position_adjustment_enable = True
    ignore_roi_if_entry_signal = True
    max_entry_position_adjustment = 1
    max_dca_orders_open = 3

    # Risk settings
    stoploss = -0.99
    dca_stoploss = -0.5
    leverage_value = 5

    # Stake allocation ratios (portion of proposed stake)
    initial_entry_stake_ratio = 0.5
    dca_entry_stake_ratio = 0.5

    # Shift signal lookback (number of candles to look back for prior extrema)
    shift_lookback = 5

    # ── DCA Settings ──────────────────────────────────────────────────────
    # DCA 1: profit window for 1st DCA re-entry (ratio, e.g. -0.15 = -15%)
    dca_reentry_min_profit = -0.15        # shallowest drawdown to allow DCA1
    dca_reentry_max_drawdown = -0.5       # deepest drawdown to allow DCA1
    # DCA 2: profit window for 2nd DCA re-entry
    dca2_reentry_min_profit = -0.2       # shallowest drawdown to allow DCA2
    dca2_reentry_max_drawdown = -0.5      # deepest drawdown to allow DCA2
    # Volatility guard: block DCA when 24h-change spikes within recent candles
    dca_sudden_chg_guard_enabled = True
    dca_sudden_chg_threshold = 3.0        # min spread (pp) to block DCA
    dca_sudden_chg_lookback = 10          # number of candles to check

    # ── 24h Change Filter (global) ────────────────────────────────────────
    use_chg_filter = True                 # master switch for entry chg filter
    use_chg_exit_buffer = True            # master switch for exit buffer

    # ── Telegram Alerts ───────────────────────────────────────────────────
    telegram_chg_alert_enabled = True
    telegram_chg_min = -10.0
    telegram_chg_max = 10.0
    telegram_chg_alert_state: Dict[str, Dict[str, Any]] = {}

    # ── Breakout Guard / Exit (global switches) ──────────────────────────
    breakout_guard_enabled = False
    breakout_exit_enabled = False
    breakout_exit_cooldown_all_tf = False   # True = count exits across ALL TFs and block ALL entries
    _breakout_exit_log: Dict[str, list] = {}  # internal: {"30M": [datetime, ...], ...}

    # ══════════════════════════════════════════════════════════════════════
    # PER-TIMEFRAME SETTINGS
    # Each timeframe block contains:
    #   entry signals, extrema order, RSI thresholds, 24h chg filter,
    #   DCA chg range, exit buffer, exit signals, breakout guard, breakout exit
    # ══════════════════════════════════════════════════════════════════════

    # ── 5m ────────────────────────────────────────────────────────────────
    # Entry
    entry_5m_long_enabled = False
    entry_5m_shift_long_enabled = False
    entry_5m_short_enabled = False
    entry_5m_shift_short_enabled = False
    entry_5m_rsi_long = 30
    entry_5m_rsi_short = 70
    extrema_order_5m = 5
    # 24h Change
    chg_5m_enabled = False
    chg_5m_min = -5.0
    chg_5m_max = 5.0
    dca_chg_5m_min = -10.0
    dca_chg_5m_max = 10.0
    # Exit
    chg_5m_exit_buffer_enabled = False
    chg_5m_exit_buffer = 2.0
    exit_5m_long_enabled = True
    exit_5m_shift_long_enabled = False
    exit_5m_short_enabled = True
    exit_5m_shift_short_enabled = False
    # Breakout Guard
    breakout_guard_5m_enabled = False
    breakout_guard_5m_timeframe = "1h"
    breakout_guard_5m_lookback = 10
    breakout_guard_5m_cooldown_candles = 4
    # Breakout Exit
    breakout_exit_5m_enabled = True
    breakout_exit_5m_max_profit = 0.0
    breakout_exit_5m_cooldown_enabled = True
    breakout_exit_5m_cooldown_threshold = 3
    breakout_exit_5m_cooldown_minutes = 240

    # ── 15m ───────────────────────────────────────────────────────────────
    # Entry
    entry_15m_long_enabled = False
    entry_15m_shift_long_enabled = False
    entry_15m_short_enabled = False
    entry_15m_shift_short_enabled = False
    entry_15m_rsi_long = 30
    entry_15m_rsi_short = 70
    entry_5m_rsi_long_15m = 30
    entry_5m_rsi_short_15m = 70
    extrema_order_15m = 3
    # 24h Change
    chg_15m_enabled = False
    chg_15m_min = -10.0
    chg_15m_max = 10.0
    dca_chg_15m_min = -10.0
    dca_chg_15m_max = 10.0
    # Exit
    chg_15m_exit_buffer_enabled = False
    chg_15m_exit_buffer = 2.0
    # Breakout Guard
    breakout_guard_15m_enabled = False
    breakout_guard_15m_timeframe = "1h"
    breakout_guard_15m_lookback = 10
    breakout_guard_15m_cooldown_candles = 4
    # Breakout Exit
    breakout_exit_15m_enabled = False
    breakout_exit_15m_max_profit = 0.0
    breakout_exit_15m_cooldown_enabled = False
    breakout_exit_15m_cooldown_threshold = 3
    breakout_exit_15m_cooldown_minutes = 240

    # ── 30m ───────────────────────────────────────────────────────────────
    # Entry
    entry_30m_long_enabled = True
    entry_30m_shift_long_enabled = True
    entry_30m_short_enabled = True
    entry_30m_shift_short_enabled = True
    entry_30m_rsi_long = 30
    entry_30m_rsi_short = 70
    entry_5m_rsi_long_30m = 40
    entry_5m_rsi_short_30m = 60
    extrema_order_30m = 6
    # 24h Change
    chg_30m_enabled = True
    chg_30m_min = -10.0
    chg_30m_max = 10.0
    dca_chg_30m_min = -10.0
    dca_chg_30m_max = 10.0
    # Exit
    chg_30m_exit_buffer_enabled = True
    chg_30m_exit_buffer = 2.0
    # Breakout Guard
    breakout_guard_30m_enabled = False
    breakout_guard_30m_timeframe = "1h"
    breakout_guard_30m_lookback = 10
    breakout_guard_30m_cooldown_candles = 4
    # Breakout Exit
    breakout_exit_30m_enabled = False
    breakout_exit_30m_max_profit = 0.0
    breakout_exit_30m_cooldown_enabled = False
    breakout_exit_30m_cooldown_threshold = 3
    breakout_exit_30m_cooldown_minutes = 240

    # ── 1h ────────────────────────────────────────────────────────────────
    # Entry
    entry_1h_long_enabled = True
    entry_1h_shift_long_enabled = True
    entry_1h_short_enabled = True
    entry_1h_shift_short_enabled = True
    entry_1h_rsi_long = 30
    entry_1h_rsi_short = 70
    entry_5m_rsi_long_1h = 40
    entry_5m_rsi_short_1h = 60
    extrema_order_1h = 12
    # 24h Change
    chg_1h_enabled = True
    chg_1h_min = -10.0
    chg_1h_max = 10.0
    dca_chg_1h_min = -10.0
    dca_chg_1h_max = 10.0
    # Exit
    chg_1h_exit_buffer_enabled = True
    chg_1h_exit_buffer = 2.0
    # Breakout Guard
    breakout_guard_1h_enabled = False
    breakout_guard_1h_timeframe = "1h"
    breakout_guard_1h_lookback = 10
    breakout_guard_1h_cooldown_candles = 1
    # Breakout Exit
    breakout_exit_1h_enabled = False
    breakout_exit_1h_max_profit = 0.0
    breakout_exit_1h_cooldown_enabled = False
    breakout_exit_1h_cooldown_threshold = 3
    breakout_exit_1h_cooldown_minutes = 240

    # ── 4h ────────────────────────────────────────────────────────────────
    # Entry
    entry_4h_long_enabled = True
    entry_4h_shift_long_enabled = True
    entry_4h_short_enabled = True
    entry_4h_shift_short_enabled = True
    entry_4h_rsi_long = 30
    entry_4h_rsi_short = 70
    entry_5m_rsi_long_4h = 40
    entry_5m_rsi_short_4h = 60
    extrema_order_4h = 48
    # 24h Change
    chg_4h_enabled = True
    chg_4h_min = -10.0
    chg_4h_max = 10.0
    dca_chg_4h_min = -10.0
    dca_chg_4h_max = 10.0
    # Exit
    chg_4h_exit_buffer_enabled = True
    chg_4h_exit_buffer = 2.0
    # Breakout Guard
    breakout_guard_4h_enabled = False
    breakout_guard_4h_timeframe = "1h"
    breakout_guard_4h_lookback = 10
    breakout_guard_4h_cooldown_candles = 1
    # Breakout Exit
    breakout_exit_4h_enabled = False
    breakout_exit_4h_max_profit = 0.0
    breakout_exit_4h_cooldown_enabled = False
    breakout_exit_4h_cooldown_threshold = 3
    breakout_exit_4h_cooldown_minutes = 240

    # Custom Functions
    last_entry_price: Optional[float] = None
    increment = 1.001

    # Protections
    cooldown_lookback = 1
    stop_duration = 4
    use_stop_protection = True

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

    def _is_tf_enabled(self, tf: str) -> bool:
        """Return True if any signal type is enabled for the given timeframe."""
        prefix = f"entry_{tf}_"
        return any(
            getattr(self, prefix + s, False)
            for s in ("long_enabled", "shift_long_enabled", "short_enabled", "shift_short_enabled")
        )

    def _record_breakout_exit(self, signal_tf: str, exit_time: datetime) -> None:
        """Record a breakout exit timestamp for global cooldown tracking."""
        if signal_tf not in self._breakout_exit_log:
            self._breakout_exit_log[signal_tf] = []
        self._breakout_exit_log[signal_tf].append(exit_time)

    def _is_breakout_cooldown_active(self, signal_tf: str, current_time: datetime) -> bool:
        """Return True if too many breakout exits occurred recently for this TF."""
        stf_key = signal_tf.lower()
        cd_enabled = getattr(self, f'breakout_exit_{stf_key}_cooldown_enabled', False)
        if not cd_enabled:
            return False
        from datetime import timedelta
        cd_minutes = getattr(self, f'breakout_exit_{stf_key}_cooldown_minutes', 240)
        cd_threshold = getattr(self, f'breakout_exit_{stf_key}_cooldown_threshold', 3)
        cutoff = current_time - timedelta(minutes=cd_minutes)
        if self.breakout_exit_cooldown_all_tf:
            # Count exits across ALL timeframes, use this TF's threshold/window
            total = 0
            for tf_key in list(self._breakout_exit_log.keys()):
                recent = [t for t in self._breakout_exit_log[tf_key] if t >= cutoff]
                self._breakout_exit_log[tf_key] = recent
                total += len(recent)
            return total >= cd_threshold
        else:
            exits = self._breakout_exit_log.get(signal_tf, [])
            if not exits:
                return False
            recent = [t for t in exits if t >= cutoff]
            self._breakout_exit_log[signal_tf] = recent
            return len(recent) >= cd_threshold

    def confirm_trade_entry(
            self,
            pair: str,
            order_type: str,
            amount: float,
            rate: float,
            time_in_force: str,
            current_time: datetime,
            entry_tag: Optional[str],
            side: str,
            **kwargs,
    ) -> bool:
        # Block entry when breakout exit global cooldown is active for this TF
        if entry_tag:
            signal_tf = entry_tag.split(" - ", 1)[0]
            stf_key = signal_tf.lower()
            cd_enabled = getattr(self, f'breakout_exit_{stf_key}_cooldown_enabled', False)
            if cd_enabled and self._is_breakout_cooldown_active(signal_tf, current_time):
                cd_threshold = getattr(self, f'breakout_exit_{stf_key}_cooldown_threshold', 3)
                cd_minutes = getattr(self, f'breakout_exit_{stf_key}_cooldown_minutes', 240)
                logger.info(
                    f"{pair} entry blocked: breakout exit cooldown active for {signal_tf} "
                    f"({cd_threshold} exits in {cd_minutes}min)"
                )
                return False
        return True

    @property
    def plot_config(self):
        rsi_plots = {"rsi": {"color": "#1f77b4", "type": "line"}}
        tf_rsi = {
            "15m": ("rsi_15m", "#9467bd"),
            "30m": ("rsi_30m", "#ff520e"),
            "1h": ("rsi_1h", "#ff7f0e"),
            "4h": ("rsi_4h", "#2ca02c"),
        }
        for tf, (col, color) in tf_rsi.items():
            if self._is_tf_enabled(tf):
                rsi_plots[col] = {"color": color, "type": "line", "secondary_y": False}
        return {
            "main_plot": {},
            "subplots": {
                "RSI": rsi_plots,
                "24H CHG %": {"chg_pct": {"color": "#d62728", "type": "line"}},
            },
        }

    @property
    def protections(self):
        prot = []
        prot.append(
            {"method": "CooldownPeriod", "stop_duration_candles": self.cooldown_lookback}
        )
        if self.use_stop_protection:
            prot.append(
                {
                    "method": "StoplossGuard",
                    "lookback_period_candles": 24 * 3,
                    "trade_limit": 2,
                    "stop_duration_candles": self.stop_duration,
                    "only_per_pair": False,
                }
            )
        return prot

    def custom_stake_amount(
            self,
            pair: str,
            current_time: datetime,
            current_rate: float,
            proposed_stake: float,
            min_stake: Optional[float],
            max_stake: float,
            leverage: float,
            entry_tag: Optional[str],
            side: str,
            **kwargs,
    ) -> float:
        # Split proposed stake using configurable ratios for initial entry vs DCA.
        trade = kwargs.get('trade')
        if trade is not None and hasattr(trade, 'nr_of_successful_entries'):
            if trade.nr_of_successful_entries == 0:
                return proposed_stake * self.initial_entry_stake_ratio
            else:
                return proposed_stake * self.dca_entry_stake_ratio
        else:
            return proposed_stake * self.initial_entry_stake_ratio

    def custom_entry_price(
            self,
            pair: str,
            trade: Optional["Trade"],
            current_time: datetime,
            proposed_rate: float,
            entry_tag: Optional[str],
            side: str,
            **kwargs,
    ) -> float:
        dataframe, _ = self.dp.get_analyzed_dataframe(
            pair=pair, timeframe=self.timeframe
        )
        entry_price = (dataframe["close"].iloc[-1] + dataframe["open"].iloc[-1] + proposed_rate) / 3
        if proposed_rate < entry_price:
            entry_price = proposed_rate

        logger.info(
            f"{pair} Using Entry Price: {entry_price} | close: {dataframe['close'].iloc[-1]} open: {dataframe['open'].iloc[-1]} proposed_rate: {proposed_rate}"
        )

        if self.last_entry_price is not None and abs(entry_price - self.last_entry_price) < 0.0005:
            entry_price *= self.increment
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
        if exit_reason == "trailing_stop_loss" and trade.calc_profit_ratio(rate) < 0:
            logger.info(f"{trade.pair} trailing stop price is below 0")
            self.dp.send_msg(f"{trade.pair} trailing stop price is below 0")
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
        dataframe, _ = self.dp.get_analyzed_dataframe(trade.pair, self.timeframe)
        filled_entries = trade.select_filled_orders(trade.entry_side)
        count_of_entries = trade.nr_of_successful_entries

        # Partial take-profit: scale out in two steps at +25% and +40%.
        if current_profit > 0.25 and trade.nr_of_successful_exits == 0:
            return -(trade.stake_amount / 4)
        if current_profit > 0.40 and trade.nr_of_successful_exits == 1:
            return -(trade.stake_amount / 3)

        # Allow up to max_entry_position_adjustment DCA re-entries per trade.
        if count_of_entries > self.max_entry_position_adjustment:
            return None

        # Pairlist-wide DCA limit: only N DCA orders open at a time.
        if self.max_dca_orders_open > 0:
            trades_with_dca = sum(
                1 for t in Trade.get_trades_proxy(is_open=True)
                if t.nr_of_successful_entries > 1
            )
            if trades_with_dca >= self.max_dca_orders_open:
                return None

        # Re-entry is allowed only between configured min/max DCA profit bounds.
        if count_of_entries == 1:
            min_profit = self.dca_reentry_min_profit
            max_drawdown = self.dca_reentry_max_drawdown
        else:
            min_profit = self.dca2_reentry_min_profit
            max_drawdown = self.dca2_reentry_max_drawdown
        if current_profit > min_profit or current_profit < max_drawdown:
            return None

        if not filled_entries or dataframe.empty:
            return None

        # Breakout guard: block DCA when cooldown is active (per-TF column)
        if self.breakout_guard_enabled:
            last_row = dataframe.iloc[-1]
            entry_tag = (getattr(trade, "enter_tag", "") or "").strip()
            entry_tf = entry_tag.split(" - ", 1)[0]
            cd_col = f"breakout_cooldown_{entry_tf.lower()}"
            if last_row.get(cd_col, 0) == 1 and getattr(self, f"breakout_guard_{entry_tf.lower()}_enabled", False):
                return None

        # Volatility guard over the last 10 candles.
        # Long: block DCA on sudden upward move. Short: block DCA on sudden downward move.
        if self.dca_sudden_chg_guard_enabled:
            recent_chg = dataframe["chg_pct"].tail(self.dca_sudden_chg_lookback).dropna()
            if len(recent_chg) >= 2:
                threshold = float(self.dca_sudden_chg_threshold)
                latest_chg = float(recent_chg.iloc[-1])
                chg_sudden_increase = (latest_chg - float(recent_chg.min())) >= threshold
                chg_sudden_decrease = (float(recent_chg.max()) - latest_chg) >= threshold

                is_short_trade = bool(getattr(trade, "is_short", False))
                if (not is_short_trade and chg_sudden_increase) or (is_short_trade and chg_sudden_decrease):
                    return None

        last_candle = dataframe.iloc[-1]
        shifted_candle = dataframe.iloc[-(self.shift_lookback + 1)] if len(dataframe) >= (self.shift_lookback + 1) else None
        is_short_trade = bool(getattr(trade, "is_short", False))
        entry_tag = (getattr(trade, "enter_tag", "") or "").strip()

        def chg_ok(column_name: str, min_value: float, max_value: float, enabled: bool = True) -> bool:
            if not self.use_chg_filter or not enabled:
                return True
            value = last_candle.get(column_name, 0)
            return min_value <= value <= max_value

        if is_short_trade:
            signal_by_tag = {
                "5M - Short": self.entry_5m_short_enabled and (
                    last_candle.get("maxima_check", 1) == 0
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 0) > self.entry_5m_rsi_short
                    and chg_ok("chg_pct", self.dca_chg_5m_min, self.dca_chg_5m_max, self.chg_5m_enabled)
                ),
                "5M - Shift Short": self.entry_5m_shift_short_enabled and (
                    last_candle.get("DI_catch", 0) == 0
                    and last_candle.get("maxima_check", 1) == 0
                    and shifted_candle is not None
                    and shifted_candle.get("maxima_check", 0) == 1
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 0) > self.entry_5m_rsi_short
                    and chg_ok("chg_pct", self.dca_chg_5m_min, self.dca_chg_5m_max, self.chg_5m_enabled)
                ),
                "15M - Short": self.entry_15m_short_enabled and (
                    last_candle.get("maxima_check_15m", 1) == 0
                    and last_candle.get("volume_15m", 0) > 0
                    and last_candle.get("rsi_15m", 0) > self.entry_15m_rsi_short
                    and chg_ok("chg_pct", self.dca_chg_15m_min, self.dca_chg_15m_max, self.chg_15m_enabled)
                    and last_candle.get("maxima_check", 0) == 1
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 0) > self.entry_5m_rsi_short_15m
                ),
                "15M - Shift Short": self.entry_15m_shift_short_enabled and (
                    last_candle.get("DI_catch_15m", 0) == 0
                    and last_candle.get("maxima_check_15m", 1) == 0
                    and shifted_candle is not None
                    and shifted_candle.get("maxima_check", 0) == 1
                    and last_candle.get("volume_15m", 0) > 0
                    and last_candle.get("rsi_15m", 0) > self.entry_15m_rsi_short
                    and chg_ok("chg_pct", self.dca_chg_15m_min, self.dca_chg_15m_max, self.chg_15m_enabled)
                    and last_candle.get("maxima_check", 1) == 0
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 0) > self.entry_5m_rsi_short_15m
                ),
                "30M - Short": self.entry_30m_short_enabled and (
                    last_candle.get("maxima_check_30m", 1) == 0
                    and last_candle.get("volume_30m", 0) > 0
                    and last_candle.get("rsi_30m", 0) > self.entry_30m_rsi_short
                    and chg_ok("chg_pct", self.dca_chg_30m_min, self.dca_chg_30m_max, self.chg_30m_enabled)
                    and last_candle.get("maxima_check", 0) == 1
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 0) > self.entry_5m_rsi_short_30m
                ),
                "30M - Shift Short": self.entry_30m_shift_short_enabled and (
                    last_candle.get("DI_catch_30m", 0) == 0
                    and last_candle.get("maxima_check_30m", 1) == 0
                    and shifted_candle is not None
                    and shifted_candle.get("maxima_check", 0) == 1
                    and last_candle.get("volume_30m", 0) > 0
                    and last_candle.get("rsi_30m", 0) > self.entry_30m_rsi_short
                    and chg_ok("chg_pct", self.dca_chg_30m_min, self.dca_chg_30m_max, self.chg_30m_enabled)
                    and last_candle.get("maxima_check", 1) == 0
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 0) > self.entry_5m_rsi_short_30m
                ),
                "1H - Short": self.entry_1h_short_enabled and (
                    last_candle.get("maxima_check_1h", 1) == 0
                    and last_candle.get("volume_1h", 0) > 0
                    and last_candle.get("rsi_1h", 0) > self.entry_1h_rsi_short
                    and chg_ok("chg_pct", self.dca_chg_1h_min, self.dca_chg_1h_max, self.chg_1h_enabled)
                    and last_candle.get("maxima_check", 0) == 1
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 0) > self.entry_5m_rsi_short_1h
                ),
                "1H - Shift Short": self.entry_1h_shift_short_enabled and (
                    last_candle.get("DI_catch_1h", 0) == 0
                    and last_candle.get("maxima_check_1h", 1) == 0
                    and shifted_candle is not None
                    and shifted_candle.get("maxima_check", 0) == 1
                    and last_candle.get("volume_1h", 0) > 0
                    and last_candle.get("rsi_1h", 0) > self.entry_1h_rsi_short
                    and chg_ok("chg_pct", self.dca_chg_1h_min, self.dca_chg_1h_max, self.chg_1h_enabled)
                    and last_candle.get("maxima_check", 1) == 0
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 0) > self.entry_5m_rsi_short_1h
                ),
                "4H - Short": self.entry_4h_short_enabled and (
                    last_candle.get("maxima_check_4h", 1) == 0
                    and last_candle.get("volume_4h", 0) > 0
                    and last_candle.get("rsi_4h", 0) > self.entry_4h_rsi_short
                    and chg_ok("chg_pct", self.dca_chg_4h_min, self.dca_chg_4h_max, self.chg_4h_enabled)
                    and last_candle.get("maxima_check", 0) == 1
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 0) > self.entry_5m_rsi_short_4h
                ),
                "4H - Shift Short": self.entry_4h_shift_short_enabled and (
                    last_candle.get("DI_catch_4h", 0) == 0
                    and last_candle.get("maxima_check_4h", 1) == 0
                    and shifted_candle is not None
                    and shifted_candle.get("maxima_check", 0) == 1
                    and last_candle.get("volume_4h", 0) > 0
                    and last_candle.get("rsi_4h", 0) > self.entry_4h_rsi_short
                    and chg_ok("chg_pct", self.dca_chg_4h_min, self.dca_chg_4h_max, self.chg_4h_enabled)
                    and last_candle.get("maxima_check", 1) == 0
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 0) > self.entry_5m_rsi_short_4h
                ),
            }
        else:
            signal_by_tag = {
                "5M - Long": self.entry_5m_long_enabled and (
                    last_candle.get("minima_check", 1) == 0
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 100) < self.entry_5m_rsi_long
                    and chg_ok("chg_pct", self.dca_chg_5m_min, self.dca_chg_5m_max, self.chg_5m_enabled)
                ),
                "5M - Shift Long": self.entry_5m_shift_long_enabled and (
                    last_candle.get("DI_catch", 0) == 1
                    and last_candle.get("minima_check", 1) == 0
                    and shifted_candle is not None
                    and shifted_candle.get("minima_check", 0) == 1
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 100) < self.entry_5m_rsi_long
                    and chg_ok("chg_pct", self.dca_chg_5m_min, self.dca_chg_5m_max, self.chg_5m_enabled)
                ),
                "15M - Long": self.entry_15m_long_enabled and (
                    last_candle.get("minima_check_15m", 1) == 0
                    and last_candle.get("volume_15m", 0) > 0
                    and last_candle.get("rsi_15m", 100) < self.entry_15m_rsi_long
                    and chg_ok("chg_pct", self.dca_chg_15m_min, self.dca_chg_15m_max, self.chg_15m_enabled)
                    and last_candle.get("minima_check", 1) == 0
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 100) < self.entry_5m_rsi_long_15m
                ),
                "15M - Shift Long": self.entry_15m_shift_long_enabled and (
                    last_candle.get("DI_catch_15m", 0) == 1
                    and last_candle.get("minima_check_15m", 1) == 0
                    and shifted_candle is not None
                    and shifted_candle.get("minima_check", 0) == 1
                    and last_candle.get("volume_15m", 0) > 0
                    and last_candle.get("rsi_15m", 100) < self.entry_15m_rsi_long
                    and chg_ok("chg_pct", self.dca_chg_15m_min, self.dca_chg_15m_max, self.chg_15m_enabled)
                    and last_candle.get("minima_check", 1) == 0
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 100) < self.entry_5m_rsi_long_15m
                ),
                "30M - Long": self.entry_30m_long_enabled and (
                    last_candle.get("minima_check_30m", 1) == 0
                    and last_candle.get("volume_30m", 0) > 0
                    and last_candle.get("rsi_30m", 100) < self.entry_30m_rsi_long
                    and chg_ok("chg_pct", self.dca_chg_30m_min, self.dca_chg_30m_max, self.chg_30m_enabled)
                    and last_candle.get("minima_check", 1) == 0
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 100) < self.entry_5m_rsi_long_30m
                ),
                "30M - Shift Long": self.entry_30m_shift_long_enabled and (
                    last_candle.get("DI_catch_30m", 0) == 1
                    and last_candle.get("minima_check_30m", 1) == 0
                    and shifted_candle is not None
                    and shifted_candle.get("minima_check", 0) == 1
                    and last_candle.get("volume_30m", 0) > 0
                    and last_candle.get("rsi_30m", 100) < self.entry_30m_rsi_long
                    and chg_ok("chg_pct", self.dca_chg_30m_min, self.dca_chg_30m_max, self.chg_30m_enabled)
                    and last_candle.get("minima_check", 1) == 0
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 100) < self.entry_5m_rsi_long_30m
                ),
                "1H - Long": self.entry_1h_long_enabled and (
                    last_candle.get("minima_check_1h", 1) == 0
                    and last_candle.get("volume_1h", 0) > 0
                    and last_candle.get("rsi_1h", 100) < self.entry_1h_rsi_long
                    and chg_ok("chg_pct", self.dca_chg_1h_min, self.dca_chg_1h_max, self.chg_1h_enabled)
                    and last_candle.get("minima_check", 1) == 0
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 100) < self.entry_5m_rsi_long_1h
                ),
                "1H - Shift Long": self.entry_1h_shift_long_enabled and (
                    last_candle.get("DI_catch_1h", 0) == 1
                    and last_candle.get("minima_check_1h", 1) == 0
                    and shifted_candle is not None
                    and shifted_candle.get("minima_check", 0) == 1
                    and last_candle.get("volume_1h", 0) > 0
                    and last_candle.get("rsi_1h", 100) < self.entry_1h_rsi_long
                    and chg_ok("chg_pct", self.dca_chg_1h_min, self.dca_chg_1h_max, self.chg_1h_enabled)
                    and last_candle.get("minima_check", 1) == 0
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 100) < self.entry_5m_rsi_long_1h
                ),
                "4H - Long": self.entry_4h_long_enabled and (
                    last_candle.get("minima_check_4h", 1) == 0
                    and last_candle.get("volume_4h", 0) > 0
                    and last_candle.get("rsi_4h", 100) < self.entry_4h_rsi_long
                    and chg_ok("chg_pct", self.dca_chg_4h_min, self.dca_chg_4h_max, self.chg_4h_enabled)
                    and last_candle.get("minima_check", 1) == 0
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 100) < self.entry_5m_rsi_long_4h
                ),
                "4H - Shift Long": self.entry_4h_shift_long_enabled and (
                    last_candle.get("DI_catch_4h", 0) == 1
                    and last_candle.get("minima_check_4h", 1) == 0
                    and shifted_candle is not None
                    and shifted_candle.get("minima_check", 0) == 1
                    and last_candle.get("volume_4h", 0) > 0
                    and last_candle.get("rsi_4h", 100) < self.entry_4h_rsi_long
                    and chg_ok("chg_pct", self.dca_chg_4h_min, self.dca_chg_4h_max, self.chg_4h_enabled)
                    and last_candle.get("minima_check", 1) == 0
                    and last_candle.get("volume", 0) > 0
                    and last_candle.get("rsi", 100) < self.entry_5m_rsi_long_4h
                ),
            }

        matching_signal_tags = [tag for tag, is_active in signal_by_tag.items() if is_active]
        if not matching_signal_tags:
            return None

        # DCA is allowed only when an active signal is from the same timeframe as the original entry.
        if entry_tag:
            entry_timeframe = entry_tag.split(" - ", 1)[0]
            active_timeframes = {tag.split(" - ", 1)[0] for tag in matching_signal_tags}
            if entry_timeframe not in active_timeframes:
                return None

        try:
            # Reuse the initial filled-entry size, with optional geometric scaling when configured.
            stake_amount = filled_entries[0].cost
            scale_setting = getattr(self, "safety_order_volume_scale", 1.0)
            dca_scale = float(getattr(scale_setting, "value", scale_setting)) ** (count_of_entries - 1)
            stake_amount = stake_amount * dca_scale
            
            if min_stake is not None and stake_amount < min_stake:
                return None

            return min(stake_amount, max_stake)
        except Exception as exception:
            logger.debug("DCA position adjust failed for %s: %s", trade.pair, exception)
            return None
        return None

    def leverage(
            self,
            pair: str,
            current_time: "datetime",
            current_rate: float,
            proposed_leverage: float,
            max_leverage: float,
            side: str,
            **kwargs,
    ) -> float:
        # Leverage is configurable and capped by exchange/pair max leverage.
        return max(min(self.leverage_value, max_leverage), 1.0)

    def custom_stoploss(
            self,
            pair: str,
            trade: Trade,
            current_time: datetime,
            current_rate: float,
            current_profit: float,
            **kwargs,
    ) -> float:
        if trade.nr_of_successful_entries > 1:
            return stoploss_from_open(self.dca_stoploss, current_profit)
        return self.stoploss

    def custom_exit(
            self,
            pair: str,
            trade: Trade,
            current_time: datetime,
            current_rate: float,
            current_profit: float,
            **kwargs,
    ) -> Optional[str]:
        dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        if dataframe.empty:
            return None

        # ── Breakout exit: close trade when range breaks in adverse direction ──
        if self.breakout_exit_enabled and self.breakout_guard_enabled:
            entry_tag = (getattr(trade, "enter_tag", "") or "").strip()
            entry_tf = entry_tag.split(" - ", 1)[0]
            be_flag_by_tf = {
                "5M": self.breakout_exit_5m_enabled,
                "15M": self.breakout_exit_15m_enabled,
                "30M": self.breakout_exit_30m_enabled,
                "1H": self.breakout_exit_1h_enabled,
                "4H": self.breakout_exit_4h_enabled,
            }
            if be_flag_by_tf.get(entry_tf, True):
                last_row = dataframe.iloc[-1]
                stf_key = entry_tf.lower()
                mtf = getattr(self, f'breakout_guard_{stf_key}_timeframe', '4h')
                range_high = last_row.get(f"bg_rh_{stf_key}_{mtf}", np.nan)
                range_low = last_row.get(f"bg_rl_{stf_key}_{mtf}", np.nan)
                is_short = bool(getattr(trade, "is_short", False))
                be_max_profit = getattr(self, f'breakout_exit_{stf_key}_max_profit', 0.0)
                if current_profit <= be_max_profit:
                    if not is_short and not pd.isna(range_low) and last_row["low"] < range_low:
                        self._record_breakout_exit(entry_tf, current_time)
                        return "breakout_exit_long"
                    if is_short and not pd.isna(range_high) and last_row["high"] > range_high:
                        self._record_breakout_exit(entry_tf, current_time)
                        return "breakout_exit_short"

        chg_value = dataframe.iloc[-1].get("chg_pct", np.nan)
        if pd.isna(chg_value):
            return None

        timeframe = (getattr(trade, "enter_tag", "") or "").split(" - ", 1)[0]
        bounds_by_tf = {
            "5M": (self.chg_5m_min, self.chg_5m_max),
            "15M": (self.chg_15m_min, self.chg_15m_max),
            "30M": (self.chg_30m_min, self.chg_30m_max),
            "1H": (self.chg_1h_min, self.chg_1h_max),
            "4H": (self.chg_4h_min, self.chg_4h_max),
        }
        buffers_by_tf = {
            "5M": self.chg_5m_exit_buffer,
            "15M": self.chg_15m_exit_buffer,
            "30M": self.chg_30m_exit_buffer,
            "1H": self.chg_1h_exit_buffer,
            "4H": self.chg_4h_exit_buffer,
        }
        buffer_enabled_by_tf = {
            "5M": self.chg_5m_exit_buffer_enabled,
            "15M": self.chg_15m_exit_buffer_enabled,
            "30M": self.chg_30m_exit_buffer_enabled,
            "1H": self.chg_1h_exit_buffer_enabled,
            "4H": self.chg_4h_exit_buffer_enabled,
        }
        bounds = bounds_by_tf.get(timeframe)
        if not bounds:
            return None
        if not self.use_chg_exit_buffer or not buffer_enabled_by_tf.get(timeframe, True):
            return None
        else:
            exit_buffer = buffers_by_tf.get(timeframe, 2.0)

        chg_min, chg_max = bounds
        lower_exit = chg_min - exit_buffer
        upper_exit = chg_max + exit_buffer
        chg_value = float(chg_value)
        is_short_trade = bool(getattr(trade, "is_short", False))

        # Long: use the downside breach (min - buffer). Short: use the upside breach (max + buffer).
        if not is_short_trade and chg_value <= lower_exit:
            return f"chg_below_{timeframe.lower()}_{lower_exit:.1f}"
        if is_short_trade and chg_value >= upper_exit:
            return f"chg_above_{timeframe.lower()}_{upper_exit:.1f}"

        return None

    def _bg_monitor_tfs(self):
        """Return set of unique monitoring timeframes needed by enabled breakout guards."""
        tfs = set()
        if self.breakout_guard_enabled:
            for stf in ('5m', '15m', '30m', '1h', '4h'):
                if getattr(self, f'breakout_guard_{stf}_enabled', False):
                    tfs.add(getattr(self, f'breakout_guard_{stf}_timeframe', '4h'))
        return tfs

    def informative_pairs(self):
        pairs = self.dp.current_whitelist()
        informative_pairs = []
        needed_tfs = set()
        for tf in ('15m', '30m', '1h', '4h'):
            if self._is_tf_enabled(tf):
                needed_tfs.add(tf)
        needed_tfs |= self._bg_monitor_tfs()
        for tf in needed_tfs:
            informative_pairs += [(pair, tf) for pair in pairs]
        return informative_pairs

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        pair = metadata['pair']

        # Collect needed informative timeframes
        bg_monitor_tfs = self._bg_monitor_tfs()
        needed_tfs = set()
        for tf in ('15m', '30m', '1h', '4h'):
            if self._is_tf_enabled(tf):
                needed_tfs.add(tf)
        needed_tfs |= bg_monitor_tfs

        # Manually merge informative data only for needed timeframes
        for tf in needed_tfs:
            inf_df = self.dp.get_pair_dataframe(pair, tf)
            if not inf_df.empty:
                # Signal indicators (only for standard signal TFs)
                if tf in ('15m', '30m', '1h', '4h') and self._is_tf_enabled(tf):
                    inf_df["rsi"] = ta.RSI(inf_df)
                    di_vals = ta.PLUS_DI(inf_df) - ta.MINUS_DI(inf_df)
                    inf_df["DI_catch"] = np.where(di_vals > 0, 0, 1)
                # Breakout guard: per-signal-TF range boundaries
                if self.breakout_guard_enabled:
                    for stf in ('5m', '15m', '30m', '1h', '4h'):
                        if getattr(self, f'breakout_guard_{stf}_enabled', False):
                            if getattr(self, f'breakout_guard_{stf}_timeframe', '4h') == tf:
                                lb = getattr(self, f'breakout_guard_{stf}_lookback', 10)
                                inf_df[f"bg_rh_{stf}"] = inf_df["high"].rolling(lb).max()
                                inf_df[f"bg_rl_{stf}"] = inf_df["low"].rolling(lb).min()
                dataframe = merge_informative_pair(
                    dataframe, inf_df, self.timeframe, tf, ffill=True
                )
        # Ensure columns exist even if TF disabled or data missing
        for tf in ('15m', '30m', '1h', '4h'):
            for col in [f"rsi_{tf}", f"DI_catch_{tf}", f"volume_{tf}"]:
                if col not in dataframe.columns:
                    dataframe[col] = 0

        # Real-time breakout detection on 5m candles — per signal TF
        tf_to_minutes = {
            "5m": 5, "15m": 15, "30m": 30, "1h": 60,
            "2h": 120, "4h": 240, "8h": 480, "1d": 1440,
        }
        if self.breakout_guard_enabled:
            for stf in ('5m', '15m', '30m', '1h', '4h'):
                if getattr(self, f'breakout_guard_{stf}_enabled', False):
                    mtf = getattr(self, f'breakout_guard_{stf}_timeframe', '4h')
                    rh_col = f"bg_rh_{stf}_{mtf}"
                    rl_col = f"bg_rl_{stf}_{mtf}"
                    if rh_col not in dataframe.columns:
                        dataframe[rh_col] = np.nan
                    if rl_col not in dataframe.columns:
                        dataframe[rl_col] = np.nan
                    breakout = (
                        (dataframe["high"] > dataframe[rh_col])
                        | (dataframe["low"] < dataframe[rl_col])
                    ).astype(int)
                    inf_minutes = tf_to_minutes.get(mtf, 240)
                    cd_val = getattr(self, f'breakout_guard_{stf}_cooldown_candles', 1)
                    cd_5m = max(cd_val * (inf_minutes // 5), 1)
                    dataframe[f"breakout_cooldown_{stf}"] = (
                        breakout.rolling(cd_5m, min_periods=1).max().fillna(0).astype(int)
                    )
                else:
                    dataframe[f"breakout_cooldown_{stf}"] = 0
        else:
            for stf in ('5m', '15m', '30m', '1h', '4h'):
                dataframe[f"breakout_cooldown_{stf}"] = 0

        # Basic Indicators  
        dataframe["rsi"] = ta.RSI(dataframe)
        # 24h change on base timeframe candles (5m -> 288 candles per day).
        dataframe["chg_pct"] = np.where(
            dataframe["close"].shift(288) > 0,
            ((dataframe["close"] - dataframe["close"].shift(288)) / dataframe["close"].shift(288)) * 100,
            np.nan,
        )

        # DI logic for "DI_catch"
        di_values = ta.PLUS_DI(dataframe) - ta.MINUS_DI(dataframe)
        dataframe["DI_catch"] = np.where(di_values > 0, 0, 1)

        # Local Extrema (Order 5)
        maxima = np.zeros(len(dataframe))
        minima = np.zeros(len(dataframe))

        maxima[argrelextrema(dataframe["close"].values, np.greater, order=self.extrema_order_5m)] = 1
        minima[argrelextrema(dataframe["close"].values, np.less, order=self.extrema_order_5m)] = 1

        dataframe["maxima"] = maxima
        dataframe["minima"] = minima

        # Check if a minima/maxima occurred within the last 4 periods
        # Note: Logic remains '0' if a peak exists, '1' if no peak exists per your original code
        dataframe["maxima_check"] = (
            dataframe["maxima"].rolling(4).apply(lambda x: int((x != 1).all()), raw=True).fillna(0)
        )
        dataframe["minima_check"] = (
            dataframe["minima"].rolling(4).apply(lambda x: int((x != 1).all()), raw=True).fillna(0)
        )

        # Higher timeframe equivalent extrema on 5m candles
        for tf_label, order in [("15m", self.extrema_order_15m), ("30m", self.extrema_order_30m), ("1h", self.extrema_order_1h), ("4h", self.extrema_order_4h)]:
            _maxima = np.zeros(len(dataframe))
            _minima = np.zeros(len(dataframe))
            _maxima[argrelextrema(dataframe["close"].values, np.greater, order=order)] = 1
            _minima[argrelextrema(dataframe["close"].values, np.less, order=order)] = 1
            dataframe[f"maxima_check_{tf_label}"] = (
                pd.Series(_maxima, index=dataframe.index).rolling(4).sum().fillna(0) == 0
            ).astype(int)
            dataframe[f"minima_check_{tf_label}"] = (
                pd.Series(_minima, index=dataframe.index).rolling(4).sum().fillna(0) == 0
            ).astype(int)
                
        return dataframe

    def _notify_chg_in_range(self, df: DataFrame, metadata: dict) -> None:
        if not self.telegram_chg_alert_enabled or df.empty:
            return
        if not getattr(self, "dp", None):
            return

        pair = metadata.get("pair", "")
        if not pair:
            return

        last_candle = df.iloc[-1]
        chg_value = last_candle.get("chg_pct", np.nan)
        if pd.isna(chg_value):
            return

        chg_value = float(chg_value)
        if chg_value <= self.telegram_chg_min:
            zone = "below"
        elif chg_value >= self.telegram_chg_max:
            zone = "above"
        else:
            zone = "within"

        state = self.telegram_chg_alert_state.get(pair, {"zone": "within"})
        prev_zone = state.get("zone", "within")

        if zone != prev_zone and zone in {"below", "above"}:
            if zone == "below":
                msg = (
                    f"{pair} 24h chg% dropped below {self.telegram_chg_min:.2f}% -> {chg_value:.2f}%"
                )
            else:
                msg = (
                    f"{pair} 24h chg% rose above {self.telegram_chg_max:.2f}% -> {chg_value:.2f}%"
                )
            try:
                self.dp.send_msg(msg)
            except Exception as exception:
                logger.debug("Telegram chg alert failed for %s: %s", pair, exception)

        state["zone"] = zone
        self.telegram_chg_alert_state[pair] = state

    def populate_entry_trend(self, df: DataFrame, metadata: dict) -> DataFrame:

        self._notify_chg_in_range(df, metadata)

        chg_5m_ok = True
        chg_15m_ok = True
        chg_30m_ok = True
        chg_1h_ok = True
        chg_4h_ok = True
        if self.use_chg_filter:
            chg_5m_ok = (
                (df["chg_pct"] >= self.chg_5m_min) & (df["chg_pct"] <= self.chg_5m_max)
            ) if self.chg_5m_enabled else True
            chg_15m_ok = (
                (df["chg_pct"] >= self.chg_15m_min) & (df["chg_pct"] <= self.chg_15m_max)
            ) if self.chg_15m_enabled else True
            chg_30m_ok = (
                (df["chg_pct"] >= self.chg_30m_min) & (df["chg_pct"] <= self.chg_30m_max)
            ) if self.chg_30m_enabled else True
            chg_1h_ok = (
                (df["chg_pct"] >= self.chg_1h_min) & (df["chg_pct"] <= self.chg_1h_max)
            ) if self.chg_1h_enabled else True
            chg_4h_ok = (
                (df["chg_pct"] >= self.chg_4h_min) & (df["chg_pct"] <= self.chg_4h_max)
            ) if self.chg_4h_enabled else True

        # Breakout guard: block entries when cooldown is active (per-timeframe)
        breakout_5m_ok = ~(df["breakout_cooldown_5m"] == 1) if (self.breakout_guard_enabled and self.breakout_guard_5m_enabled) else True
        breakout_15m_ok = ~(df["breakout_cooldown_15m"] == 1) if (self.breakout_guard_enabled and self.breakout_guard_15m_enabled) else True
        breakout_30m_ok = ~(df["breakout_cooldown_30m"] == 1) if (self.breakout_guard_enabled and self.breakout_guard_30m_enabled) else True
        breakout_1h_ok = ~(df["breakout_cooldown_1h"] == 1) if (self.breakout_guard_enabled and self.breakout_guard_1h_enabled) else True
        breakout_4h_ok = ~(df["breakout_cooldown_4h"] == 1) if (self.breakout_guard_enabled and self.breakout_guard_4h_enabled) else True

        # ===== LONG ENTRIES - 5m ONLY =====

        df.loc[
            (
                self.entry_5m_long_enabled
                & (df["minima_check"] == 0)
                & (df["volume"] > 0)
                & (df["rsi"] < self.entry_5m_rsi_long)
                & chg_5m_ok
                & breakout_5m_ok
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "5M - Long")

        df.loc[
            (
                self.entry_5m_shift_long_enabled
                & (df["DI_catch"] == 1)
                & (df["minima_check"] == 0)
                & (df["minima_check"].shift(self.shift_lookback) == 1)
                & (df["volume"] > 0)
                & (df["rsi"] < self.entry_5m_rsi_long)
                & chg_5m_ok
                & breakout_5m_ok
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "5M - Shift Long")

        # ===== LONG ENTRIES - 15m ONLY =====

        df.loc[
            (
                self.entry_15m_long_enabled
                & (df["minima_check_15m"] == 0)
                & (df["volume_15m"] > 0)
                & (df["rsi_15m"] < self.entry_15m_rsi_long)
                & chg_15m_ok
                & (df["minima_check"] == 0)
                & (df["volume"] > 0)
                & (df["rsi"] < self.entry_5m_rsi_long_15m)
                & breakout_15m_ok
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "15M - Long")

        df.loc[
            (
                self.entry_15m_shift_long_enabled
                & (df["DI_catch_15m"] == 1)
                & (df["minima_check_15m"] == 0)
                & (df["minima_check"].shift(self.shift_lookback) == 1)
                & (df["volume_15m"] > 0)
                & (df["rsi_15m"] < self.entry_15m_rsi_long)
                & chg_15m_ok
                & (df["minima_check"] == 0)
                & (df["volume"] > 0)
                & (df["rsi"] < self.entry_5m_rsi_long_15m)
                & breakout_15m_ok
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "15M - Shift Long")

        # ===== LONG ENTRIES - 30M ONLY =====

        df.loc[
            (
                self.entry_30m_long_enabled
                &(df["minima_check_30m"] == 0)
                & (df["volume_30m"] > 0)
                & (df["rsi_30m"] < self.entry_30m_rsi_long)
                & chg_30m_ok
                & (df["minima_check"] == 0)
                & (df["volume"] > 0)
                & (df["rsi"] < self.entry_5m_rsi_long_30m)
                & breakout_30m_ok
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "30M - Long")

        df.loc[
            (
                self.entry_30m_shift_long_enabled
                &(df["DI_catch_30m"] == 1) 
                & (df["minima_check_30m"] == 0)
                & (df["minima_check"].shift(self.shift_lookback) == 1) 
                & (df["volume_30m"] > 0)
                & (df["rsi_30m"] < self.entry_30m_rsi_long)
                & chg_30m_ok
                & (df["minima_check"] == 0)
                & (df["volume"] > 0)
                & (df["rsi"] < self.entry_5m_rsi_long_30m)
                & breakout_30m_ok
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "30M - Shift Long")        

        # ===== LONG ENTRIES - 1h ONLY =====

        df.loc[
            (
                self.entry_1h_long_enabled
                &(df["minima_check_1h"] == 0)
                & (df["volume_1h"] > 0)
                & (df["rsi_1h"] < self.entry_1h_rsi_long)
                & chg_1h_ok
                & (df["minima_check"] == 0)
                & (df["volume"] > 0)
                & (df["rsi"] < self.entry_5m_rsi_long_1h)
                & breakout_1h_ok
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "1H - Long")

        df.loc[
            (
                self.entry_1h_shift_long_enabled
                &(df["DI_catch_1h"] == 1) 
                & (df["minima_check_1h"] == 0)
                & (df["minima_check"].shift(self.shift_lookback) == 1) 
                & (df["volume_1h"] > 0)
                & (df["rsi_1h"] < self.entry_1h_rsi_long)
                & chg_1h_ok
                & (df["minima_check"] == 0)
                & (df["volume"] > 0)
                & (df["rsi"] < self.entry_5m_rsi_long_1h)
                & breakout_1h_ok
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "1H - Shift Long")

        # ===== LONG ENTRIES - 4h ONLY =====

        df.loc[
            (
                self.entry_4h_long_enabled
                &(df["minima_check_4h"] == 0)
                & (df["volume_4h"] > 0)
                & (df["rsi_4h"] < self.entry_4h_rsi_long)
                & chg_4h_ok
                & (df["minima_check"] == 0)
                & (df["volume"] > 0)
                & (df["rsi"] < self.entry_5m_rsi_long_4h)
                & breakout_4h_ok
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "4H - Long")

        df.loc[
            (
                self.entry_4h_shift_long_enabled
                &(df["DI_catch_4h"] == 1) 
                & (df["minima_check_4h"] == 0)
                & (df["minima_check"].shift(self.shift_lookback) == 1) 
                & (df["volume_4h"] > 0)
                & (df["rsi_4h"] < self.entry_4h_rsi_long)
                & chg_4h_ok
                & (df["minima_check"] == 0)
                & (df["volume"] > 0)
                & (df["rsi"] < self.entry_5m_rsi_long_4h)
                & breakout_4h_ok
            ),
            ["enter_long", "enter_tag"],
        ] = (1, "4H - Shift Long")

        # ===== SHORT ENTRIES - 5m ONLY =====

        df.loc[
            (
                self.entry_5m_short_enabled
                & (df["maxima_check"] == 0)
                & (df["volume"] > 0)
                & (df["rsi"] > self.entry_5m_rsi_short)
                & chg_5m_ok
                & breakout_5m_ok
            ),
            ["enter_short", "enter_tag"],
        ] = (1, "5M - Short")

        df.loc[
            (
                self.entry_5m_shift_short_enabled
                & (df["DI_catch"] == 0)
                & (df["maxima_check"] == 0)
                & (df["maxima_check"].shift(self.shift_lookback) == 1)
                & (df["volume"] > 0)
                & (df["rsi"] > self.entry_5m_rsi_short)
                & chg_5m_ok
                & breakout_5m_ok
            ),
            ["enter_short", "enter_tag"],
        ] = (1, "5M - Shift Short")

        # ===== SHORT ENTRIES - 15m ONLY =====

        df.loc[
            (
                self.entry_15m_short_enabled
                & (df["maxima_check_15m"] == 0)
                & (df["volume_15m"] > 0)
                & (df["rsi_15m"] > self.entry_15m_rsi_short)
                & chg_15m_ok
                & (df["maxima_check"] == 1)
                & (df["volume"] > 0)
                & (df["rsi"] > self.entry_5m_rsi_short_15m)
                & breakout_15m_ok
            ),
            ["enter_short", "enter_tag"],
        ] = (1, "15M - Short")

        df.loc[
            (
                self.entry_15m_shift_short_enabled
                & (df["DI_catch_15m"] == 0)
                & (df["maxima_check_15m"] == 0)
                & (df["maxima_check"].shift(self.shift_lookback) == 1)
                & (df["volume_15m"] > 0)
                & (df["rsi_15m"] > self.entry_15m_rsi_short)
                & chg_15m_ok
                & (df["maxima_check"] == 0)
                & (df["volume"] > 0)
                & (df["rsi"] > self.entry_5m_rsi_short_15m)
                & breakout_15m_ok
            ),
            ["enter_short", "enter_tag"],
        ] = (1, "15M - Shift Short")

        # ===== SHORT ENTRIES - 30m ONLY =====

        df.loc[
            (
                self.entry_30m_short_enabled
                &(df["maxima_check_30m"] == 0)
                & (df["volume_30m"] > 0)
                & (df["rsi_30m"] > self.entry_30m_rsi_short)
                & chg_30m_ok
                & (df["maxima_check"] == 1)
                & (df["volume"] > 0)
                & (df["rsi"] > self.entry_5m_rsi_short_30m)
                & breakout_30m_ok
            ),
            ["enter_short", "enter_tag"],
        ] = (1, "30M - Short")

        df.loc[
            (
                self.entry_30m_shift_short_enabled
                &(df["DI_catch_30m"] == 0) 
                & (df["maxima_check_30m"] == 0)
                & (df["maxima_check"].shift(self.shift_lookback) == 1) 
                & (df["volume_30m"] > 0)
                & (df["rsi_30m"] > self.entry_30m_rsi_short)
                & chg_30m_ok
                & (df["maxima_check"] == 0)
                & (df["volume"] > 0)
                & (df["rsi"] > self.entry_5m_rsi_short_30m)
                & breakout_30m_ok
            ),
            ["enter_short", "enter_tag"],
        ] = (1, "30M - Shift Short")

        # ===== SHORT ENTRIES - 1h ONLY =====

        df.loc[
            (
                self.entry_1h_short_enabled
                &
                (df["maxima_check_1h"] == 0)
                & (df["volume_1h"] > 0)
                & (df["rsi_1h"] > self.entry_1h_rsi_short)
                & chg_1h_ok
                & (df["maxima_check"] == 1)
                & (df["volume"] > 0)
                & (df["rsi"] > self.entry_5m_rsi_short_1h)
                & breakout_1h_ok
            ),
            ["enter_short", "enter_tag"],
        ] = (1, "1H - Short")

        df.loc[
            (
                self.entry_1h_shift_short_enabled
                &(df["DI_catch_1h"] == 0) 
                & (df["maxima_check_1h"] == 0)
                & (df["maxima_check"].shift(self.shift_lookback) == 1) 
                & (df["volume_1h"] > 0)
                & (df["rsi_1h"] > self.entry_1h_rsi_short)
                & chg_1h_ok
                & (df["maxima_check"] == 0)
                & (df["volume"] > 0)
                & (df["rsi"] > self.entry_5m_rsi_short_1h)
                & breakout_1h_ok
            ),
            ["enter_short", "enter_tag"],
        ] = (1, "1H - Shift Short")

        # ===== SHORT ENTRIES - 4h ONLY =====

        df.loc[
            (
                self.entry_4h_short_enabled
                &(df["maxima_check_4h"] == 0)
                & (df["volume_4h"] > 0)
                & (df["rsi_4h"] > self.entry_4h_rsi_short)
                & chg_4h_ok
                & (df["maxima_check"] == 1)
                & (df["volume"] > 0)
                & (df["rsi"] > self.entry_5m_rsi_short_4h)
                & breakout_4h_ok
            ),
            ["enter_short", "enter_tag"],
        ] = (1, "4H - Short")

        df.loc[
            (
                self.entry_4h_shift_short_enabled
                &(df["DI_catch_4h"] == 0)
                &(df["maxima_check_4h"] == 0)
                & (df["maxima_check"].shift(self.shift_lookback) == 1)
                & (df["volume_4h"] > 0)
                & (df["rsi_4h"] > self.entry_4h_rsi_short)
                & chg_4h_ok
                & (df["maxima_check"] == 0)
                & (df["volume"] > 0)
                & (df["rsi"] > self.entry_5m_rsi_short_4h)
                & breakout_4h_ok
            ),
            ["enter_short", "enter_tag"],
        ] = (1, "4H - Shift Short")

        return df

    def populate_exit_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        if "exit_long" not in df.columns:
            df["exit_long"] = 0
        if "exit_short" not in df.columns:
            df["exit_short"] = 0
        if "exit_tag" not in df.columns:
            df["exit_tag"] = None

        if self.exit_5m_shift_long_enabled:
            df.loc[
                (
                    (df["DI_catch"] == 0)
                    & (df["maxima_check"] == 0)
                    & (df["maxima_check"].shift(self.shift_lookback) == 1)
                    & (df["volume"] > 0)
                ),
                ["exit_long", "exit_tag"],
            ] = (1, "5M - Shift Long Exit")

        if self.exit_5m_shift_short_enabled:
            df.loc[
                (
                    (df["DI_catch"] == 1)
                    & (df["minima_check"] == 0)
                    & (df["minima_check"].shift(self.shift_lookback) == 1)
                    & (df["volume"] > 0)
                ),
                ["exit_short", "exit_tag"],
            ] = (1, "5M - Shift Short Exit")

        if self.exit_5m_long_enabled:
            df.loc[
                ((df["maxima_check"] == 0) & (df["volume"] > 0) & (df["exit_long"] != 1)),
                ["exit_long", "exit_tag"],
            ] = (
                1,
                "Long Exit",
            )
        
        if self.exit_5m_short_enabled:
            df.loc[
                ((df["minima_check"] == 0) & (df["volume"] > 0) & (df["exit_short"] != 1)),
                ["exit_short", "exit_tag"],
            ] = (
                1,
                "Short Exit",
            )

        return df