"""Tests for the backtest Topstep rules (projectx.backtest_guard)."""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import ccxt
import pytest
from freqtrade.exceptions import ConfigurationError

import projectx  # noqa: F401
from projectx.backtest_guard import BacktestGuard, account_product
from projectx.ft_exchange import Projectx

ET = ZoneInfo("America/New_York")


def et(day: int, hh: int, mm: int = 0) -> datetime:
    """Tuesday 20 Oct 2026 = day 20; Saturday is the 24th."""
    return datetime(2026, 10, day, hh, mm, tzinfo=ET)


def guard(**topstep) -> BacktestGuard:
    base = {"phase": "evaluation", "preset": "50k", "start_balance": 50000, "session": {"news_blackout": []},
            "protection": {"daily_profit_lock": {"enabled": False}}}
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
    assert "consistency_cap" in codes(g.evaluate(et(20, 11), [(et(20, 10), 1700.0)], 1))


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


# --- open P&L, giveback, trailing_intraday, daily_loss_type, EOD snapshot -----------------


def test_open_pnl_counts_towards_the_daily_loss_limit_and_the_mll():
    g = guard()
    soft = g.evaluate(et(20, 10), [], 0, unrealized=-700.0)
    assert soft["status"] == "entries_blocked" and codes(soft) == ["dll_soft"]
    assert soft["metrics"]["dayPnl"] == -700 and soft["metrics"]["equity"] == 49300
    hard = g.evaluate(et(20, 10, 5), [], 0, unrealized=-950.0)
    assert hard["status"] == "day_locked" and hard["flatten"] and "dll_hard" in codes(hard)
    assert g.evaluate(et(21, 10), [], 0)["status"] == "active"


def test_daily_loss_type_eod_ignores_open_pnl():
    g = guard(phases={"evaluation": {"daily_loss_type": "eod"}})
    res = g.evaluate(et(20, 10), [], 0, unrealized=-950.0)
    assert res["status"] == "active" and res["metrics"]["dayPnl"] == 0


def test_profit_giveback_locks_the_day_on_open_pnl():
    g = guard(protection={"daily_profit_lock": {"enabled": True, "activate_at": 800, "giveback_pct": 40}},
              phases={"evaluation": {"consistency_mode": "off"}})
    assert g.evaluate(et(20, 10), [], 0, unrealized=1000.0)["status"] == "active"
    locked = g.evaluate(et(20, 10, 5), [], 0, unrealized=590.0)
    assert locked["status"] == "day_locked" and codes(locked) == ["profit_giveback"]
    assert g.evaluate(et(21, 10), [], 0)["status"] == "active"


def test_trailing_intraday_high_water_follows_equity():
    g = guard(phases={"evaluation": {"max_loss_type": "trailing_intraday", "daily_loss_limit": False, "consistency_mode": "off"}})
    up = g.evaluate(et(20, 10), [], 0, unrealized=1500.0)
    assert up["metrics"]["highWater"] == 51500 and up["metrics"]["mllFloor"] == 49500
    down = g.evaluate(et(20, 10, 1), [], 0, unrealized=-300.0)
    assert down["status"] == "account_locked" and "mll_buffer" in codes(down)
    assert g.evaluate(et(21, 10), [], 0)["status"] == "account_locked", "an account lock stays"


def test_eod_snapshot_is_taken_at_eod_time_not_only_on_a_new_day():
    g = guard(phases={"evaluation": {"daily_loss_limit": False, "consistency_mode": "off"}})
    closed = [(et(20, 9), 1500.0)]
    assert g.evaluate(et(20, 16, 9), closed, 0)["metrics"]["mllFloor"] == 48000
    after = g.evaluate(et(20, 16, 10), closed, 0)
    assert after["metrics"]["mllFloor"] == 49500 and after["metrics"]["highWater"] == 51500
    # The snapshot is taken once: a later loss the same day does not lower it.
    assert g.evaluate(et(20, 16, 30), closed + [(et(20, 16, 20), -500.0)], 0)["metrics"]["highWater"] == 51500


def test_a_day_the_guard_never_saw_end_is_closed_from_the_next_evaluation():
    g = guard(phases={"evaluation": {"daily_loss_limit": False, "consistency_mode": "off"}})
    closed = [(et(20, 9), 1500.0)]
    g.evaluate(et(20, 12), closed, 0)
    nxt = g.evaluate(et(21, 10), closed, 0)
    assert nxt["metrics"]["highWater"] == 51500 and nxt["metrics"]["mllFloor"] == 49500


