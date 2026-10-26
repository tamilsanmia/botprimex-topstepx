import logging
import warnings
from dataclasses import dataclass
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


# --- Ranked support/resistance zones (chart display only) ---------------------
# Adapted from "Ranked Support & Resistance Zones" by Zeiierman (TradingView, Pine v6),
# licensed CC BY-NC-SA 4.0: https://creativecommons.org/licenses/by-nc-sa/4.0/
# Computed bar by bar from past candles only: a zone appears on the candle its pivot
# is confirmed (`span` candles after the swing), so the columns never repaint.
# They feed plot_config only; no entry or exit rule reads them.

_SR_EPS = 1e-9


@dataclass(slots=True)
class _SRZone:
    score: float
    top: float
    bottom: float
    mid: float
    dir: int  # -1 support, 1 resistance
    born: int
    width: float
    mitigation: float
    touches: float
    vol: float
    trend: float
    swing: float
    bull: int
    bear: int


def _sr_score(z_width, atr, vol, trend, swing, mitigation, touches, age, max_age) -> float:
    raw = (
        min(z_width / atr, 1.0) * 20.0
        + min(vol / 2.0, 1.0) * 18.0
        + trend * 12.0
        + min(swing / 1.5, 1.0) * 28.0
        + min(touches / 4.0, 1.0) * 16.0
        + 10.0
    )
    penalty = mitigation * 22.0 + min(age / max_age, 1.0) * 10.0
    return max(min(raw - penalty, 100.0), 0.0)


def _sr_strengths(direction, score, trend, mitigation) -> tuple:
    """(bull %, bear %) shown on the zone; derived from the score, not from order flow."""
    s = max(min(score, 100.0), 0.0)
    if s >= 75:
        side = 72 + (s - 75) * 1.12
    elif s >= 45:
        side = 48 + (s - 45) * 0.75
    else:
        side = s * 1.05
    side = max(min(side + trend * 6.0 - mitigation * 28.0, 100.0), 0.0)
    opposite = max(min(5.0 + mitigation * 65.0 + s * 0.08, 100.0), 0.0)
    return (int(side), int(opposite)) if direction == -1 else (int(opposite), int(side))


# Chart bands, like the indicator on TradingView: the current top-ranked zones (one
# column pair per slot, support and resistance) and the last broken zones.
SR_VISIBLE_SLOTS = 8
SR_BROKEN_SLOTS = 4
SR_BAND_KINDS = (("sup", SR_VISIBLE_SLOTS), ("res", SR_VISIBLE_SLOTS), ("brk", SR_BROKEN_SLOTS))
SR_BAND_COLUMNS = tuple(
    f"sr_{kind}{k}_{edge}" for kind, slots in SR_BAND_KINDS for k in range(slots) for edge in ("top", "bot")
)
SR_COLUMNS = SR_BAND_COLUMNS + ("sr_sup_strength", "sr_res_strength", "sr_break_up", "sr_break_down")
# Per-candle (causal) columns; the bands above show the latest state and are redrawn every candle.
SR_CAUSAL_COLUMNS = ("sr_sup_strength", "sr_res_strength", "sr_break_up", "sr_break_down")

_SR_BAND_STYLE = {
    "sup": ("rgba(26,216,194,0.85)", "rgba(26,216,194,0.18)", "Support"),
    "res": ("rgba(216,76,26,0.85)", "rgba(216,76,26,0.18)", "Resistance"),
    "brk": ("rgba(148,163,184,0.6)", "rgba(148,163,184,0.12)", "Broken zone"),
}


def sr_plot_bands() -> dict:
    """plot_config main_plot entries: one shaded band per zone slot."""
    plot = {}
    for kind, slots in SR_BAND_KINDS:
        line, fill, label = _SR_BAND_STYLE[kind]
        for k in range(slots):
            plot[f"sr_{kind}{k}_top"] = {
                "color": line,
                "type": "line",
                "fill_to": f"sr_{kind}{k}_bot",
                "fill_label": f"{label} {k + 1}",
                "fill_color": fill,
            }
            plot[f"sr_{kind}{k}_bot"] = {"color": line, "type": "line"}
    return plot


