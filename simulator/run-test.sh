#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------------------------------
# A/B test: cumulative vs delta temporality through ALB + 3 collectors
#
# Collector pipeline: pure passthrough (memory_limiter → batch).
# No deltatocumulative, no collector.instance label.
# Mimir has out_of_order_time_window: 5m enabled.
#
# Phase 1: DELTA temporality   → each collector independently builds
#           cumulative state via deltatocumulative... but we removed it.
#           Without deltatocumulative, Mimir rejects delta Sums.
#           This phase shows that delta CANNOT work with a stateless
#           passthrough collector and Mimir 2.17.
#
# Phase 2: CUMULATIVE temporality → collectors forward raw cumulative
#           values. All write to the same Mimir series (no extra labels).
#           The monotonic sequence is preserved regardless of which
#           collector forwards which point.
# -------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_DIR="${PROJECT_ROOT}/backends/mimir"
cd "$SCRIPT_DIR"

MIMIR_URL="${MIMIR_URL:-http://localhost:9010/prometheus}"
EXPORT_INTERVAL_MS="${EXPORT_INTERVAL_MS:-5000}"
NUM_SESSIONS="${NUM_SESSIONS:-6}"

echo "============================================================"
echo " Installing dependencies"
echo "============================================================"
npm install --silent 2>&1

# Full teardown and rebuild to guarantee clean Mimir state
reset_environment() {
    echo "Tearing down all services and volumes..."
    cd "$COMPOSE_DIR"
    docker-compose down -v 2>/dev/null || true
    echo "Bringing up fresh environment..."
    docker-compose up -d 2>/dev/null
    echo "Waiting for Mimir to become ready..."
    for i in $(seq 1 30); do
        if curl -sf http://localhost:9010/ready >/dev/null 2>&1; then
            echo "Mimir ready."
            cd "$SCRIPT_DIR"
            return
        fi
        sleep 2
    done
    echo "WARNING: Mimir did not become ready in 60s"
    cd "$SCRIPT_DIR"
}

run_phase() {
    local temporality="$1"
    local phase_num="$2"

    echo ""
    echo "============================================================"
    echo " PHASE ${phase_num}: ${temporality^^} temporality"
    echo "============================================================"

    if [ "$temporality" = "delta" ]; then
        echo ""
        echo "Sending DELTA counters through ALB → 3 stateless collectors."
        echo "Mimir 2.17 OTLP endpoint rejects delta Sums, so most data"
        echo "will be dropped by the collectors."
        echo ""
        echo "EXPECT: near-zero or partial data in Mimir (FAIL)."
    else
        echo ""
        echo "Sending CUMULATIVE counters through ALB → 3 stateless collectors."
        echo "Each collector forwards the raw cumulative value it received."
        echo "All collectors write to the SAME Mimir series (no extra labels)."
        echo "Mimir sees the full monotonic sequence regardless of which"
        echo "collector forwarded which point."
        echo ""
        echo "EXPECT: accurate totals matching ground truth (PASS)."
    fi
    echo ""

    # Run simulator and capture output
    local output
    output=$(TEMPORALITY="$temporality" \
        NUM_SESSIONS="$NUM_SESSIONS" \
        EXPORT_INTERVAL_MS="$EXPORT_INTERVAL_MS" \
        node simulator.mjs 2>&1)

    echo "$output"

    # Extract ground truth totals
    local totals_line
    totals_line=$(echo "$output" | grep "^TOTALS_JSON:" | tail -1)
    local tokens cost sessions
    tokens=$(echo "$totals_line" | sed 's/TOTALS_JSON://' | python3 -c "import sys,json; print(json.load(sys.stdin)['tokens'])")
    cost=$(echo "$totals_line" | sed 's/TOTALS_JSON://' | python3 -c "import sys,json; print(json.load(sys.stdin)['cost'])")
    sessions=$(echo "$totals_line" | sed 's/TOTALS_JSON://' | python3 -c "import sys,json; print(json.load(sys.stdin)['sessions'])")

    echo ""
    echo "Waiting 20s for metrics to propagate through collectors → Mimir..."
    sleep 20

    echo ""
    echo "============================================================"
    echo " PHASE ${phase_num} VALIDATION (${temporality^^})"
    echo "============================================================"

    PHASE="$temporality" \
    EXPECTED_TOKENS="$tokens" \
    EXPECTED_COST="$cost" \
    EXPECTED_SESSIONS="$sessions" \
    MIMIR_URL="$MIMIR_URL" \
    node validate.mjs
}

# -------------------------------------------------------------------
# Main
# -------------------------------------------------------------------

echo ""
echo "============================================================"
echo " Claude Code OTel Metrics — ALB Fan-out A/B Test"
echo "============================================================"
echo " Topology:   Client → nginx (round-robin) → 3 OTel Collectors → Mimir 2.17"
echo " Collectors: stateless passthrough (memory_limiter → batch)"
echo " Mimir:      out_of_order_time_window: 5m"
echo " Sessions:   $NUM_SESSIONS per phase"
echo " Export:     ${EXPORT_INTERVAL_MS}ms interval"
echo "============================================================"

# Phase 1: Delta (broken — Mimir rejects delta Sums)
reset_environment
run_phase "delta" 1

# Phase 2: Cumulative (correct — stateless passthrough works)
reset_environment
run_phase "cumulative" 2

echo ""
echo "============================================================"
echo " A/B TEST COMPLETE"
echo "============================================================"
echo ""
echo "Phase 1 (delta) FAILS because Mimir 2.17 rejects delta Sums"
echo "  via OTLP. Without deltatocumulative in the collector, the"
echo "  data is dropped."
echo ""
echo "Phase 2 (cumulative) PASSES because all collectors forward"
echo "  raw cumulative values to the same Mimir series. The ALB"
echo "  round-robin is transparent — the monotonic sequence is"
echo "  preserved regardless of which collector handles each export."
echo "  Mimir's out_of_order_time_window handles timing jitter."
echo ""
echo "Grafana: http://localhost:3001  (explore claude_code_* metrics)"
echo ""
