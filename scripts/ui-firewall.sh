#!/usr/bin/env bash
# Restrict the FreqUI ports (live 8001 when FREQTRADE_BIND=0.0.0.0, backtest web app
# WEBSERVER_PORT/8095 when WEBSERVER_BIND=0.0.0.0) to the addresses in
# FREQTRADE_UI_ALLOW (.env, space-separated IPv4 addresses or CIDRs).
# Every other source is dropped in Docker's DOCKER-USER chain, which filters published
# container ports (ufw and INPUT rules do not). Re-run after editing FREQTRADE_UI_ALLOW.
#
#   sudo scripts/ui-firewall.sh          apply the rules
#   sudo scripts/ui-firewall.sh remove   delete them (port then follows FREQTRADE_BIND only)
set -euo pipefail
cd "$(dirname "$0")/.."

env_value() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"'" || true; }
PORTS=(8001 "$(env_value WEBSERVER_PORT)")
[ -n "${PORTS[1]}" ] || PORTS[1]=8095
TAG=freqtrade-ui

# Delete any rules this script added before.
while rule=$(iptables -S DOCKER-USER 2>/dev/null | grep -m1 -- "--comment $TAG"); do
  # shellcheck disable=SC2086  # the rule spec must split into words
  iptables ${rule/-A /-D }
done
[ "${1:-}" = "remove" ] && { echo "removed $TAG rules"; exit 0; }

allow=$(env_value FREQTRADE_UI_ALLOW)

for port in "${PORTS[@]}"; do
  match=(-p tcp -m conntrack --ctorigdstport "$port" --ctdir ORIGINAL -m comment --comment "$TAG")
  # Fail closed: drop everyone first, then insert the allowed sources above the drop.
  iptables -I DOCKER-USER "${match[@]}" -j DROP
  for src in $allow; do
    iptables -I DOCKER-USER -s "$src" "${match[@]}" -j RETURN
  done
done
echo "ports ${PORTS[*]} allowed from: ${allow:-nobody}"
