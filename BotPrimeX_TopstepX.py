"""
BotPrimeX for TopstepX (ProjectX) CME futures, through the projectx-gateway.

Signals are BotPrimeX's, unchanged. What this subclass adds is everything a prop
firm account needs that a crypto strategy never did:

  * Account protection: the gateway's AccountGuard (Topstep rules, loss limits,
    session clock) is read every loop. Entries and DCA are blocked unless it says
    "active", and every position is closed when it says flatten.
  * Whole contracts sized by risk: contracts = max_risk_per_trade / stop risk per
    contract, capped by the mini-equivalent limit and the mini/micro overlap rule.
  * A protective stop for every trade at that risk, tighter than BotPrimeX's own.
  * Partial exits only when there is more than one contract to scale out of.
  * Roll guard: no new entries in the last days before the front contract expires.
  * Optional order flow filters fed by the gateway's tick recorder.
  * Timeframe-aware 24h change, so the strategy also runs on 1s-1m candles.
"""

from __future__ import annotations

import logging
import math
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import numpy as np
import pandas as pd
import talib.abstract as ta
from pandas import DataFrame

from freqtrade.exchange import timeframe_to_seconds
from freqtrade.persistence import Order, Trade
from freqtrade.strategy import stoploss_from_absolute

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from BotPrimeX import BotPrimeX  # noqa: E402

from projectx.backtest_guard import BacktestGuard  # noqa: E402
from projectx.gateway_client import GatewayClient  # noqa: E402
from projectx.orderflow import merge_features  # noqa: E402

logger = logging.getLogger(__name__)

STRATEGY_DEFAULTS = {
    "stop_atr_period": 14,
    "stop_atr_mult": 2.0,
    "min_stop_ticks": 8,
    "max_stop_ticks": 400,
    "max_contracts_per_trade": 10,
    "partial_exit_min_contracts": 2,
    "roll_guard_days": 2,
    "leverage": 50,
    "notify_guard_changes": True,
    "seconds_mode": {"startup_candle_count": 300, "protection_minutes": 5},
}
ORDERFLOW_DEFAULTS = {
    "enabled": False,
    "confirm_delta_candles": 3,
    "block_against_stacked_imbalance": True,
    "cvd_divergence_exit": False,
    "cvd_divergence_lookback": 20,
}
MARKETS_REFRESH = timedelta(minutes=10)


def wall_now() -> datetime:
    return datetime.now(timezone.utc)


GUARD_STALE = timedelta(seconds=15)
STOP_KEY = "tsx_stop_price"