def ranked_sr_zones(
    df: DataFrame,
    span: int = 5,
    min_swing_atr: float = 0.15,
    absorb_atr: float = 0.55,
    zone_atr_width: float = 0.40,
    vol_len: int = 20,
    trend_len: int = 50,
    break_atr: float = 0.12,
    max_age: int = 450,
    stored: int = 60,
    visible: int = 8,
) -> dict:
    """Chart columns for the ranked zones.

    sr_sup{k}_* / sr_res{k}_*: the zones in the current top `visible`, drawn like the
        TradingView boxes: from the swing candle to the last candle at the zone's current
        top/bottom (k = rank order within each side). Redrawn from scratch every candle.
    sr_brk{k}_*: the last SR_BROKEN_SLOTS broken zones, from the swing to the break candle.
    sr_sup_strength / sr_res_strength (per candle, causal): bull % of the nearest visible
        support below the close, bear % of the nearest visible resistance above it.
    sr_break_up / sr_break_down (per candle, causal): close of a candle that broke a
        resistance / support.
    """
    n = len(df)
    out = {name: np.full(n, np.nan) for name in SR_COLUMNS}
    if n == 0:
        return out

    h, l = df["high"], df["low"]
    high, low = h.to_numpy(float), l.to_numpy(float)
    close = df["close"].to_numpy(float)
    volume = df["volume"].to_numpy(float)
    atr = np.asarray(ta.ATR(df, timeperiod=14), dtype=float)
    vol_base = df["volume"].rolling(vol_len).mean().to_numpy(float)
    trend_base = df["close"].ewm(span=trend_len, adjust=False).mean().to_numpy(float)

    # Like ta.pivothigh/pivotlow(span, span), evaluated on the confirming candle i
    # (pivot at i - span) from candles up to i only. Ties are not pivots.
    ph_price = h.shift(span)
    is_ph = ((ph_price > h.shift(span + 1).rolling(span).max()) & (ph_price > h.rolling(span).max())).to_numpy()
    pl_price = l.shift(span)
    is_pl = ((pl_price < l.shift(span + 1).rolling(span).min()) & (pl_price < l.rolling(span).min())).to_numpy()

    zones: list = []
    broken: list = []  # (swing candle, break candle, top, bottom) of the latest broken zones

    def add_zone(price: float, direction: int, p: int, i: int, a: float) -> None:
        half = zone_atr_width * a * 0.5
        top, bottom = price + half, price - half
        vb = vol_base[i]
        vol = volume[p] / vb if np.isfinite(vb) and vb != 0 else 1.0
        tb = trend_base[i]
        trend = 1.0 if (direction == -1 and price > tb) or (direction == 1 and price < tb) else 0.0
        if direction == 1:
            swing = max((price - max(high[p + 1], high[p - 1])) / a, 0.0)
        else:
            swing = max((min(low[p + 1], low[p - 1]) - price) / a, 0.0)

        new_mid = (top + bottom) / 2
        for z in zones:
            if z.dir != direction:
                continue
            overlap = max(min(z.top, top) - max(z.bottom, bottom), 0.0)
            smaller = min(max(z.top - z.bottom, _SR_EPS), max(top - bottom, _SR_EPS))
            if abs(z.mid - new_mid) <= absorb_atr * a or overlap / smaller >= 0.35:
                # Absorb into the existing zone (score/strengths are recomputed below).
                z.top, z.bottom = max(z.top, top), min(z.bottom, bottom)
                z.mid = (z.top + z.bottom) / 2
                z.width = max(z.top - z.bottom, _SR_EPS)
                z.born = min(z.born, p)
                z.vol, z.trend, z.swing = max(z.vol, vol), max(z.trend, trend), max(z.swing, swing)
                z.mitigation = 0.0
                z.touches += 1.0
                return

        width = max(top - bottom, _SR_EPS)
        score = _sr_score(width, a, vol, trend, swing, 0.0, 0.0, i - p, max_age)
        bull, bear = _sr_strengths(direction, score, trend, 0.0)
        zones.append(_SRZone(score, top, bottom, price, direction, p, width, 0.0, 0.0, vol, trend, swing, bull, bear))

    for i in range(n):
        a = atr[i]
        if not np.isfinite(a) or a <= 0:
            continue
        p = i - span
        if is_ph[i] and (high[p] - max(high[p + 1], high[p - 1])) / a >= min_swing_atr:
            add_zone(high[p], 1, p, i, a)
        if is_pl[i] and (min(low[p + 1], low[p - 1]) - low[p]) / a >= min_swing_atr:
            add_zone(low[p], -1, p, i, a)

        c, hi, lo = close[i], high[i], low[i]
        kept = []
        for z in zones:
            broken_sup = z.dir == -1 and c < z.bottom - break_atr * a
            broken_res = z.dir == 1 and c > z.top + break_atr * a
            if hi >= z.bottom and lo <= z.top and not (broken_sup or broken_res):
                z.touches += 0.20
                fill = z.top - lo if z.dir == -1 else hi - z.bottom
                z.mitigation = min(max(fill / max(z.width, _SR_EPS), 0.0), 1.0)
            age = i - z.born
            z.score = _sr_score(z.width, a, z.vol, z.trend, z.swing, z.mitigation, z.touches, age, max_age)
            z.bull, z.bear = _sr_strengths(z.dir, z.score, z.trend, z.mitigation)
            if age > max_age:
                continue
            if broken_res or broken_sup:
                out["sr_break_up" if broken_res else "sr_break_down"][i] = c
                broken.append((z.born, i, z.top, z.bottom))
                del broken[:-SR_BROKEN_SLOTS]
                continue
            kept.append(z)
        kept.sort(key=lambda z: z.score, reverse=True)
        zones = kept[:stored]

        nearest_sup = nearest_res = None
        for z in zones[:visible]:
            if z.dir == -1:
                if z.mid < c and (nearest_sup is None or z.mid > nearest_sup.mid):
                    nearest_sup = z
            elif z.mid > c and (nearest_res is None or z.mid < nearest_res.mid):
                nearest_res = z
        if nearest_sup is not None:
            out["sr_sup_strength"][i] = nearest_sup.bull
        if nearest_res is not None:
            out["sr_res_strength"][i] = nearest_res.bear

    # Bands: the latest state, the way TradingView shows the boxes.
    last = n - 1
    slot = {"sup": 0, "res": 0}
    for z in zones[:visible]:
        kind = "sup" if z.dir == -1 else "res"
        k = slot[kind]
        if k >= SR_VISIBLE_SLOTS:
            continue
        slot[kind] += 1
        out[f"sr_{kind}{k}_top"][z.born:last + 1] = z.top
        out[f"sr_{kind}{k}_bot"][z.born:last + 1] = z.bottom
    for k, (born, end, top, bottom) in enumerate(broken):
        out[f"sr_brk{k}_top"][born:end + 1] = top
        out[f"sr_brk{k}_bot"][born:end + 1] = bottom
    return out


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

    # Ranked S/R zone columns for the chart (see ranked_sr_zones). Set False to skip the work.
    plot_sr_zones = True

    plot_config = {
        "main_plot": {
            # One shaded band per zone: the top-ranked supports and resistances right now,
            # from their swing candle to the latest candle, plus the last broken zones (grey).
            **sr_plot_bands(),
            # Candles that closed through a zone.
            "sr_break_up": {"color": "#1ad8c2", "type": "scatter"},
            "sr_break_down": {"color": "#d84c1a", "type": "scatter"},
        },
        "subplots": {
            "S/R strength": {
                "sr_sup_strength": {"color": "#1ad8c2", "type": "line"},
                "sr_res_strength": {"color": "#d84c1a", "type": "line"},
            },
            "extrema": {
                "&s-extrema": {"color": "#f53580", "type": "line"},
                "minima_sort_threshold": {"color": "#4ae747", "type": "line"},
                "maxima_sort_threshold": {"color": "#5b5e4b", "type": "line"},
            },
            "min_max": {
                "maxima": {"color": "#a29db9", "type": "line"},
                "minima": {"color": "#ac7fcc", "type": "line"},
                "maxima_check": {"color": "#a29db9", "type": "line"},
                "minima_check": {"color": "#ac7fcc", "type": "line"},
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

        if self.plot_sr_zones:
            for name, values in ranked_sr_zones(dataframe).items():
                dataframe[name] = values
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
