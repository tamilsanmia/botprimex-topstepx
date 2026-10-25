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
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from NoTankAI import NoTankAi  # noqa: E402

from projectx.strategy_mixin import TopstepXMixin  # noqa: E402


class NoTankAi_TopstepX(TopstepXMixin, NoTankAi):
    pass
