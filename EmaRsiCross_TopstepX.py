"""
EmaRsiCross for TopstepX (ProjectX) CME futures, through the projectx-gateway.

EmaRsiCross's signals (EMA 20/200 cross, RSI 30/70), unchanged, plus the TopstepX
layer from projectx.strategy_mixin:

  * Account protection (Topstep rules, loss limits, session clock); entries
    blocked unless active, positions closed on flatten.
  * Whole contracts sized by max_risk_per_trade and capped by
    max_contracts_per_trade, with a protective ATR stop tighter than the -10% one.
  * Leverage fixed by topstep_strategy.leverage (it only sets how stake is
    accounted; TopstepX has no exchange leverage). No DCA.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from EmaRsiCross import EmaRsiCross  # noqa: E402

from projectx.strategy_mixin import TopstepXMixin  # noqa: E402


class EmaRsiCross_TopstepX(TopstepXMixin, EmaRsiCross):
    pass
