"""
Order flow features from the projectx-gateway, merged onto a strategy dataframe.

Freqtrade's native orderflow (``use_public_trades``) already adds delta, footprint
and imbalance columns. This adds what it does not compute:

    of_cvd_session   cumulative delta reset at each session start (18:00 ET)
    of_delta, of_buy_volume, of_sell_volume
    of_block_count, of_block_volume, of_block_delta   large prints
    of_poc, of_vah, of_val                            session volume profile
    of_bid, of_ask, of_spread                         touch at candle close
"""

from __future__ import annotations

import logging
import time

import ccxt
import pandas as pd

from .gateway_client import GatewayClient

logger = logging.getLogger(__name__)

FFILL = ["cvd_session", "poc", "vah", "val", "bid", "ask", "spread"]
ZERO = ["delta", "buy_volume", "sell_volume", "block_count", "block_volume", "block_delta"]

# Seconds one features call may take. Freqtrade analyses pairs one after another, so a
# slow gateway must not hold every pair for the client's full timeout.
FEATURES_TIMEOUT = 3.0
# After a timeout, skip the features call for this long and use the fallback columns:
# with ten pairs, ten timeouts in a row would still stall a bot loop.
FEATURES_BACKOFF_SECS = 30.0


def fetch_features(client: GatewayClient, pair: str, timeframe: str, since_ms: int | None) -> pd.DataFrame:
    rows = client.get(
        "/orderflow/features",
        {"symbol": pair, "timeframe": timeframe, "since": since_ms},
        timeout=min(client.timeout, FEATURES_TIMEOUT),
    )
    if not rows:
        return pd.DataFrame()
    feat = pd.DataFrame(rows)
    feat["date"] = pd.to_datetime(feat.pop("ts"), unit="ms", utc=True)
    return feat


def merge_features(
    dataframe: pd.DataFrame,
    pair: str,
    timeframe: str,
    client: GatewayClient | None = None,
    config: dict | None = None,
    prefix: str = "of_",
) -> pd.DataFrame:
    """Left-joins gateway order flow features onto ``dataframe`` by candle date."""
    if dataframe.empty:
        return dataframe
    client = client or GatewayClient.from_config(config)
    since = int(pd.Timestamp(dataframe["date"].iloc[0]).timestamp() * 1000)
    skip_until = getattr(client, "_of_skip_until", 0.0)
    if time.monotonic() < skip_until:
        logger.debug("Order flow features skipped for %s %s after a timeout", pair, timeframe)
        feat = pd.DataFrame()
    else:
        try:
            feat = fetch_features(client, pair, timeframe, since)
        except ccxt.RequestTimeout as e:
            client._of_skip_until = time.monotonic() + FEATURES_BACKOFF_SECS
            logger.warning(
                "Order flow features unavailable for %s %s: %s (skipping for %.0f s)", pair, timeframe, e, FEATURES_BACKOFF_SECS
            )
            feat = pd.DataFrame()
        except Exception as e:  # noqa: BLE001 - order flow is optional; never break the strategy
            logger.warning("Order flow features unavailable for %s %s: %s", pair, timeframe, e)
            feat = pd.DataFrame()

    columns = FFILL + ZERO
    if feat.empty:
        for col in columns:
            dataframe[f"{prefix}{col}"] = 0.0 if col in ZERO else float("nan")
        return dataframe

    feat = feat.rename(columns={c: f"{prefix}{c}" for c in columns if c in feat.columns})
    keep = ["date"] + [f"{prefix}{c}" for c in columns if f"{prefix}{c}" in feat.columns]
    merged = dataframe.merge(feat[keep], on="date", how="left")
    for col in FFILL:
        name = f"{prefix}{col}"
        if name in merged:
            merged[name] = merged[name].ffill()
    for col in ZERO:
        name = f"{prefix}{col}"
        if name in merged:
            merged[name] = merged[name].fillna(0.0)
    return merged
