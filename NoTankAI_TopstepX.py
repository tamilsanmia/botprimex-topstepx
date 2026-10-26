"""
NoTankAi for TopstepX (ProjectX) CME futures, through the projectx-gateway.

NoTankAi's signals, ROI table and partial exits, unchanged, plus the TopstepX
layer from projectx.strategy_mixin:

  * Account protection (Topstep rules, loss limits, session clock); entries and
    DCA blocked unless active, positions closed on flatten.
  * Whole contracts sized by max_risk_per_trade, with a real protective stop
    instead of NoTankAi's -99%.
  * NoTankAi's dynamic crypto leverage is replaced by topstep_strategy.leverage
    (TopstepX has no exchange leverage; it only sets how stake is accounted).
  * DCA keeps NoTankAi's rule (one add at -15%, same size as the first entry),
    in whole contracts and capped by the remaining risk budget.

Optional signal DCA (topstep_strategy.signal_dca.enabled = true) replaces the last
three points:

  * The first entry is `first_contracts` contracts (default 1) with no protective
    stop: only the strategy's own stoploss (-0.99) applies, as a last resort.
  * A DCA fires on the next entry signal in the trade's direction (a candle that
    closed after the last fill), only while the trade is in a loss when
    `only_in_loss` is true, at most `max_adds` times.
  * Each DCA puts the stop at stop_atr_mult x ATR from its fill price and adds as
    many contracts as keep the whole position's risk to that stop within
    max_risk_per_trade (guard value, else topstep.protection.max_risk_per_trade),
    capped by max_contracts_per_trade and the mini-equivalent limit.
"""

from __future__ import annotations

import logging
import math
import os
import sys
from datetime import datetime, timedelta
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from NoTankAI import NoTankAi  # noqa: E402

from freqtrade.exchange import timeframe_to_seconds  # noqa: E402
from freqtrade.persistence import Order, Trade  # noqa: E402

from projectx.strategy_mixin import STOP_KEY, TopstepXMixin  # noqa: E402

logger = logging.getLogger(__name__)

SIGNAL_DCA_DEFAULTS = {"enabled": False, "first_contracts": 1, "max_adds": 2, "only_in_loss": True}
SIGNAL_DCA_TAG = "signal_dca"


