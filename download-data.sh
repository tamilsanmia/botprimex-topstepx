#!/bin/bash
# Download TopstepX (ProjectX) futures history for backtesting.
#
# History comes through the projectx-gateway (started automatically), stitched
# across contract rolls and back-adjusted, so each pair is one continuous series.
#
# ProjectX keeps 1h/2h/4h/1d bars for about a year but minute bars (1m-30m) for
# only about 60 days, so the minute timeframes come back shorter than the range.
# Re-run this every few weeks (without ERASE): Freqtrade appends to the files in
# user_data/data, so the local minute history keeps growing past 60 days.
#
#   ./download-data.sh                       # last 365 days, all timeframes below
#   START_DATE=20260101 ./download-data.sh   # custom start (YYYYMMDD)
#   ERASE=1 ./download-data.sh               # re-download from scratch (after a contract roll)
#   PAIRS="MES/USD:USD MNQ/USD:USD" TIMEFRAMES="5m 1h" ./download-data.sh
set -euo pipefail
cd "$(dirname "$0")"

read -r -a timeframes <<< "${TIMEFRAMES:-1m 5m 15m 30m 1h 2h 4h 1d}"
config="/freqtrade/user_data/config-futures-backtest.json"
compose=(docker compose -f docker-compose-webserver.yml)

START_DATE="${START_DATE:-$(date -u -d '365 days ago' +%Y%m%d)}"
END_DATE="${END_DATE:-$(date -u +%Y%m%d)}"
TIMERANGE="${START_DATE}-${END_DATE}"

if [ ! -f user_data/config-futures-backtest.json ]; then
    echo "Missing user_data/config-futures-backtest.json: cp config_backtest.example.json user_data/config-futures-backtest.json" >&2
    exit 1
fi

extra=()
if [ "${ERASE:-0}" = "1" ]; then
    extra+=(--erase)
fi
if [ -n "${PAIRS:-}" ]; then
    read -r -a pairs <<< "$PAIRS"
    extra+=(--pairs "${pairs[@]}")
fi

"${compose[@]}" up -d projectx-gateway

for tf in "${timeframes[@]}"; do
    echo "Downloading data for timeframe: $tf | Range: $TIMERANGE"

    "${compose[@]}" run --rm --no-deps freqtrade-webserver \
        download-data \
        --trading-mode futures \
        --config "$config" \
        --timeframe "$tf" \
        --timerange "$TIMERANGE" \
        "${extra[@]}"
done
