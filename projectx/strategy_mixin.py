"""
TopstepX layer for any Freqtrade strategy.

    class MyStrategy_TopstepX(TopstepXMixin, MyStrategy):
        pass

Put the mixin first so its callbacks wrap the strategy's own. The strategy's
signals stay unchanged; the mixin adds what a prop firm account needs:

  * Account protection: the gateway's AccountGuard (Topstep rules, loss limits,
    session clock) is read every loop, or simulated in backtests. Entries and DCA
    are blocked unless it says "active"; every position is closed on flatten.
  * Whole contracts sized by risk: max_risk_per_trade / stop risk per contract,
    capped by the mini-equivalent limit and the mini/micro overlap rule.
  * A protective stop for every trade at that risk, tighter than the strategy's.
  * Partial exits only with more than one contract; DCA in whole contracts,
    capped by the same risk.
  * Roll guard, synthetic leverage, optional order flow filters.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import pandas as pd
import talib.abstract as ta
from pandas import DataFrame

from freqtrade.enums import ExitCheckTuple, ExitType
from freqtrade.persistence import LocalTrade, Order, Trade
from freqtrade.strategy import stoploss_from_absolute

from .backtest_guard import BacktestGuard
from .costs import COSTS_DEFAULTS, cost_ratio, costs_config  # noqa: F401  (COSTS_DEFAULTS re-exported)
from .gateway_client import GatewayClient
from .orderflow import merge_features

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
    # Live and dry-run: a stop is never placed at, through or within this many ticks of the
    # exit-side price (it would fill on placement). Projectx.create_stoploss reads the same key.
    "stop_min_distance_ticks": 4,
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
GUARD_STALE = timedelta(seconds=15)
STOP_KEY = "tsx_stop_price"
PROTECTION_EXITS = ("account_protection", "session_flat", "contract_roll")


def wall_now() -> datetime:
    return datetime.now(timezone.utc)


def _value(param):
    """Plain attribute or a hyperopt parameter."""
    return getattr(param, "value", param)


class TopstepXMixin:
    can_short = True
    use_custom_stoploss = True
    position_adjustment_enable = True

    def __init__(self, config: dict) -> None:
        super().__init__(config)
        self.tsx = {**STRATEGY_DEFAULTS, **(config.get("topstep_strategy") or {})}
        self.tsx_of = {**ORDERFLOW_DEFAULTS, **(config.get("topstep_orderflow") or {})}
        self.tsx_costs = costs_config(config)
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
        self._last_valid_stop: dict[Any, float] = {}
        self._bt_guard: BacktestGuard | None = None
        self._bt_now: datetime | None = None

    # ------------------------------------------------------------ gateway data --

    @property
    def _backtesting(self) -> bool:
        dp = getattr(self, "dp", None)
        return bool(dp) and getattr(dp.runmode, "value", "") in ("backtest", "hyperopt")

    def _trades(self, is_open: bool | None = None) -> list:
        """
        Backtests and hyperopt keep their trades in memory (LocalTrade); `Trade` needs the
        database session, which does not exist while another job has switched it off.
        """
        return (LocalTrade if self._backtesting else Trade).get_trades_proxy(is_open=is_open)

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
        return float(self._market(pair).get("contractSize") or 1.0)

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
        closed = self._trades(is_open=False)
        today = sorted(
            (t for t in closed if t.close_date_utc and t.close_date_utc >= session_start),
            key=lambda t: t.close_date_utc,
        )
        open_trades = self._trades(is_open=True)
        entries_today = sum(
            1
            for t in closed + open_trades
            for o in t.select_filled_orders(t.entry_side)
            if o.order_filled_utc and o.order_filled_utc >= session_start
        )
        return {
            "realized_total": sum(t.close_profit_abs or 0.0 for t in closed),
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

    def _mark_price(self, trade: Trade) -> float:
        """Close of the last analysed candle: what a backtest knows when it evaluates the guard."""
        try:
            df, _ = self.dp.get_analyzed_dataframe(trade.pair, self.timeframe)
            if not df.empty and pd.notna(df["close"].iloc[-1]):
                return float(df["close"].iloc[-1])
        except Exception as e:  # noqa: BLE001
            logger.debug("no mark price for %s: %s", trade.pair, e)
        return float(trade.open_rate)

    def _open_pnl(self) -> float:
        """Open P&L of the backtest's open trades at the last analysed close, fees included."""
        return sum(
            t.calc_profit(self._mark_price(t)) for t in self._trades(is_open=True) if t.has_open_position
        )

    def _backtest_guard(self, now: datetime) -> dict:
        if self._bt_guard is None:
            self._bt_guard = BacktestGuard(self.config)
        if self._bt_now is not None and now < self._bt_now:
            # The same strategy instance runs the next hyperopt epoch: start with a fresh guard.
            self._bt_guard.reset()
        self._bt_now = now
        session_start = self._bt_guard.session_start(now)
        closed = [
            (t.close_date_utc, t.close_profit_abs or 0.0)
            for t in self._trades(is_open=False)
            if t.close_date_utc
        ]
        entries_today = sum(
            1
            for t in self._trades()
            for o in t.select_filled_orders(t.entry_side)
            if o.order_filled_utc and o.order_filled_utc >= session_start
        )
        return self._bt_guard.evaluate(now, sorted(closed), entries_today, unrealized=self._open_pnl())

    def _reset_state(self) -> None:
        self._guard = {}
        self._guard_at = None
        self._guard_signature = None
        self._planned_stop_ticks = {}
        self._last_valid_stop = {}
        self._bt_guard = None
        self._bt_now = None

    def bot_start(self, **kwargs) -> None:
        super().bot_start(**kwargs)
        self._reset_state()
        if self._backtesting:
            # Build the guard now so an invalid topstep block stops the run at start-up.
            self._bt_guard = BacktestGuard(self.config)

    def bot_loop_start(self, current_time: datetime, **kwargs) -> None:
        super().bot_loop_start(current_time=current_time, **kwargs)
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

    def _log_skip(self, msg: str, *args) -> None:
        # Skips repeat every candle; in backtests they would flood the log.
        (logger.debug if self._backtesting else logger.info)(msg, *args)

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

    def _unknown_root(self, pair: str) -> bool:
        """The gateway flags roots missing from its lot table; like the gateway guard, refuse them."""
        return (self._market(pair).get("lot") or {}).get("known") is False

    def _held_legs(self, exclude_pair: str | None = None) -> list[tuple[str, float]]:
        return [(t.pair, self._contracts(t)) for t in self._trades(is_open=True) if t.pair != exclude_pair]

    def _overlap_conflict(self, pair: str) -> str | None:
        if not (self.config.get("topstep", {}).get("lots", {}) or {}).get("block_mini_micro_overlap", True):
            return None
        group = self._lot(pair).get("group")
        for other, _ in self._held_legs(exclude_pair=pair):
            if self._lot(other).get("group") == group:
                return other
        return None

    def _contracts_that_fit(self, pair: str, exclude_pair: str | None = None) -> int:
        cap = self._guard.get("metrics", {}).get("maxMiniEquivalent")
        if cap is None:
            return int(self.tsx["max_contracts_per_trade"])
        used = sum(c * float(self._lot(p).get("weight", 1.0)) for p, c in self._held_legs(exclude_pair))
        weight = float(self._lot(pair).get("weight", 1.0)) or 1.0
        return max(0, math.floor((float(cap) - used + 1e-9) / weight))

    def _stop_ticks(self, pair: str) -> float:
        tick = float(self._market(pair).get("tickSize") or 0) or None
        ticks = float(self.tsx["min_stop_ticks"])
        df, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        if tick and not df.empty and "tsx_atr" in df and pd.notna(df["tsx_atr"].iloc[-1]):
            ticks = float(df["tsx_atr"].iloc[-1]) * float(self.tsx["stop_atr_mult"]) / tick
        return float(min(max(math.ceil(ticks), self.tsx["min_stop_ticks"]), self.tsx["max_stop_ticks"]))

    def _min_stop_gap(self, pair: str) -> float:
        """stop_min_distance_ticks in price; 0 when the tick size is unknown."""
        tick = float(self._market(pair).get("tickSize") or 0)
        return max(float(self.tsx.get("stop_min_distance_ticks") or 0), 0.0) * tick

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

    def _first_entry_contracts(self, trade: Trade) -> tuple[int, float]:
        filled = trade.select_filled_orders(trade.entry_side)
        if not filled:
            return 0, 0.0
        first = filled[0]
        return round((first.safe_filled or 0) / self._contract_size(trade.pair)), float(first.cost or 0)

    # ---------------------------------------------------------------- callbacks --

    def leverage(self, pair: str, current_time: datetime, current_rate: float, proposed_leverage: float,
                 max_leverage: float, side: str, **kwargs) -> float:
        # TopstepX has no exchange leverage; this only sets how Freqtrade accounts stake.
        return float(max(1.0, min(float(self.tsx["leverage"]), max_leverage)))

    def custom_stake_amount(self, pair: str, current_time: datetime, current_rate: float, proposed_stake: float,
                            min_stake: Optional[float], max_stake: float, leverage: float,
                            entry_tag: Optional[str], side: str, **kwargs) -> float:
        ok, why = self._entries_allowed(current_time)
        if not ok:
            self._log_skip("%s entry skipped: %s", pair, why)
            return 0.0
        if self._unknown_root(pair):
            self._log_skip("%s entry skipped: unknown contract root (not in the lot table)", pair)
            return 0.0
        conflict = self._overlap_conflict(pair)
        if conflict:
            self._log_skip("%s entry skipped: %s already held in the same mini/micro group", pair, conflict)
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
            self._log_skip("%s entry skipped: no whole contract fits risk/limits (stop %s ticks)", pair, stop_ticks)
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
            self._log_skip("%s entry blocked by account protection: %s", pair, why)
            return False
        if self._roll_blocked(pair):
            self._log_skip("%s entry blocked: front contract expires within %s days", pair, self.tsx["roll_guard_days"])
            return False
        if self._unknown_root(pair):
            self._log_skip("%s entry blocked: unknown contract root (not in the lot table)", pair)
            return False
        conflict = self._overlap_conflict(pair)
        if conflict:
            self._log_skip("%s entry blocked: %s already held in the same group", pair, conflict)
            return False
        contracts = round(amount / self._contract_size(pair))
        if contracts > self._contracts_that_fit(pair):
            self._log_skip("%s entry blocked: %s contracts exceed the mini-equivalent cap", pair, contracts)
            return False
        if not self._orderflow_confirms(pair, side):
            self._log_skip("%s %s entry blocked by order flow filter", pair, side)
            return False
        return True

    def _apply_costs(self, trade: Trade) -> None:
        """
        Backtest, hyperopt and dry-run charge the per-contract fee, commission and slippage by
        setting the trade's fee ratios. Live trading keeps the real fees from the fills.
        """
        if not self.tsx_costs.get("enabled") or not (self._backtesting or self.config.get("dry_run")):
            return
        # Freqtrade passes order_filled a deep copy of the trade, so change the stored one.
        stored = next((t for t in self._trades(is_open=True) if t.id == trade.id), trade)
        market = self._market(stored.pair)
        ratio = cost_ratio(self.tsx_costs, market, stored.open_rate)
        if ratio is None:
            return
        stored.fee_open = stored.fee_close = ratio
        stored.recalc_trade_from_orders()

    def order_filled(self, pair: str, trade: Trade, order: Order, current_time: datetime, **kwargs) -> None:
        super().order_filled(pair, trade, order, current_time, **kwargs)
        if order.ft_order_side == trade.entry_side:
            self._apply_costs(trade)
        if order.ft_order_side != trade.entry_side or trade.get_custom_data(STOP_KEY) is not None:
            return
        tick = float(self._market(pair).get("tickSize") or 0)
        ticks = self._planned_stop_ticks.pop(pair, None) or self._stop_ticks(pair)
        if not tick or not trade.open_rate:
            return
        distance = ticks * tick
        trade.set_custom_data(STOP_KEY, trade.open_rate + distance if trade.is_short else trade.open_rate - distance)

    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime, current_rate: float,
                        current_profit: float, after_fill: bool, **kwargs) -> Optional[float]:
        base = super().custom_stoploss(pair, trade, current_time, current_rate, current_profit,
                                       after_fill=after_fill, **kwargs)
        stop_price = trade.get_custom_data(STOP_KEY)
        if stop_price is None:
            return self._at_least_min_gap(base, trade, current_rate)
        protective = abs(stoploss_from_absolute(float(stop_price), current_rate, is_short=trade.is_short,
                                                leverage=trade.leverage))
        # Freqtrade ignores the sign; the smaller distance is the tighter stop.
        stop = -min(abs(base), protective) if base is not None else -protective
        return self._at_least_min_gap(stop, trade, current_rate)

    def _at_least_min_gap(self, stoploss: Optional[float], trade: Trade, current_rate: float) -> Optional[float]:
        """
        Live and dry-run: never a stop closer than stop_min_distance_ticks to the price. A stored stop
        on the wrong side of the price (distance 0, which Freqtrade ignores) also becomes that distance.
        """
        gap = self._min_stop_gap(trade.pair)
        if stoploss is None or self._backtesting or not gap or not current_rate:
            return stoploss
        bound = current_rate + gap if trade.is_short else current_rate - gap
        minimum = stoploss_from_absolute(bound, current_rate, is_short=trade.is_short, leverage=trade.leverage)
        return -max(abs(stoploss), minimum)

    def _stop_valid(self, stop: float, rate: float, gap: float, is_short: bool) -> bool:
        return stop >= rate + gap - 1e-9 if is_short else stop <= rate - gap + 1e-9

    def ft_stoploss_adjust(self, current_rate: float, trade: Trade, current_time: datetime, current_profit: float,
                           force_stoploss: float, low: Optional[float] = None, high: Optional[float] = None,
                           bound_profit: Optional[float] = None, after_fill: bool = False) -> None:
        super().ft_stoploss_adjust(current_rate, trade, current_time, current_profit, force_stoploss, low=low,
                                   high=high, bound_profit=bound_profit, after_fill=after_fill)
        if self._backtesting or not trade.is_open or trade.stop_loss is None or not current_rate:
            return
        gap = self._min_stop_gap(trade.pair)
        if not gap:
            return
        stop = float(trade.stop_loss)
        if self._stop_valid(stop, current_rate, gap, trade.is_short):
            self._last_valid_stop[trade.id] = stop
            return
        previous = self._last_valid_stop.get(trade.id)
        if previous is None or math.isclose(stop, previous, abs_tol=1e-9):
            # The price came to an unchanged stop: that stop fills, it is not moved away.
            return
        # Freqtrade moved the stop to or through the price. It re-anchors the stop ratio to the new
        # average entry after a DCA fill (recalc_trade_from_orders), and a stop placed there fills at once.
        leverage = trade.leverage or 1.0
        ratio = abs(self.stoploss) / leverage
        from_average = trade.open_rate * (1 + ratio) if trade.is_short else trade.open_rate * (1 - ratio)
        candidates = [("the last valid stop", previous), ("the strategy stop from the average entry", from_average),
                      (f"{gap} from the price", current_rate + gap if trade.is_short else current_rate - gap)]
        reason, target = next((c for c in candidates if self._stop_valid(c[1], current_rate, gap, trade.is_short)),
                              candidates[-1])
        tick = float(self._market(trade.pair).get("tickSize") or 0)
        for attempt in (target, target + tick if trade.is_short else target - tick):
            trade.adjust_stop_loss(current_rate, -stoploss_from_absolute(attempt, current_rate, is_short=trade.is_short,
                                                                         leverage=leverage), allow_refresh=True)
            if self._stop_valid(float(trade.stop_loss), current_rate, gap, trade.is_short):
                break
        logger.warning(
            "%s: stop %s is within %s of the price %s; moved to %s (%s)",
            trade.pair, stop, gap, current_rate, trade.stop_loss, reason,
        )
        self._last_valid_stop[trade.id] = float(trade.stop_loss)

    def adjust_trade_position(self, trade: Trade, current_time: datetime, current_rate: float,
                              current_profit: float, min_stake: Optional[float], max_stake: float,
                              current_entry_rate: float, current_exit_rate: float,
                              current_entry_profit: float, current_exit_profit: float, **kwargs):
        result = super().adjust_trade_position(trade, current_time, current_rate, current_profit, min_stake,
                                               max_stake, current_entry_rate, current_exit_rate,
                                               current_entry_profit, current_exit_profit, **kwargs)
        stake = result[0] if isinstance(result, tuple) else result
        if not stake:
            return None
        cs = self._contract_size(trade.pair)
        held = round(self._contracts(trade))

        if stake < 0:
            # Freqtrade sizes a partial exit as a fraction of the trade's stake.
            if held < int(self.tsx["partial_exit_min_contracts"]) or not trade.stake_amount:
                return None
            reduce = min(max(math.floor(held * (-stake / trade.stake_amount)), 1), held - 1)
            return -((reduce + 0.001) / held) * trade.stake_amount

        ok, _ = self._entries_allowed(current_time)
        if not ok or self._roll_blocked(trade.pair):
            return None
        # Strategies size DCA from the first entry's cost; keep that ratio in contracts.
        first_contracts, first_cost = self._first_entry_contracts(trade)
        if first_contracts and first_cost:
            add = math.floor(first_contracts * stake / first_cost + 1e-9)
        else:
            add = math.floor(stake * trade.leverage / (current_entry_rate * cs))
        stop_price = trade.get_custom_data(STOP_KEY)
        max_risk = self._guard.get("metrics", {}).get("maxRiskPerTrade")
        if stop_price is not None and max_risk:
            existing = abs(trade.open_rate - float(stop_price)) * held * cs
            per_contract = abs(current_entry_rate - float(stop_price)) * cs
            if per_contract > 0:
                add = min(add, math.floor((float(max_risk) - existing) / per_contract))
        fit = self._contracts_that_fit(trade.pair, exclude_pair=trade.pair) - held
        add = min(add, fit, int(self.tsx["max_contracts_per_trade"]) - held)
        if add < 1:
            return None
        return self._stake_for(trade.pair, add, current_entry_rate, trade.leverage)

    def _protection_exit_reason(self, pair: str, trade: Trade | None = None) -> str | None:
        """Why the account or the contract requires this position closed now, if it does."""
        if self._guard.get("flatten"):
            reasons = self._guard.get("flattenReasons") or []
            if any(r in ("day_locked", "account_locked") for r in reasons):
                return "account_protection"
            return "session_flat"
        days = self._market(pair).get("daysToExpiry")
        if not self._backtesting and days is not None and days < 0:
            return "contract_roll"
        return None

    def should_exit(self, trade: Trade, rate: float, current_time: datetime, *, enter: bool, exit_: bool,
                    low: Optional[float] = None, high: Optional[float] = None,
                    force_stoploss: float = 0) -> list[ExitCheckTuple]:
        exits = super().should_exit(trade, rate, current_time, enter=enter, exit_=exit_, low=low, high=high,
                                    force_stoploss=force_stoploss)
        reason = self._protection_exit_reason(trade.pair, trade)
        if not reason:
            return exits
        # Freqtrade skips custom_exit while an exit signal is active, and an exit signal can be vetoed
        # by exit_profit_only on a losing trade. Both would leave the position open through a flatten.
        # Callers try the exits in list order, so the protection exit goes first.
        protection = ExitCheckTuple(exit_type=ExitType.CUSTOM_EXIT, exit_reason=reason)
        return [protection] + [e for e in exits if e != protection]

    def custom_exit(self, pair: str, trade: Trade, current_time: datetime, current_rate: float,
                    current_profit: float, **kwargs) -> Optional[str]:
        reason = self._protection_exit_reason(pair, trade)
        if reason:
            return reason
        if self.tsx_of["enabled"] and self.tsx_of["cvd_divergence_exit"] and self._cvd_divergence(pair, trade):
            return "cvd_divergence"
        return super().custom_exit(pair, trade, current_time, current_rate, current_profit, **kwargs)

    def confirm_trade_exit(self, pair: str, trade: Trade, order_type: str, amount: float, rate: float,
                           time_in_force: str, exit_reason: str, current_time: datetime, **kwargs) -> bool:
        # Protection exits must never be vetoed by a strategy's profit-only checks.
        if exit_reason in PROTECTION_EXITS:
            return True
        return super().confirm_trade_exit(pair, trade, order_type, amount, rate, time_in_force, exit_reason,
                                          current_time, **kwargs)

    @property
    def protections(self):
        if not self.seconds_mode:
            return super().protections
        # Candle-count protections misbehave below 1m; use minutes instead.
        minutes = int(self.tsx["seconds_mode"].get("protection_minutes", 5))
        # Pause after each closed trade; cooldown_minutes 0 turns it off.
        cooldown = int(self.tsx["seconds_mode"].get("cooldown_minutes", minutes))
        prot = [{"method": "CooldownPeriod", "stop_duration": cooldown}] if cooldown > 0 else []
        if _value(getattr(self, "use_stop_protection", True)):
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
        delta = float(df["of_delta"].tail(max(1, int(self.tsx_of["confirm_delta_candles"]))).sum())
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
