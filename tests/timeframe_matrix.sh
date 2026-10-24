#!/usr/bin/env bash
# Dry-run compatibility matrix: runs the full stack (gateway in mock mode +
# Freqtrade) once per strategy timeframe, forces one entry, and reports errors.
#
#   tests/timeframe_matrix.sh [workdir] [timeframes...]
#
# Needs the images built (docker compose build). Never touches ProjectX.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-/tmp/projectx-matrix}"
shift || true
TFS=("${@:-1s 5s 15s 1m 5m}")
read -r -a TFS <<< "${TFS[*]}"
COMPOSE=(docker compose -p pxmatrix --project-directory "$WORK" -f "$REPO/docker-compose.yml")
API=http://127.0.0.1:8001/api/v1

mkdir -p "$WORK/user_data/strategies" "$WORK/user_data/logs"
cp "$REPO/BotPrimeX.py" "$REPO/BotPrimeX_TopstepX.py" "$WORK/user_data/strategies/"
printf 'PROJECTX_MOCK=1\nGATEWAY_SECRET=matrix-secret\n' > "$WORK/.env"

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
c["api_server"].update(username="matrix", password="matrix")
c["topstep"]["session"].update(trade_weekends=True, no_entry_after="17:50", no_entry_before="18:00",
                               flat_by="17:58", news_blackout=[])
c["topstep"]["protection"]["max_risk_per_trade"] = 5000
c["exchange"]["pair_whitelist"] = ["MES/USD:USD", "MNQ/USD:USD", "MGC/USD:USD"]
json.dump(c, open(dst, "w"), indent=2)
PY
  chown -R 1000:1000 "$WORK/user_data" 2>/dev/null || true
  "${COMPOSE[@]}" up -d --no-build >/dev/null 2>&1
  sleep 75
  TOK=$(curl -s -u matrix:matrix -X POST "$API/token/login" | python3 -c "import json,sys;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || true)
  ENTRY=$(curl -s -H "Authorization: Bearer $TOK" -H content-type:application/json -X POST "$API/forceenter" \
    -d '{"pair":"MNQ/USD:USD","side":"long"}' | python3 -c "import json,sys;t=json.load(sys.stdin);print(t.get('amount', t.get('error')))" 2>/dev/null || echo "api unreachable")
  sleep 20
  LOG=$(docker logs freqtrade 2>&1)
  ERRORS=$(grep -cE "ERROR|Traceback|Exception" <<< "$LOG" || true)
  ANALYZED=$(grep -c "TopstepX guard" <<< "$LOG" || true)
  HEARTBEAT=$(grep -c "Bot heartbeat" <<< "$LOG" || true)
  echo "timeframe=$TF entry_amount=$ENTRY errors=$ERRORS guard_reads=$ANALYZED heartbeats=$HEARTBEAT"
  if [ "$ERRORS" != "0" ]; then grep -E "ERROR|Traceback|Exception" <<< "$LOG" | sort | uniq -c | sort -rn | head -5 | cut -c1-240; fi
done
"${COMPOSE[@]}" down >/dev/null 2>&1 || true