# --- consistency modes -------------------------------------------------------------------


def test_consistency_cap_day_default_and_55_percent():
    g = guard()
    assert g.rules["consistency_pct"] == 55 and g.rules["consistency_mode"] == "cap_day"
    res = g.evaluate(et(20, 11), [(et(20, 10), 1700.0)], 1)
    assert "consistency_cap" in codes(res) and res["metrics"]["consistencyCap"] == 1650


def test_consistency_raise_target_has_no_cap_and_lifts_the_target():
    g = guard(phases={"evaluation": {"consistency_mode": "raise_target"}})
    day = g.evaluate(et(20, 11), [(et(20, 10), 1700.0)], 1)
    assert "consistency_cap" not in codes(day) and day["metrics"]["consistencyCap"] is None
    assert day["metrics"]["effectiveTarget"] == pytest.approx(3090.91)
    more = g.evaluate(et(20, 12), [(et(20, 10), 1700.0), (et(20, 11, 50), 1350.0)], 1)
    assert more["status"] != "account_locked" and more["metrics"]["totalProfit"] == 3050


def test_consistency_off_ignores_consistency():
    g = guard(phases={"evaluation": {"consistency_mode": "off"}})
    assert "consistency_cap" not in codes(g.evaluate(et(20, 11), [(et(20, 10), 1900.0)], 1))
    closed = [(et(20, 10), 2500.0), (et(21, 9, 30), 600.0)]
    g.evaluate(et(20, 11), closed[:1], 1)
    passed = g.evaluate(et(21, 10), closed, 0)
    assert passed["status"] == "account_locked" and "target_passed" in codes(passed)


# --- holidays ---------------------------------------------------------------------------


def test_closed_holiday_acts_like_a_weekend_and_the_calendar_can_be_switched_off():
    g = guard()
    res = g.evaluate(datetime(2026, 4, 3, 10, tzinfo=ET), [], 0)
    assert codes(res) == ["holiday"] and res["flattenReasons"] == ["holiday"]
    assert res["holiday"]["type"] == "closed"
    off = guard(session={"use_holiday_calendar": False})
    assert off.evaluate(datetime(2026, 4, 3, 10, tzinfo=ET), [], 0)["status"] == "active"


def test_early_close_tightens_entries_and_flat_by_but_never_loosens_them():
    g = guard()

    def at(hh, mm):
        return datetime(2026, 5, 25, hh, mm, tzinfo=ET)

    assert g.evaluate(at(12, 24), [], 0)["status"] == "active"
    assert codes(g.evaluate(at(12, 25), [], 0)) == ["no_entry_window"]
    assert not g.evaluate(at(12, 39), [], 0)["flatten"]
    assert g.evaluate(at(12, 40), [], 0)["flattenReasons"] == ["session_flat_by"]
    earlier = guard(session={"no_entry_after": "11:00", "flat_by": "12:00"})
    assert codes(earlier.evaluate(at(11, 5), [], 0)) == ["no_entry_window"]
    assert earlier.evaluate(at(12, 5), [], 0)["flatten"]
    overnight = guard(session={"hold_mode": "overnight"})
    assert overnight.evaluate(at(14, 0), [], 0)["flatten"] is False


# --- reset(), auto resolution, validation ----------------------------------------------


def test_reset_clears_high_water_marks_locks_and_day_state():
    g = guard()
    closed = [(et(20, 9), 1500.0)]
    g.evaluate(et(20, 10), closed, 0)
    g.evaluate(et(20, 16, 11), closed, 0)
    locked = g.evaluate(et(21, 10), closed + [(et(21, 9), -1750.0)], 1)
    assert locked["status"] == "account_locked"
    assert g.hwm_eod == 51500 and g.account_lock and g.days and g.day_key
    g.reset()
    assert (g.hwm_eod, g.hwm_intraday, g.account_lock, g.day_lock, g.day_key, g.last_eod_key) == (None,) * 6
    assert g.days == {} and g.day_peak == 0
    fresh = g.evaluate(et(20, 10), [], 0)
    assert fresh["status"] == "active" and fresh["metrics"]["mllFloor"] == 48000


