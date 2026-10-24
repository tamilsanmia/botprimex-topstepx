"""
ProjectX (TopstepX) support for Freqtrade.

Importing this package registers ``projectx`` with ccxt (sync, async and pro), so
Freqtrade's exchange-name checks accept it. The Freqtrade exchange subclass lives
in ``projectx.ft_exchange`` and is exported from ``freqtrade.exchange`` by the
custom Docker image.
"""

import ccxt
import ccxt.async_support
import ccxt.pro

from .ccxt_projectx import projectx, projectx_async, projectx_pro

__all__ = ["projectx", "projectx_async", "projectx_pro", "register"]


def register() -> None:
    for module, cls in ((ccxt, projectx), (ccxt.async_support, projectx_async), (ccxt.pro, projectx_pro)):
        setattr(module, "projectx", cls)
        names = getattr(module, "exchanges", None)
        if isinstance(names, list) and "projectx" not in names:
            names.append("projectx")


register()
