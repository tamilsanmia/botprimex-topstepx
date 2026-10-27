"""
Runs tests/fixtures/guard_parity.json against projectx.backtest_guard.BacktestGuard.

The same file drives projectx-gateway/test/guard_parity.test.js against the gateway's
AccountGuard, which is the reference, so a rule changed on one side only fails here.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import pytest

import projectx  # noqa: F401
from projectx.backtest_guard import BacktestGuard

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "guard_parity.json").read_text())
SCENARIOS = FIXTURE["scenarios"]


def _check_metric(actual, expected, label):
    if expected is None:
        assert actual is None, label
    elif isinstance(expected, bool) or isinstance(expected, str):
        assert actual == expected, label
    else:
        assert actual is not None and abs(actual - expected) <= 0.01, f"{label}: expected {expected}, got {actual}"


@pytest.mark.parametrize("scenario", SCENARIOS, ids=[s["name"] for s in SCENARIOS])
def test_parity_scenario(scenario):
    topstep = {**FIXTURE["defaults"]["topstep"], **scenario.get("topstep", {})}
    if scenario.get("account_name"):
        topstep["account_name"] = scenario["account_name"]
    guard = BacktestGuard({"topstep": topstep})

    closed: list[tuple[datetime, float]] = []
    for i, step in enumerate(scenario["steps"], start=1):
        closed.extend((datetime.fromisoformat(c["at"]), float(c["net"])) for c in step["closed"])
        now = datetime.fromisoformat(step["now"])
        res = guard.evaluate(now, list(closed), step["entries_today"], unrealized=step["unrealized"])

        where = f"step {i} ({step['now']})"
        want = step["expect"]
        assert res["status"] == want["status"], f"{where} status"
        assert [r["code"] for r in res["reasons"]] == want["codes"], f"{where} reason codes"
        assert res["flatten"] == want["flatten"], f"{where} flatten"
        assert res["flattenReasons"] == want["flattenReasons"], f"{where} flatten reasons"
        for key, value in (want.get("metrics") or {}).items():
            _check_metric(res["metrics"].get(key), value, f"{where} metrics.{key}")


def test_fixture_is_not_empty():
    assert len(SCENARIOS) >= 25
    assert sum(len(s["steps"]) for s in SCENARIOS) >= 80
