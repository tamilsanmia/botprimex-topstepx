"""
Per-contract trading costs for backtests, hyperopt and dry-run.

TopstepX charges a fixed exchange fee and commission per contract and per side, and
market orders slip. Freqtrade models costs as one percentage of the traded value
(`fee_open`/`fee_close`), so the dollar cost per contract is converted into the ratio
that charges exactly that much at the given price:

    ratio = (fee + commission + slippage_ticks * tickValue) / (contractSize * price)

The defaults mirror projectx-gateway/src/mock.js (0.37 fee + 0.25 commission, one tick
of slippage on market orders). Live trading never uses this: real fills carry the real fees.
"""

from __future__ import annotations

from typing import Any

COSTS_DEFAULTS = {
    "enabled": True,
    "fee_per_contract": 0.37,
    "commission_per_contract": 0.25,
    "slippage_ticks": 1,
}


def costs_config(config: dict | None) -> dict:
    return {**COSTS_DEFAULTS, **((config or {}).get("topstep_costs") or {})}


def dollars_per_contract(costs: dict, market: dict[str, Any]) -> float:
    """Dollars one contract costs per side, from a gateway market row."""
    tick_value = float(market.get("tickValue") or 0.0)
    return (
        float(costs.get("fee_per_contract") or 0.0)
        + float(costs.get("commission_per_contract") or 0.0)
        + float(costs.get("slippage_ticks") or 0.0) * tick_value
    )


def cost_ratio(costs: dict, market: dict[str, Any] | None, price: float | None) -> float | None:
    """Fee ratio for `price`, or None when costs are off or the market/price is unknown."""
    if not costs.get("enabled") or not market or not price or price <= 0:
        return None
    contract_size = float(market.get("contractSize") or 0.0)
    if contract_size <= 0:
        return None
    return dollars_per_contract(costs, market) / (contract_size * float(price))
