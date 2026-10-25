"""Tests for projectx.orderflow.merge_features against the fake gateway."""

from __future__ import annotations

import math

import pandas as pd
import pytest

import projectx  # noqa: F401
from conftest import SECRET
from projectx.gateway_client import GatewayClient
from projectx.orderflow import FFILL, ZERO, fetch_features, merge_features

PAIR = "MES/USD:USD"
START = pd.Timestamp("2026-10-20 14:00", tz="UTC")


def candles(n=4) -> pd.DataFrame:
    return pd.DataFrame({
        "date": [START + pd.Timedelta(minutes=5 * i) for i in range(n)],
        "close": [float(i) for i in range(n)],
    })


def row(i: int, **values) -> dict:
    return {"ts": int((START + pd.Timedelta(minutes=5 * i)).timestamp() * 1000), **values}


@pytest.fixture
def client(gateway):
    gateway.reset()
    return GatewayClient(gateway.url, SECRET)


def test_features_are_joined_by_candle_date(gateway, client):
    gateway.features = [
        row(0, delta=5.0, cvd_session=5.0, buy_volume=8.0, sell_volume=3.0, poc=6000.0, bid=5999.75),
        row(1, delta=-2.0, cvd_session=3.0, buy_volume=1.0, sell_volume=3.0, poc=6001.0, bid=6000.0),
    ]
    out = merge_features(candles(), PAIR, "5m", client=client)
    assert out["of_delta"].tolist()[:2] == [5.0, -2.0]
    assert out["of_cvd_session"].tolist()[:2] == [5.0, 3.0]
    assert out["of_poc"].tolist()[:2] == [6000.0, 6001.0]
    assert out["close"].tolist() == [0.0, 1.0, 2.0, 3.0], "the candle columns are untouched"
    method, path, query, _ = gateway.requests[-1]
    assert (method, path) == ("GET", "/orderflow/features")
    assert query["symbol"] == PAIR and query["timeframe"] == "5m"
    assert int(query["since"]) == int(START.timestamp() * 1000)


def test_level_columns_are_forward_filled_and_flow_columns_zero_filled(gateway, client):
    gateway.features = [row(0, delta=5.0, buy_volume=8.0, cvd_session=5.0, poc=6000.0)]
    out = merge_features(candles(), PAIR, "5m", client=client)
    assert out["of_cvd_session"].tolist() == [5.0] * 4
    assert out["of_poc"].tolist() == [6000.0] * 4
    assert out["of_delta"].tolist() == [5.0, 0.0, 0.0, 0.0]
    assert out["of_buy_volume"].tolist() == [8.0, 0.0, 0.0, 0.0]


def test_a_level_before_the_first_feature_stays_nan(gateway, client):
    gateway.features = [row(2, delta=1.0, cvd_session=7.0)]
    out = merge_features(candles(), PAIR, "5m", client=client)
    assert math.isnan(out["of_cvd_session"].iloc[0]) and math.isnan(out["of_cvd_session"].iloc[1])
    assert out["of_cvd_session"].iloc[2:].tolist() == [7.0, 7.0]


def test_only_columns_the_gateway_sent_are_added(gateway, client):
    gateway.features = [row(0, delta=1.0)]
    out = merge_features(candles(), PAIR, "5m", client=client)
    assert "of_delta" in out and "of_poc" not in out


def test_custom_prefix(gateway, client):
    gateway.features = [row(0, delta=1.0)]
    assert "x_delta" in merge_features(candles(), PAIR, "5m", client=client, prefix="x_")


@pytest.mark.parametrize("answer", ["error", "empty"])
def test_failure_or_no_data_fall_back_to_nan_levels_and_zero_flows(gateway, client, answer):
    gateway.features = None if answer == "error" else []
    out = merge_features(candles(), PAIR, "5m", client=client)
    for col in FFILL:
        assert out[f"of_{col}"].isna().all(), col
    for col in ZERO:
        assert (out[f"of_{col}"] == 0.0).all(), col
    assert len(out) == 4


def test_unreachable_gateway_falls_back_too():
    down = GatewayClient("http://127.0.0.1:1", SECRET, timeout=1)
    out = merge_features(candles(), PAIR, "5m", client=down)
    assert (out["of_delta"] == 0.0).all() and out["of_cvd_session"].isna().all()


def test_an_empty_frame_is_returned_as_is_without_calling_the_gateway(gateway, client):
    empty = pd.DataFrame({"date": pd.Series([], dtype="datetime64[ns, UTC]")})
    out = merge_features(empty, PAIR, "5m", client=client)
    assert out is empty and out.empty
    assert gateway.requests == []


def test_fetch_features_converts_timestamps(gateway, client):
    gateway.features = [row(0, delta=1.0)]
    feat = fetch_features(client, PAIR, "5m", None)
    assert feat["date"].iloc[0] == START and "ts" not in feat
    gateway.features = []
    assert fetch_features(client, PAIR, "5m", None).empty
