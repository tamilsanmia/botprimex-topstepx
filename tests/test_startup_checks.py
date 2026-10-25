"""Tests for projectx.startup_checks and its call from the Projectx exchange."""

from __future__ import annotations

import pytest
from freqtrade.enums import RunMode
from freqtrade.exceptions import ConfigurationError

import projectx  # noqa: F401
from projectx.ft_exchange import Projectx
from projectx.startup_checks import check_api_server_secrets, check_startup

GOOD = {
    "enabled": True, "jwt_secret_key": "k3y-9f8a7c6b5d4e3f2a1b", "ws_token": "w5-0a1b2c3d4e5f6a7b",
    "username": "admin", "password": "s3cret-0a1b2c3d4e5f",
}


def config(runmode=RunMode.DRY_RUN, **api):
    return {"runmode": runmode, "api_server": {**GOOD, **api}}


@pytest.mark.parametrize("key", ["jwt_secret_key", "ws_token", "password"])
@pytest.mark.parametrize("value", ["", "   ", None, "change-me", "Change-Me-To-A-Long-Random-String", "xx-CHANGE-ME-xx"])
def test_placeholder_or_empty_secrets_are_refused(key, value):
    with pytest.raises(ConfigurationError, match=f"api_server.{key}"):
        check_api_server_secrets({"api_server": {**GOOD, key: value}})


def test_a_missing_secret_is_refused():
    api = dict(GOOD)
    del api["ws_token"]
    with pytest.raises(ConfigurationError, match="api_server.ws_token"):
        check_api_server_secrets({"api_server": api})


def test_every_bad_key_is_named_and_no_secret_value_is_printed():
    with pytest.raises(ConfigurationError) as err:
        check_api_server_secrets({"api_server": {**GOOD, "jwt_secret_key": "", "password": "change-me"}})
    text = str(err.value)
    assert "api_server.jwt_secret_key" in text and "api_server.password" in text
    assert "api_server.ws_token" not in text


def test_ws_token_may_be_a_list():
    check_api_server_secrets({"api_server": {**GOOD, "ws_token": ["a-long-token-1", "a-long-token-2"]}})
    with pytest.raises(ConfigurationError, match="ws_token"):
        check_api_server_secrets({"api_server": {**GOOD, "ws_token": ["a-long-token-1", "change-me"]}})
    with pytest.raises(ConfigurationError, match="ws_token"):
        check_api_server_secrets({"api_server": {**GOOD, "ws_token": []}})


def test_real_secrets_and_a_disabled_or_missing_api_server_pass():
    check_api_server_secrets({"api_server": GOOD})
    check_api_server_secrets({"api_server": {"enabled": False, "password": "change-me"}})
    check_api_server_secrets({"api_server": {"password": "change-me"}})
    check_api_server_secrets({})


@pytest.mark.parametrize("runmode", [RunMode.LIVE, RunMode.DRY_RUN, RunMode.WEBSERVER, "live", "dry_run", "webserver"])
def test_trade_and_webserver_runmodes_are_checked(runmode):
    with pytest.raises(ConfigurationError):
        check_startup(config(runmode, password="change-me"))
    check_startup(config(runmode))


@pytest.mark.parametrize("runmode", [RunMode.BACKTEST, RunMode.HYPEROPT, RunMode.UTIL_EXCHANGE, RunMode.UTIL_NO_EXCHANGE,
                                     RunMode.PLOT, RunMode.OTHER, "backtest", None])
def test_other_runmodes_are_not_blocked(runmode):
    check_startup(config(runmode, password="change-me", jwt_secret_key="", ws_token="change-me"))
    check_startup({"api_server": {"enabled": True, "password": "change-me"}})


@pytest.mark.parametrize("runmode", [RunMode.LIVE, RunMode.DRY_RUN, RunMode.WEBSERVER])
def test_the_exchange_refuses_to_start_with_placeholder_secrets(runmode):
    # The check runs before the exchange touches the network or loads markets.
    with pytest.raises(ConfigurationError, match="api_server.ws_token"):
        Projectx(config(runmode, ws_token="change-me"))