def test_auto_phase_and_preset_come_from_the_account_name():
    g = BacktestGuard({"topstep": {"phase": "auto", "preset": "auto", "account_name": "100KTC-7"}})
    assert (g.phase, g.start, g.rules["max_loss_limit"], g.rules["profit_target"]) == ("evaluation", 100000, 3000, 6000)
    xfa = BacktestGuard({"topstep": {"account_name": "150KXFA-1"}})
    assert (xfa.phase, xfa.start, xfa.rules["max_mini_equivalent"]) == ("funded", 0, 15)
    lfa = BacktestGuard({"topstep": {"account_name": "50KLFA-1"}})
    assert (lfa.phase, lfa.start, lfa.rules["mll_lock_balance"]) == ("live_funded", 50000, None)


def test_a_topstep_labs_account_name_is_a_zero_start_account():
    assert account_product("6KCHCR-LABS005-V2-684000-69917404") == (6000, "LABS")
    assert account_product("6KCHCRX-1") == (None, None)
    g = BacktestGuard({"topstep": {"phase": "funded", "account_name": "6KCHCR-LABS005-V2-684000-69917404", "phases": {
        "funded": {"daily_loss_limit": 300, "max_loss_limit": 400, "max_mini_equivalent": 1}}}})
    assert (g.size, g.start) == (6000, 0)


def test_auto_preset_can_come_from_a_numeric_start_balance():
    g = BacktestGuard({"topstep": {"phase": "evaluation", "preset": "auto", "start_balance": 100000}})
    assert g.size == 100000 and g.rules["daily_loss_limit"] == 2000


@pytest.mark.parametrize("topstep, message", [
    ({}, "topstep.phase is \"auto\""),
    ({"phase": "auto", "account_name": "6KCHCR-LABS005"}, "Topstep Labs"),
    ({"phase": "auto", "account_name": "PRACTICE"}, "no recognised product code"),
    ({"phase": "evaluation"}, "topstep.preset is \"auto\" but the account size is unknown"),
    ({"phase": "evaluation", "preset": "50k", "start_balance": "auto", "account_name": "nonsense"}, None),
    ({"phase": "funded", "preset": "auto", "start_balance": 0}, "account size is unknown"),
    ({"phase": "prop", "preset": "50k"}, "topstep.phase must be evaluation, funded or live_funded"),
    ({"phase": "evaluation", "preset": "huge"}, "topstep.preset must be"),
])
def test_unresolvable_phase_or_preset_raises_instead_of_defaulting_to_50k(topstep, message):
    if message is None:
        assert BacktestGuard({"topstep": topstep}).start == 50000
        return
    with pytest.raises(ConfigurationError, match=message):
        BacktestGuard({"topstep": topstep})


def test_a_preset_without_numbers_for_the_size_needs_explicit_limits():
    with pytest.raises(ConfigurationError, match="max_loss_limit is required"):
        BacktestGuard({"topstep": {"phase": "evaluation", "preset": "75k", "start_balance": 75000}})
    g = BacktestGuard({"topstep": {"phase": "evaluation", "preset": "75k", "start_balance": 75000, "phases": {"evaluation": {
        "profit_target": 4500, "daily_loss_limit": 1500, "max_loss_limit": 2500, "max_mini_equivalent": 7}}}})
    assert g.rules["max_loss_limit"] == 2500


def test_invalid_values_are_reported_together():
    with pytest.raises(ConfigurationError) as err:
        BacktestGuard({"topstep": {"phase": "evaluation", "preset": "50k", "session": {"flat_by": "4pm"},
                                   "phases": {"evaluation": {"consistency_mode": "strict", "max_loss_type": "weird"}}}})
    text = str(err.value)
    assert "consistency_mode must be" in text and "max_loss_type must be" in text and "session.flat_by" in text


def test_disabled_guard_needs_no_other_config():
    assert BacktestGuard({"topstep": {"enabled": False}}).evaluate(et(20, 10), [], 0)["status"] == "disabled"
    assert BacktestGuard({"topstep": {"enabled": False}}).evaluate(et(24, 12), [], 99, unrealized=-1e9)["canEnter"]


def test_session_start_follows_the_dst_offset():
    g = guard()
    fall = datetime(2026, 11, 2, 10, tzinfo=ET)
    assert g.session_start(fall).astimezone(ET) == datetime(2026, 11, 1, 18, tzinfo=ET)
    assert g.session_start(fall).utcoffset().total_seconds() == 0
    assert g.session_start(fall).hour == 23, "18:00 EST is 23:00 UTC"
    spring = datetime(2027, 3, 15, 10, tzinfo=ET)
    assert g.session_start(spring).hour == 22, "18:00 EDT is 22:00 UTC"