class NoTankAi_TopstepX(TopstepXMixin, NoTankAi):
    def __init__(self, config: dict) -> None:
        super().__init__(config)
        self.signal_dca = {**SIGNAL_DCA_DEFAULTS, **((config.get("topstep_strategy") or {}).get("signal_dca") or {})}
        self._dca_stop_ticks: dict[int, float] = {}
        if self.signal_dca["enabled"]:
            self.max_entry_position_adjustment = int(self.signal_dca["max_adds"])

    # ------------------------------------------------------------------ helpers --

    def _max_risk(self) -> float | None:
        risk = self._guard.get("metrics", {}).get("maxRiskPerTrade")
        if not risk:
            risk = ((self.config.get("topstep") or {}).get("protection") or {}).get("max_risk_per_trade")
        return float(risk) if risk else None

    def _new_entry_signal(self, trade: Trade) -> bool:
        """
        A new entry signal in the trade's direction: the signal is on for the last closed
        candle, and it switched on (previous candle off) on a candle that closed after the
        last fill. NoTankAi's signals stay on for several candles, so the run that opened or
        last added to the trade never counts again.
        """
        df, _ = self.dp.get_analyzed_dataframe(trade.pair, self.timeframe)
        column = "enter_short" if trade.is_short else "enter_long"
        if df.empty or column not in df or df[column].iloc[-1] != 1:
            return False
        fills = [o.order_filled_utc for o in trade.select_filled_orders(trade.entry_side) if o.order_filled_utc]
        if not fills:
            return False
        signal = df[column].fillna(0) == 1
        switched_on = signal & ~signal.shift(1, fill_value=False)
        closes = df["date"] + timedelta(seconds=timeframe_to_seconds(self.timeframe))
        return bool((switched_on & (closes > max(fills))).any())

    # ---------------------------------------------------------------- callbacks --

    def custom_stake_amount(self, pair: str, current_time: datetime, current_rate: float, proposed_stake: float,
                            min_stake: Optional[float], max_stake: float, leverage: float,
                            entry_tag: Optional[str], side: str, **kwargs) -> float:
        stake = super().custom_stake_amount(pair, current_time, current_rate, proposed_stake, min_stake,
                                            max_stake, leverage, entry_tag, side, **kwargs)
        if not self.signal_dca["enabled"] or not stake:
            return stake
        # The first entry carries no protective stop; drop the one the mixin planned.
        self._planned_stop_ticks.pop(pair, None)
        contracts = int(self.signal_dca["first_contracts"])
        affordable = math.floor(max_stake * max(leverage, 1.0) / (self._contract_size(pair) * current_rate))
        contracts = min(contracts, affordable, int(self.tsx["max_contracts_per_trade"]), self._contracts_that_fit(pair))
        if contracts < 1:
            return 0.0
        return self._stake_for(pair, contracts, current_rate, leverage)

    def order_filled(self, pair: str, trade: Trade, order: Order, current_time: datetime, **kwargs) -> None:
        if not self.signal_dca["enabled"]:
            return super().order_filled(pair, trade, order, current_time, **kwargs)
        # The mixin would give the first fill an ATR stop; here only DCA fills set one.
        NoTankAi.order_filled(self, pair, trade, order, current_time, **kwargs)
        if order.ft_order_side != trade.entry_side:
            return
        self._apply_costs(trade)
        if len(trade.select_filled_orders(trade.entry_side)) < 2:
            return
        tick = float(self._market(pair).get("tickSize") or 0)
        price = float(order.safe_price or 0)
        ticks = self._dca_stop_ticks.pop(trade.id, None) or self._stop_ticks(pair)
        if not tick or not price:
            return
        distance = ticks * tick
        stop = price + distance if trade.is_short else price - distance
        trade.set_custom_data(STOP_KEY, stop)
        logger.info("%s DCA filled at %s: protective stop %s (%s ticks) for %s contracts",
                    pair, price, stop, ticks, round(self._contracts(trade)))

    def adjust_trade_position(self, trade: Trade, current_time: datetime, current_rate: float,
                              current_profit: float, min_stake: Optional[float], max_stake: float,
                              current_entry_rate: float, current_exit_rate: float,
                              current_entry_profit: float, current_exit_profit: float, **kwargs):
        if not self.signal_dca["enabled"]:
            return super().adjust_trade_position(trade, current_time, current_rate, current_profit, min_stake,
                                                 max_stake, current_entry_rate, current_exit_rate,
                                                 current_entry_profit, current_exit_profit, **kwargs)
        # Keep the strategy's partial exits (sized by the mixin); its -15% DCA is replaced below.
        result = super().adjust_trade_position(trade, current_time, current_rate, current_profit, min_stake,
                                               max_stake, current_entry_rate, current_exit_rate,
                                               current_entry_profit, current_exit_profit, **kwargs)
        stake = result[0] if isinstance(result, tuple) else result
        if stake is not None and stake < 0:
            return result

        adds_done = trade.nr_of_successful_entries - 1
        if adds_done >= int(self.signal_dca["max_adds"]) or trade.has_open_orders:
            return None
        if self.signal_dca["only_in_loss"] and current_profit >= 0:
            return None
        if not self._new_entry_signal(trade):
            return None
        ok, why = self._entries_allowed(current_time)
        if not ok or self._roll_blocked(trade.pair):
            self._log_skip("%s signal DCA skipped: %s", trade.pair, why or "contract roll")
            return None

        market = self._market(trade.pair)
        tick, tick_value = float(market.get("tickSize") or 0), float(market.get("tickValue") or 0)
        max_risk = self._max_risk()
        if not tick or not tick_value or not max_risk:
            self._log_skip("%s signal DCA skipped: no tick size/value or max_risk_per_trade", trade.pair)
            return None
        cs = self._contract_size(trade.pair)
        held = round(self._contracts(trade))
        stop_ticks = self._stop_ticks(trade.pair)
        distance = stop_ticks * tick
        stop = current_entry_rate + distance if trade.is_short else current_entry_rate - distance
        existing = max(0.0, (stop - trade.open_rate) if trade.is_short else (trade.open_rate - stop)) * held * cs
        per_contract = stop_ticks * tick_value
        add = math.floor((max_risk - existing) / per_contract + 1e-9)
        fit = self._contracts_that_fit(trade.pair, exclude_pair=trade.pair) - held
        affordable = math.floor(max_stake * max(trade.leverage, 1.0) / (cs * current_entry_rate))
        add = min(add, fit, affordable, int(self.tsx["max_contracts_per_trade"]) - held)
        if add < 1:
            self._log_skip("%s signal DCA skipped: risk to a %s-tick stop already uses $%.0f of $%.0f",
                           trade.pair, stop_ticks, existing, max_risk)
            return None
        self._dca_stop_ticks[trade.id] = stop_ticks
        logger.info("%s signal DCA #%s: +%s contracts at ~%s, stop %s (%s ticks), risk $%.0f/$%.0f",
                    trade.pair, adds_done + 1, add, current_entry_rate, stop, stop_ticks,
                    existing + add * per_contract, max_risk)
        return self._stake_for(trade.pair, add, current_entry_rate, trade.leverage), SIGNAL_DCA_TAG
