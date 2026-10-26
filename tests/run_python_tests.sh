#!/usr/bin/env bash
# Run the Python test-suite inside the Freqtrade image against the working tree.
# Extra arguments are forwarded to pytest. Override the image with PX_TEST_IMAGE.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${PX_TEST_IMAGE:-botprimex/freqtrade-projectx:latest}"

exec docker run --rm \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -v "$REPO/projectx:/opt/projectx/projectx:ro" \
  -v "$REPO/tests:/tests:ro" \
  -v "$REPO/NoTankAI.py:/strategies/NoTankAI.py:ro" \
  -v "$REPO/NoTankAI_TopstepX.py:/strategies/NoTankAI_TopstepX.py:ro" \
  --entrypoint bash "$IMAGE" \
  -c 'pip install --user -q pytest >/dev/null 2>&1; python -m pytest -q -p no:cacheprovider /tests "$@"' \
  _ "$@"
