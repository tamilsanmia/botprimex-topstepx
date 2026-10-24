"""
Topstep rules for backtests and hyperopt.

Live and dry-run trading get their verdict from the gateway's AccountGuard. A
backtest replays history far faster than real time, so asking the gateway every
candle would be both slow and wrong (it would judge today's account, not the
replayed one). This evaluates the same rules from the backtest's own closed
trades and returns the same dict shape the gateway does, so the strategy code
path is identical.

What is modelled: the session clock (entry windows, flat_by, weekends, news
blackouts, trading windows), the Daily Loss Limit on realized P&L, the Maximum
Loss Limit (trailing_eod on end-of-day balances, or static), profit target with
consistency, the daily consistency cap, trade and consecutive-loss counters, and
the contract cap. Open P&L is not included, so intraday DLL breaches by an open
trade show up only when it closes.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

PRESETS = {
    50000: {
        "evaluation": {"profit_target": 3000, "daily_loss_limit": 1000, "max_loss_limit": 2000, "max_mini_equivalent": 5},
        "funded": {"daily_loss_limit": 1000, "max_loss_limit": 2000, "max_mini_equivalent": 5,
                   "scaling_plan": [{"min_profit": 0, "max_mini_equivalent": 2},
                                    {"min_profit": 1500, "max_mini_equivalent": 3},
                                    {"min_profit": 2000, "max_mini_equivalent": 5}]},
    },
    100000: {
        "evaluation": {"profit_target": 6000, "daily_loss_limit": 2000, "max_loss_limit": 3000, "max_mini_equivalent": 10},
        "funded": {"daily_loss_limit": 2000, "max_loss_limit": 3000, "max_mini_equivalent": 10,
                   "scaling_plan": [{"min_profit": 0, "max_mini_equivalent": 3},
                                    {"min_profit": 1500, "max_mini_equivalent": 4},
                                    {"min_profit": 2000, "max_mini_equivalent": 6},
                                    {"min_profit": 3000, "max_mini_equivalent": 10}]},
    },
    150000: {
        "evaluation": {"profit_target": 9000, "daily_loss_limit": 3000, "max_loss_limit": 4500, "max_mini_equivalent": 15},
        "funded": {"daily_loss_limit": 3000, "max_loss_limit": 4500, "max_mini_equivalent": 15,
                   "scaling_plan": [{"min_profit": 0, "max_mini_equivalent": 3},
                                    {"min_profit": 1500, "max_mini_equivalent": 4},
                                    {"min_profit": 2000, "max_mini_equivalent": 5},
                                    {"min_profit": 3000, "max_mini_equivalent": 10},
                                    {"min_profit": 4500, "max_mini_equivalent": 15}]},
    },
}
PHASE_DEFAULTS = {
    "evaluation": {"max_loss_type": "trailing_eod", "mll_lock_balance": None, "consistency_pct": 50, "stop_on_target": True},
    "funded": {"max_loss_type": "trailing_eod", "mll_lock_balance": 0, "consistency_pct": None, "stop_on_target": False},
}
PHASE_DEFAULTS["live_funded"] = dict(PHASE_DEFAULTS["funded"])
SESSION_DEFAULTS = {
    "reset_time": "18:00", "no_entry_before": "18:05", "no_entry_after": "15:45", "flat_by": "16:05",
    "hold_mode": "intraday", "trading_windows": [], "trade_weekends": False, "news_blackout": [],
}
PROTECTION_DEFAULTS = {
    "dll_soft_pct": 70, "dll_hard_pct": 90, "mll_buffer": 300, "max_risk_per_trade": 250,
    "max_trades_per_day": 10, "max_consecutive_losses": 3,
}
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _minutes(hhmm: str) -> int:
    h, m = str(hhmm).split(":")
    return int(h) * 60 + int(m)


def _in_window(minutes: int, start: int, end: int) -> bool:
    if start == end:
        return False
    return start <= minutes < end if start < end else minutes >= start or minutes < end


def _days(spec) -> set[int]:
    if not spec or spec in ("*", "all"):
        return set(range(7))
    out: set[int] = set()
    for token in spec if isinstance(spec, list) else str(spec).split(","):
        token = token.strip().lower()
        if "-" in token:
            a, b = (DAYS.index(x[:3]) for x in token.split("-"))
            i = a
            while True:
                out.add(i)
                if i == b:
                    break
                i = (i + 1) % 7
        else:
            out.add(DAYS.index(token[:3]))
    return out


def _defined(d: dict | None) -> dict:
    return {k: v for k, v in (d or {}).items() if v is not None}


class BacktestGuard:
    def __init__(self, config: dict):
        ts = config.get("topstep") or {}
        self.enabled = ts.get("enabled", True) is not False
        phase = ts.get("phase")
        self.phase = phase if phase in PHASE_DEFAULTS else "evaluation"
        preset = str(ts.get("preset") or "auto").lower()
        size = int(preset[:-1]) * 1000 if preset.endswith("k") and preset[:-1].isdigit() else 50000
        start = ts.get("start_balance")
        if start in (None, "auto"):
            start = 0 if self.phase != "evaluation" and size else size
        self.start = float(start)

        preset_rules = PRESETS.get(size, {}).get("funded" if self.phase == "live_funded" else self.phase, {})
        user = ts.get("phases", {}).get(self.phase) or {}
        self.rules = {**PHASE_DEFAULTS[self.phase], **preset_rules, **_defined(user)}
        self.rules.pop("session", None)
        self.session = {**SESSION_DEFAULTS, **_defined(ts.get("session")), **_defined(user.get("session"))}
        self.protection = {**PROTECTION_DEFAULTS, **_defined(ts.get("protection"))}
        self.tz = ZoneInfo(ts.get("timezone") or "America/New_York")
        self.t = {k: _minutes(self.session[k]) for k in ("reset_time", "no_entry_before", "no_entry_after", "flat_by")}
        self.windows = [(_minutes(w["start"]), _minutes(w["end"])) for w in self.session.get("trading_windows") or []]
        self.news = [(_days(w.get("days")), _minutes(w["start"]), _minutes(w["end"]), bool(w.get("flatten")))
                     for w in self.session.get("news_blackout") or []]

        self.hwm_eod = self.start
        self.day_key: str | None = None
        self.day_lock: str | None = None
        self.account_lock: str | None = None
        self.day_pnls: dict[str, float] = {}
        self.last_eod_balance: float | None = None

    def session_start(self, now: datetime) -> datetime:
        local = now.astimezone(self.tz)
        reset = local.replace(hour=self.t["reset_time"] // 60, minute=self.t["reset_time"] % 60, second=0, microsecond=0)
        if local < reset:
            reset -= timedelta(days=1)
        return reset.astimezone(timezone.utc)

    def _max_mini(self, profit: float) -> float:
        plan = self.rules.get("scaling_plan")
        if plan:
            cap = plan[0]["max_mini_equivalent"]
            for tier in sorted(plan, key=lambda x: x["min_profit"]):
                if profit >= tier["min_profit"]:
                    cap = tier["max_mini_equivalent"]
            if self.rules.get("max_mini_equivalent"):
                cap = min(cap, self.rules["max_mini_equivalent"])
            return cap
        return self.rules.get("max_mini_equivalent") or 5

    def evaluate(self, now: datetime, closed: list[tuple[datetime, float]], entries_today: int) -> dict[str, Any]:
        """`closed` is [(close_time_utc, net_profit)] for every closed trade so far."""
        if not self.enabled:
            return {"status": "disabled", "canEnter": True, "flatten": False, "flattenReasons": [], "reasons": [],
                    "metrics": {"maxRiskPerTrade": self.protection.get("max_risk_per_trade")}}
        r, p = self.rules, self.protection
        start = self.session_start(now)
        day_key = (start + timedelta(days=1)).date().isoformat()
        balance = self.start + sum(v for _, v in closed)
        today = [v for t, v in closed if t >= start]
        day_pnl = sum(today)

        if day_key != self.day_key:
            if self.day_key is not None:
                eod_balance = balance - day_pnl
                self.last_eod_balance = eod_balance
                self.hwm_eod = max(self.hwm_eod, eod_balance)
            self.day_key = day_key
            if self.day_lock != day_key:
                self.day_lock = None
        self.day_pnls[day_key] = day_pnl

        hwm = self.hwm_eod if r.get("max_loss_type") != "static" else self.start
        floor = hwm - r["max_loss_limit"]
        if r.get("max_loss_type") != "static" and r.get("mll_lock_balance") is not None:
            floor = min(floor, float(r["mll_lock_balance"]))
        total_profit = balance - self.start
        best_day = max([0.0, *self.day_pnls.values()])
        pct = r.get("consistency_pct")
        consistency_ok = not pct or total_profit <= 0 or best_day <= pct / 100 * total_profit

        reasons: list[dict] = []
        status_rank = {"active": 0, "entries_blocked": 1, "day_locked": 2, "account_locked": 3}

        def add(level, code):
            reasons.append({"level": level, "code": code})

        if balance - floor <= p["mll_buffer"] and not self.account_lock:
            self.account_lock = "mll_buffer"
        target = r.get("profit_target")
        if target and r.get("stop_on_target") and total_profit >= target and consistency_ok and not self.account_lock:
            self.account_lock = "target_passed"
        if self.account_lock:
            add("account_locked", self.account_lock)

        dll = r.get("daily_loss_limit") or None
        loss = max(0.0, -day_pnl)
        if dll and loss >= dll * p["dll_hard_pct"] / 100:
            self.day_lock = day_key
        if self.day_lock == day_key:
            add("day_locked", "dll_hard")
        if dll and loss >= dll * p["dll_soft_pct"] / 100:
            add("entries_blocked", "dll_soft")
        if pct and target and day_pnl >= pct / 100 * target:
            add("entries_blocked", "consistency_cap")
        if p.get("max_trades_per_day") and entries_today >= p["max_trades_per_day"]:
            add("entries_blocked", "max_trades_per_day")
        tail = 0
        for v in reversed(today):
            if v < 0:
                tail += 1
            else:
                break
        if p.get("max_consecutive_losses") and tail >= p["max_consecutive_losses"]:
            add("entries_blocked", "max_consecutive_losses")

        local = now.astimezone(self.tz)
        minutes = local.hour * 60 + local.minute
        wd = local.weekday()
        flatten = []
        weekend = wd == 5 or (wd == 4 and minutes >= self.t["flat_by"]) or (wd == 6 and minutes < self.t["reset_time"])
        if weekend and not self.session.get("trade_weekends"):
            add("entries_blocked", "weekend")
            flatten.append("weekend")
        else:
            if _in_window(minutes, self.t["no_entry_after"], self.t["no_entry_before"]):
                add("entries_blocked", "no_entry_window")
            if self.windows and not any(_in_window(minutes, a, b) for a, b in self.windows):
                add("entries_blocked", "outside_trading_windows")
            for days, a, b, flat in self.news:
                if wd in days and _in_window(minutes, a, b):
                    add("entries_blocked", "news_blackout")
                    if flat:
                        flatten.append("news_blackout")
            if self.session.get("hold_mode") == "intraday" and _in_window(minutes, self.t["flat_by"], self.t["reset_time"]):
                flatten.append("session_flat_by")

        status = max((x["level"] for x in reasons), key=status_rank.get, default="active")
        if status in ("day_locked", "account_locked"):
            flatten.insert(0, status)
        scaling_profit = (self.last_eod_balance if self.last_eod_balance is not None else balance) - self.start
        return {
            "status": status,
            "canEnter": status == "active",
            "flatten": bool(flatten),
            "flattenReasons": flatten,
            "reasons": reasons,
            "sessionStart": int(start.timestamp() * 1000),
            "metrics": {
                "balance": balance,
                "dayPnl": day_pnl,
                "dayLossRemaining": dll - loss if dll else None,
                "mllFloor": floor,
                "mllRoom": balance - floor,
                "maxMiniEquivalent": self._max_mini(scaling_profit),
                "maxRiskPerTrade": p.get("max_risk_per_trade"),
                "entriesToday": entries_today,
                "consecutiveLosses": tail,
            },
        }
