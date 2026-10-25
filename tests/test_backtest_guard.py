"""Tests for the backtest Topstep rules (projectx.backtest_guard)."""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import ccxt

import projectx  # noqa: F401
from projectx.backtest_guard import BacktestGuard
from projectx.ft_exchange import Projectx

ET = ZoneInfo("America/New_York")


def et(day: int, hh: int, mm: int = 0) -> datetime:
    """Tuesday 20 Oct 2026 = day 20; Saturday is the 24th."""
    return datetime(2026, 10, day, hh, mm, tzinfo=ET)


def guard(**topstep) -> BacktestGuard:
    base = {"phase": "evaluation", "preset": "50k", "start_balance": 50000, "session": {"news_blackout": []}}
    base.update(topstep)
    return BacktestGuard({"topstep": base})


def codes(res):
    return [r["code"] for r in res["reasons"]]


def test_active_mid_session_with_preset_limits():
    res = guard().evaluate(et(20, 10), [], 0)
    assert res["status"] == "active" and res["canEnter"]
    assert res["metrics"]["maxMiniEquivalent"] == 5
    assert res["metrics"]["mllFloor"] == 48000


def test_session_windows_flat_by_and_weekend():
    g = guard()
    assert "no_entry_window" in codes(g.evaluate(et(20, 15, 50), [], 0))
    flat = g.evaluate(et(20, 16, 6), [], 0)
    assert flat["flatten"] and "session_flat_by" in flat["flattenReasons"]
    weekend = g.evaluate(et(24, 12), [], 0)
    assert "weekend" in codes(weekend) and weekend["flatten"]
    news = guard(session={"news_blackout": [{"days": "mon-fri", "start": "08:28", "end": "08:35"}]})
    assert "news_blackout" in codes(news.evaluate(et(21, 8, 30), [], 0))


def test_daily_loss_soft_then_hard_lock_clears_next_session():
    g = guard()
    soft = g.evaluate(et(20, 11), [(et(20, 10), -750.0)], 1)
    assert "dll_soft" in codes(soft) and soft["status"] == "entries_blocked"
    hard = g.evaluate(et(20, 11, 30), [(et(20, 10), -750.0), (et(20, 11), -200.0)], 2)
    assert hard["status"] == "day_locked" and hard["flatten"]
    nxt = g.evaluate(et(21, 10), [(et(20, 10), -750.0), (et(20, 11), -200.0)], 0)
    assert nxt["status"] == "active"


def test_trailing_eod_floor_and_mll_buffer_lock():
    g = guard()
    g.evaluate(et(20, 10), [(et(20, 9), 1500.0)], 1)
    res = g.evaluate(et(21, 10), [(et(20, 9), 1500.0)], 0)
    assert res["metrics"]["mllFloor"] == 49500
    # 51,500 - 1,750 = 49,750: 250 above the 49,500 floor, inside the 300 buffer.
    locked = g.evaluate(et(21, 12), [(et(20, 9), 1500.0), (et(21, 11), -1750.0)], 1)
    assert locked["status"] == "account_locked" and "mll_buffer" in codes(locked)


def test_target_needs_consistency_before_locking():
    g = guard()
    closed = [(et(19, 10), 2000.0)]
    g.evaluate(et(19, 12), closed, 0)
    closed.append((et(20, 10), 1100.0))
    assert g.evaluate(et(20, 12), closed, 0)["status"] != "account_locked"
    closed.append((et(21, 10), 1000.0))
    passed = g.evaluate(et(21, 12), closed, 0)
    assert passed["status"] == "account_locked" and "target_passed" in codes(passed)
    research = guard(phases={"evaluation": {"stop_on_target": False}})
    assert research.evaluate(et(21, 12), closed, 0)["status"] != "account_locked"


def test_consistency_pct_zero_removes_daily_cap():
    g = guard(phases={"evaluation": {"consistency_pct": 0}})
    res = g.evaluate(et(20, 11), [(et(20, 10), 2500.0)], 1)
    assert "consistency_cap" not in codes(res)


def test_counters_and_consistency_cap():
    g = guard()
    assert "max_trades_per_day" in codes(g.evaluate(et(20, 11), [], 10))
    losses = [(et(20, 9, i), -10.0) for i in range(3)]
    assert "max_consecutive_losses" in codes(g.evaluate(et(20, 11), losses, 3))
    assert "consistency_cap" in codes(g.evaluate(et(20, 11), [(et(20, 10), 1600.0)], 1))


def test_funded_scaling_uses_last_eod_balance():
    g = guard(phase="funded", start_balance="auto")
    assert g.start == 0
    assert g.evaluate(et(20, 10), [], 0)["metrics"]["maxMiniEquivalent"] == 2
    g.evaluate(et(20, 12), [(et(20, 11), 1600.0)], 1)
    assert g.evaluate(et(21, 10), [(et(20, 11), 1600.0)], 0)["metrics"]["maxMiniEquivalent"] == 3


def test_disabled_guard_allows_everything():
    g = BacktestGuard({"topstep": {"enabled": False}})
    assert g.evaluate(et(24, 12), [], 99)["canEnter"]


def test_futures_backtest_support_hooks():
    ex = ccxt.projectx({"options": {"gatewayUrl": "http://127.0.0.1:1"}})
    since = (ex.milliseconds() // 3_600_000 - 10) * 3_600_000
    rows = ex.fetch_funding_rate_history("MES/USD:USD", since=since, limit=3)
    assert [r["fundingRate"] for r in rows] == [0.0, 0.0, 0.0]
    assert rows[1]["timestamp"] - rows[0]["timestamp"] == 3_600_000
    assert ex.has["fetchMarkOHLCV"] and ex.has["fetchFundingRateHistory"]
    assert Projectx._ft_has["uses_leverage_tiers"] is False


def test_session_start_is_previous_reset():
    g = guard()
    assert g.session_start(et(20, 10)).astimezone(ET) == et(19, 18)
    assert g.session_start(et(20, 18, 30)).astimezone(ET) == et(20, 18)
    assert g.session_start(et(20, 18, 30)) - g.session_start(et(20, 10)) == timedelta(days=1)