class BotPrimeX_TopstepX(BotPrimeX):
    can_short = True
    use_custom_stoploss = True
    position_adjustment_enable = True

    def __init__(self, config: dict) -> None:
        super().__init__(config)
        self.tsx = {**STRATEGY_DEFAULTS, **(config.get("topstep_strategy") or {})}
        self.tsx_of = {**ORDERFLOW_DEFAULTS, **(config.get("topstep_orderflow") or {})}
        tf = config.get("timeframe") or self.timeframe
        self.seconds_mode = str(tf).endswith("s")
        if self.seconds_mode and "startup_candle_count" not in config:
            self.startup_candle_count = int(self.tsx["seconds_mode"].get("startup_candle_count", 300))
        self.gateway = GatewayClient.from_config(config)
        self._markets: dict[str, dict] = {}
        self._markets_at: datetime | None = None
        self._guard: dict[str, Any] = {}
        self._guard_at: datetime | None = None
        self._guard_signature: str | None = None
        self._planned_stop_ticks: dict[str, float] = {}
        self._bt_guard: BacktestGuard | None = None

    # ------------------------------------------------------------ gateway data --

    @property
    def _backtesting(self) -> bool:
        dp = getattr(self, "dp", None)
        return bool(dp) and getattr(dp.runmode, "value", "") in ("backtest", "hyperopt")

    def _refresh_markets(self, now: datetime) -> None:
        if self._backtesting:
            return
        if self._markets and self._markets_at and wall_now() - self._markets_at < MARKETS_REFRESH:
            return
        try:
            self._markets = {m["symbol"]: m for m in self.gateway.get("/markets")}
            self._markets_at = wall_now()
        except Exception as e:  # noqa: BLE001
            logger.warning("projectx markets unavailable: %s", e)

    def _market(self, pair: str) -> dict:
        if pair in self._markets:
            return self._markets[pair]
        # The exchange's loaded markets carry the same gateway row in `info`
        # (the only source in backtests, which never poll the gateway).
        try:
            info = (self.dp.market(pair) or {}).get("info") or {}
        except Exception:  # noqa: BLE001
            info = {}
        if info:
            self._markets[pair] = info
        return info

    def _contract_size(self, pair: str) -> float:
        m = self._market(pair)
        return float(m.get("contractSize") or 1.0)

    def _contracts(self, trade: Trade) -> float:
        return trade.amount / self._contract_size(trade.pair)

    def _session_start(self, now: datetime) -> datetime:
        ts = self._guard.get("sessionStart")
        if ts:
            return datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        return now - timedelta(hours=24)

    def _dry_run_snapshot(self, now: datetime) -> dict:
        """Freqtrade's simulated account, so the guard can run on dry-run trades."""
        session_start = self._session_start(now)
        closed = Trade.get_trades_proxy(is_open=False)
        realized_total = sum(t.close_profit_abs or 0.0 for t in closed)
        today = sorted(
            (t for t in closed if t.close_date_utc and t.close_date_utc >= session_start),
            key=lambda t: t.close_date_utc,
        )
        open_trades = Trade.get_trades_proxy(is_open=True)
        entries_today = 0
        for t in closed + open_trades:
            for o in t.select_filled_orders(t.entry_side):
                filled = o.order_filled_utc
                if filled and filled >= session_start:
                    entries_today += 1
        return {
            "realized_total": realized_total,
            "day_realized": sum(t.close_profit_abs or 0.0 for t in today),
            "closed_results": [t.close_profit_abs or 0.0 for t in today],
            "entries_today": entries_today,
            "positions": [
                {
                    "pair": t.pair,
                    "side": "short" if t.is_short else "long",
                    "contracts": self._contracts(t),
                    "entry_price": t.open_rate,
                }
                for t in open_trades
            ],
        }

    def _backtest_guard(self, now: datetime) -> dict:
        if self._bt_guard is None:
            self._bt_guard = BacktestGuard(self.config)
        session_start = self._bt_guard.session_start(now)
        closed = [
            (t.close_date_utc, t.close_profit_abs or 0.0)
            for t in Trade.get_trades_proxy(is_open=False)
            if t.close_date_utc
        ]
        entries_today = sum(
            1
            for t in Trade.get_trades_proxy()
            for o in t.select_filled_orders(t.entry_side)
            if o.order_filled_utc and o.order_filled_utc >= session_start
        )
        return self._bt_guard.evaluate(now, sorted(closed), entries_today)

    def bot_loop_start(self, current_time: datetime, **kwargs) -> None:
        if self._backtesting:
            self._guard = self._backtest_guard(current_time)
            self._guard_at = current_time
            return
        self._refresh_markets(current_time)
        try:
            if self.config.get("dry_run"):
                guard = self.gateway.post("/guard/snapshot", self._dry_run_snapshot(current_time))
            else:
                guard = self.gateway.get("/guard")
            self._guard = guard or {}
            self._guard_at = current_time
        except Exception as e:  # noqa: BLE001
            logger.warning("projectx guard unavailable, blocking entries: %s", e)
        self._announce_guard()

    def _announce_guard(self) -> None:
        g = self._guard
        reasons = ", ".join(r.get("code", "?") for r in g.get("reasons", [])) or "clear"
        signature = f"{g.get('status')}|{reasons}|{g.get('flatten')}"
        if signature == self._guard_signature:
            return
        first = self._guard_signature is None
        self._guard_signature = signature
        m = g.get("metrics", {})
        msg = (
            f"TopstepX guard: {g.get('status', 'unknown')}{' + FLATTEN' if g.get('flatten') else ''} ({reasons}) | "
            f"day P&L {m.get('dayPnl')} / DLL left {m.get('dayLossRemaining')} | "
            f"MLL room {m.get('mllRoom')} | contracts {m.get('exposureMini')}/{m.get('maxMiniEquivalent')} minis"
        )
        logger.info(msg)
        if self.tsx.get("notify_guard_changes") and not first and getattr(self, "dp", None):
            try:
                self.dp.send_msg(msg)
            except Exception as e:  # noqa: BLE001
                logger.debug("guard notify failed: %s", e)

    def _guard_fresh(self, now: datetime) -> bool:
        return bool(self._guard) and self._guard_at is not None and now - self._guard_at <= GUARD_STALE

    def _entries_allowed(self, now: datetime) -> tuple[bool, str]:
        if not self._guard_fresh(now):
            return False, "guard state unavailable"
        if self._guard.get("status") == "disabled":
            return True, ""
        if not self._guard.get("canEnter"):
            codes = ", ".join(r.get("code", "?") for r in self._guard.get("reasons", []))
            return False, f"{self._guard.get('status')}: {codes}"
        return True, ""

    # -------------------------------------------------------------- lots/risk --

    def _lot(self, pair: str) -> dict:
        return self._market(pair).get("lot") or {"weight": 1.0, "group": pair}

    def _held_legs(self, exclude_pair: str | None = None) -> list[tuple[str, float]]:
        return [
            (t.pair, self._contracts(t))
            for t in Trade.get_trades_proxy(is_open=True)
            if t.pair != exclude_pair
        ]

    def _overlap_conflict(self, pair: str) -> str | None:
        if not (self.config.get("topstep", {}).get("lots", {}) or {}).get("block_mini_micro_overlap", True):
            return None
        group = self._lot(pair).get("group")
        for other, _ in self._held_legs(exclude_pair=pair):
            if self._lot(other).get("group") == group:
                return other
        return None

    def _contracts_that_fit(self, pair: str, exclude_pair: str | None = None) -> int:
        metrics = self._guard.get("metrics", {})
        cap = metrics.get("maxMiniEquivalent")
        if cap is None:
            return int(self.tsx["max_contracts_per_trade"])
        used = sum(c * float(self._lot(p).get("weight", 1.0)) for p, c in self._held_legs(exclude_pair))
        weight = float(self._lot(pair).get("weight", 1.0)) or 1.0
        return max(0, math.floor((float(cap) - used + 1e-9) / weight))

    def _stop_ticks(self, pair: str) -> float:
        m = self._market(pair)
        tick = float(m.get("tickSize") or 0) or None
        ticks = float(self.tsx["min_stop_ticks"])
        df, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        if tick and not df.empty and "tsx_atr" in df and pd.notna(df["tsx_atr"].iloc[-1]):
            ticks = float(df["tsx_atr"].iloc[-1]) * float(self.tsx["stop_atr_mult"]) / tick
        return float(min(max(math.ceil(ticks), self.tsx["min_stop_ticks"]), self.tsx["max_stop_ticks"]))

    def _risk_contracts(self, pair: str, stop_ticks: float) -> int:
        tick_value = float(self._market(pair).get("tickValue") or 0)
        max_risk = self._guard.get("metrics", {}).get("maxRiskPerTrade")
        if not tick_value or not max_risk:
            return int(self.tsx["max_contracts_per_trade"])
        return max(0, math.floor(float(max_risk) / (stop_ticks * tick_value)))

    def _stake_for(self, pair: str, contracts: int, rate: float, leverage: float) -> float:
        # A hair over N contracts so Freqtrade's floor to contract precision keeps N.
        return (contracts + 0.001) * self._contract_size(pair) * rate / max(leverage, 1.0)

    def _roll_blocked(self, pair: str) -> bool:
        # Backtest history is already continuous across rolls.
        if self._backtesting:
            return False
        days = self._market(pair).get("daysToExpiry")
        return days is not None and days <= int(self.tsx["roll_guard_days"])

    # ---------------------------------------------------------------- callbacks --

    def leverage(self, pair: str, current_time: datetime, current_rate: float, proposed_leverage: float,
                 max_leverage: float, side: str, **kwargs) -> float:
        return float(max(1.0, min(float(self.tsx["leverage"]), max_leverage)))

    def custom_stake_amount(self, pair: str, current_time: datetime, current_rate: float, proposed_stake: float,
                            min_stake: Optional[float], max_stake: float, leverage: float,
                            entry_tag: Optional[str], side: str, **kwargs) -> float:
        ok, why = self._entries_allowed(current_time)
        if not ok:
            logger.info("%s entry skipped: %s", pair, why)
            return 0.0
        conflict = self._overlap_conflict(pair)
        if conflict:
            logger.info("%s entry skipped: %s already held in the same mini/micro group", pair, conflict)
            return 0.0
        stop_ticks = self._stop_ticks(pair)
        contracts = min(
            self._risk_contracts(pair, stop_ticks),
            self._contracts_that_fit(pair),
            int(self.tsx["max_contracts_per_trade"]),
        )
        affordable = math.floor(max_stake * max(leverage, 1.0) / (self._contract_size(pair) * current_rate))
        contracts = min(contracts, affordable)
        if contracts < 1:
            logger.info("%s entry skipped: no whole contract fits risk/limits (stop %s ticks)", pair, stop_ticks)
            return 0.0
        self._planned_stop_ticks[pair] = stop_ticks
        return self._stake_for(pair, contracts, current_rate, leverage)

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float, time_in_force: str,
                            current_time: datetime, entry_tag: Optional[str], side: str, **kwargs) -> bool:
        if not super().confirm_trade_entry(pair, order_type, amount, rate, time_in_force, current_time,
                                           entry_tag, side, **kwargs):
            return False
        ok, why = self._entries_allowed(current_time)
        if not ok:
            logger.info("%s entry blocked by account protection: %s", pair, why)
            return False
        if self._roll_blocked(pair):
            logger.info("%s entry blocked: front contract expires within %s days", pair, self.tsx["roll_guard_days"])
            return False
        conflict = self._overlap_conflict(pair)
        if conflict:
            logger.info("%s entry blocked: %s already held in the same group", pair, conflict)
            return False
        contracts = round(amount / self._contract_size(pair))
        if contracts > self._contracts_that_fit(pair):
            logger.info("%s entry blocked: %s contracts exceed the mini-equivalent cap", pair, contracts)
            return False
        if not self._orderflow_confirms(pair, side):
            logger.info("%s %s entry blocked by order flow filter", pair, side)
            return False
        return True

    def order_filled(self, pair: str, trade: Trade, order: Order, current_time: datetime, **kwargs) -> None:
        if order.ft_order_side != trade.entry_side or trade.get_custom_data(STOP_KEY) is not None:
            return
        tick = float(self._market(pair).get("tickSize") or 0)
        ticks = self._planned_stop_ticks.pop(pair, None) or self._stop_ticks(pair)
        if not tick or not trade.open_rate:
            return
        distance = ticks * tick
        stop = trade.open_rate + distance if trade.is_short else trade.open_rate - distance
        trade.set_custom_data(STOP_KEY, stop)

    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime, current_rate: float,
                        current_profit: float, after_fill: bool, **kwargs) -> Optional[float]:
        base = super().custom_stoploss(pair, trade, current_time, current_rate, current_profit, **kwargs)
        stop_price = trade.get_custom_data(STOP_KEY)
        if stop_price is None:
            return base
        protective = abs(stoploss_from_absolute(float(stop_price), current_rate, is_short=trade.is_short,
                                                leverage=trade.leverage))
        # Freqtrade ignores the sign; the smaller distance is the tighter stop.
        return -min(abs(base), protective) if base is not None else -protective

    def adjust_trade_position(self, trade: Trade, current_time: datetime, current_rate: float,
                              current_profit: float, min_stake: Optional[float], max_stake: float,
                              current_entry_rate: float, current_exit_rate: float,
                              current_entry_profit: float, current_exit_profit: float, **kwargs):
        result = super().adjust_trade_position(trade, current_time, current_rate, current_profit, min_stake,
                                               max_stake, current_entry_rate, current_exit_rate,
                                               current_entry_profit, current_exit_profit, **kwargs)
        if result is None:
            return None
        stake = result[0] if isinstance(result, tuple) else result
        if stake is None or stake == 0:
            return None
        cs = self._contract_size(trade.pair)
        held = round(self._contracts(trade))

        if stake < 0:
            # Freqtrade sizes a partial exit as a fraction of the trade's stake.
            if held < int(self.tsx["partial_exit_min_contracts"]) or not trade.stake_amount:
                return None
            reduce = math.floor(held * (-stake / trade.stake_amount))
            reduce = min(max(reduce, 1), held - 1)
            return -((reduce + 0.001) / held) * trade.stake_amount

        ok, why = self._entries_allowed(current_time)
        if not ok or self._roll_blocked(trade.pair):
            return None
        stop_price = trade.get_custom_data(STOP_KEY)
        point_value = cs
        max_risk = self._guard.get("metrics", {}).get("maxRiskPerTrade")
        add = math.floor(stake * trade.leverage / (current_entry_rate * cs))
        if stop_price is not None and max_risk:
            existing = abs(trade.open_rate - float(stop_price)) * held * point_value
            per_contract = abs(current_entry_rate - float(stop_price)) * point_value
            if per_contract > 0:
                add = min(add, math.floor((float(max_risk) - existing) / per_contract))
        fit = self._contracts_that_fit(trade.pair, exclude_pair=trade.pair) - held
        add = min(add, fit, int(self.tsx["max_contracts_per_trade"]) - held)
        if add < 1:
            return None
        return self._stake_for(trade.pair, add, current_entry_rate, trade.leverage)

    def custom_exit(self, pair: str, trade: Trade, current_time: datetime, current_rate: float,
                    current_profit: float, **kwargs) -> Optional[str]:
        if self._guard.get("flatten"):
            reasons = self._guard.get("flattenReasons") or []
            if any(r in ("day_locked", "account_locked") for r in reasons):
                return "account_protection"
            return "session_flat"
        days = self._market(pair).get("daysToExpiry")
        if not self._backtesting and days is not None and days < 0:
            return "contract_roll"
        if self.tsx_of["enabled"] and self.tsx_of["cvd_divergence_exit"] and self._cvd_divergence(pair, trade):
            return "cvd_divergence"
        return super().custom_exit(pair, trade, current_time, current_rate, current_profit, **kwargs)

    def confirm_trade_exit(self, pair: str, trade: Trade, order_type: str, amount: float, rate: float,
                           time_in_force: str, exit_reason: str, current_time: datetime, **kwargs) -> bool:
        # Protection exits must never be vetoed by BotPrimeX's profit-only checks.
        if exit_reason in ("account_protection", "session_flat", "contract_roll"):
            return True
        return super().confirm_trade_exit(pair, trade, order_type, amount, rate, time_in_force, exit_reason,
                                          current_time, **kwargs)

    @property
    def protections(self):
        if not self.seconds_mode:
            return super().protections
        minutes = int(self.tsx["seconds_mode"].get("protection_minutes", 5))
        prot = [{"method": "CooldownPeriod", "stop_duration": minutes}]
        if self.use_stop_protection:
            prot.append({
                "method": "StoplossGuard",
                "lookback_period": minutes * 12,
                "trade_limit": 2,
                "stop_duration": minutes * 4,
                "only_per_pair": False,
            })
        return prot

    # ------------------------------------------------------------- indicators --

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe = super().populate_indicators(dataframe, metadata)
        # BotPrimeX's 24h change assumes 5m candles (shift 288); derive it per timeframe.
        per_day = max(1, int(86400 / timeframe_to_seconds(self.timeframe)))
        prev = dataframe["close"].shift(per_day)
        dataframe["chg_pct"] = np.where(prev > 0, (dataframe["close"] - prev) / prev * 100, np.nan)
        dataframe["tsx_atr"] = ta.ATR(dataframe, timeperiod=int(self.tsx["stop_atr_period"]))
        if self.tsx_of["enabled"]:
            dataframe = merge_features(dataframe, metadata["pair"], self.timeframe, client=self.gateway)
        return dataframe

    def populate_entry_trend(self, df: DataFrame, metadata: dict) -> DataFrame:
        df = super().populate_entry_trend(df, metadata)
        if not self.tsx_of["enabled"] or "of_delta" not in df:
            return df
        n = int(self.tsx_of["confirm_delta_candles"])
        if n > 0:
            delta = df["of_delta"].rolling(n, min_periods=1).sum()
            if "enter_long" in df:
                df.loc[delta <= 0, "enter_long"] = 0
            if "enter_short" in df:
                df.loc[delta >= 0, "enter_short"] = 0
        if self.tsx_of["block_against_stacked_imbalance"]:
            # Freqtrade's "bid" side is sell-aggressor volume, "ask" buy-aggressor.
            if "stacked_imbalances_bid" in df and "enter_long" in df:
                selling = df["stacked_imbalances_bid"].apply(lambda v: bool(v) if isinstance(v, list) else False)
                df.loc[selling, "enter_long"] = 0
            if "stacked_imbalances_ask" in df and "enter_short" in df:
                buying = df["stacked_imbalances_ask"].apply(lambda v: bool(v) if isinstance(v, list) else False)
                df.loc[buying, "enter_short"] = 0
        return df

    def _orderflow_confirms(self, pair: str, side: str) -> bool:
        if not self.tsx_of["enabled"]:
            return True
        df, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        if df.empty or "of_delta" not in df:
            return True
        n = max(1, int(self.tsx_of["confirm_delta_candles"]))
        delta = float(df["of_delta"].tail(n).sum())
        return delta > 0 if side == "long" else delta < 0

    def _cvd_divergence(self, pair: str, trade: Trade) -> bool:
        df, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        n = int(self.tsx_of["cvd_divergence_lookback"])
        if df.empty or "of_cvd_session" not in df or len(df) < n:
            return False
        window = df.tail(n)
        price_up = window["close"].iloc[-1] >= window["close"].max()
        price_down = window["close"].iloc[-1] <= window["close"].min()
        cvd = window["of_cvd_session"]
        if trade.is_short:
            return bool(price_down and cvd.iloc[-1] > cvd.min())
        return bool(price_up and cvd.iloc[-1] < cvd.max())
