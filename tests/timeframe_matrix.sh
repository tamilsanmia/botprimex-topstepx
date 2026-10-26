#!/usr/bin/env bash
# Dry-run compatibility matrix: runs a throwaway stack (gateway in mock mode +
# Freqtrade, tests/docker-compose.matrix.yml, project "pxmatrix") once per strategy
# and timeframe, forces one entry, and reports errors in a final table.
#
#   tests/timeframe_matrix.sh [workdir] [timeframes...]
#
#   MATRIX_STRATEGIES="BotPrimeX_TopstepX NoTankAi_TopstepX"   strategies to cover (default: both)
#   MATRIX_TAG=fixcheck   image tag to test (default: latest)
#   MATRIX_PORT=18001     loopback port of the Freqtrade API
#
# Needs the images built. It starts and stops only its own pxmatrix containers and
# never touches ProjectX, the live stack or the backtest stack.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-/tmp/projectx-matrix}"
shift || true
if [ $# -gt 0 ]; then TFS=("$@"); else TFS=(1s 5s 15s 1m 5m); fi
read -r -a STRATEGIES <<< "${MATRIX_STRATEGIES:-BotPrimeX_TopstepX NoTankAi_TopstepX}"
export MATRIX_WORK="$WORK" MATRIX_PORT="${MATRIX_PORT:-18001}"
COMPOSE=(docker compose -p pxmatrix -f "$REPO/tests/docker-compose.matrix.yml")
API="http://127.0.0.1:$MATRIX_PORT/api/v1"
trap '"${COMPOSE[@]}" down >/dev/null 2>&1 || true' EXIT
mkdir -p "$WORK/user_data/strategies" "$WORK/user_data/logs"
cp "$REPO/BotPrimeX.py" "$REPO/BotPrimeX_TopstepX.py" "$REPO/NoTankAI.py" "$REPO/NoTankAI_TopstepX.py" "$WORK/user_data/strategies/"
ROWS=()
FAILED=0
for STRATEGY in "${STRATEGIES[@]}"; do
  export STRATEGY
  for TF in "${TFS[@]}"; do
    "${COMPOSE[@]}" down >/dev/null 2>&1 || true
    rm -f "$WORK"/user_data/*.sqlite* "$WORK"/user_data/topstep_state.*.json "$WORK"/user_data/logs/*
    python3 - "$REPO/config_projectx.example.json" "$WORK/user_data/config.json" "$TF" <<'PY'
import json, re, sys
src, dst, tf = sys.argv[1:4]
text = open(src).read()
text = re.sub(r'^\s*//.*$', '', text, flags=re.M)
c = json.loads(text)
c.update(dry_run=True, timeframe=tf, force_entry_enable=True)
c["api_server"].update(username="matrix", password="matrix-password",
                       jwt_secret_key="matrix-jwt-secret-0123456789abcdef", ws_token="matrix-ws-token")
c["topstep"]["session"].update(trade_weekends=True, no_entry_after="17:50", no_entry_before="18:00",
                               flat_by="17:58", news_blackout=[], use_holiday_calendar=False)
c["topstep"]["protection"]["max_risk_per_trade"] = 5000
c["exchange"]["pair_whitelist"] = ["MES/USD:USD", "MNQ/USD:USD", "MGC/USD:USD"]
json.dump(c, open(dst, "w"), indent=2)
PY
    chown -R 1000:1000 "$WORK/user_data" 2>/dev/null || true
    "${COMPOSE[@]}" up -d --no-build >/dev/null 2>&1
    sleep 75
    TOK=$(curl -s -u matrix:matrix-password -X POST "$API/token/login" | python3 -c "import json,sys;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || true)
    ENTRY=$(curl -s -H "Authorization: Bearer $TOK" -H content-type:application/json -X POST "$API/forceenter" \
      -d '{"pair":"MNQ/USD:USD","side":"long"}' | python3 -c "import json,sys;t=json.load(sys.stdin);print(t.get('amount', t.get('error')))" 2>/dev/null || echo "api unreachable")
    sleep 20
    LOG=$("${COMPOSE[@]}" logs --no-color freqtrade 2>&1)
    ERRORS=$(grep -cE "ERROR|Traceback|Exception" <<< "$LOG" || true)
    ANALYZED=$(grep -c "TopstepX guard" <<< "$LOG" || true)
    HEARTBEAT=$(grep -c "Bot heartbeat" <<< "$LOG" || true)
    ROWS+=("$(printf '%-22s %-9s %-14s %-8s %-12s %s' "$STRATEGY" "$TF" "$ENTRY" "$ERRORS" "$ANALYZED" "$HEARTBEAT")")
    if [ "$ERRORS" != "0" ]; then
      FAILED=1
      echo "== $STRATEGY $TF: errors"
      grep -E "ERROR|Traceback|Exception" <<< "$LOG" | sort | uniq -c | sort -rn | head -5 | cut -c1-240
    fi
  done
done
"${COMPOSE[@]}" down >/dev/null 2>&1 || true
echo
printf '%-22s %-9s %-14s %-8s %-12s %s\n' strategy timeframe entry_amount errors guard_reads heartbeats
for ROW in "${ROWS[@]}"; do echo "$ROW"; done
exit "$FAILED"
