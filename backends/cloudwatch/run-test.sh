#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------------------------------
# CloudWatch backend validation test
#
# Runs the simulator through 3 collectors behind nginx (round-robin)
# into real CloudWatch via awsemf exporter, then queries CloudWatch
# to validate data arrived correctly.
#
# Requires:
#   - AWS credentials (env vars, instance role, or ~/.aws)
#   - AWS_REGION set (defaults to us-east-1)
#   - Docker
#
# Usage:
#   AWS_REGION=ap-northeast-2 bash run-test.sh
# -------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
REGION="${AWS_REGION:-us-east-1}"
CW_NAMESPACE="ClaudeCode"
NUM_SESSIONS="${NUM_SESSIONS:-3}"
EXPORT_INTERVAL_MS="${EXPORT_INTERVAL_MS:-5000}"

echo "============================================================"
echo " CloudWatch Backend Test (delta temporality)"
echo "============================================================"
echo " Region:     $REGION"
echo " Namespace:  $CW_NAMESPACE"
echo " Sessions:   $NUM_SESSIONS"
echo "============================================================"

# -------------------------------------------------------------------
# 1. Resolve AWS credentials
# -------------------------------------------------------------------
echo ""
echo "[1] Resolving AWS credentials..."

# If credentials are not already in env, try instance metadata (IMDSv2)
if [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
    TOKEN=$(curl -s --connect-timeout 2 -X PUT "http://169.254.169.254/latest/api/token" \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)

    if [ -n "$TOKEN" ]; then
        ROLE=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
            http://169.254.169.254/latest/meta-data/iam/security-credentials/)
        CREDS_JSON=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
            http://169.254.169.254/latest/meta-data/iam/security-credentials/$ROLE)

        export AWS_ACCESS_KEY_ID=$(echo "$CREDS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['AccessKeyId'])")
        export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['SecretAccessKey'])")
        export AWS_SESSION_TOKEN=$(echo "$CREDS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['Token'])")
        echo "  Source: instance role ($ROLE)"
    else
        echo "  Source: ~/.aws or environment (no instance metadata)"
    fi
else
    echo "  Source: environment variables"
fi
echo "  Key: ${AWS_ACCESS_KEY_ID:0:8}..."

export AWS_REGION="$REGION"

# -------------------------------------------------------------------
# 2. Start the collector stack
# -------------------------------------------------------------------
echo ""
echo "[2] Starting nginx + 3 collectors..."
cd "$SCRIPT_DIR"
docker-compose down 2>&1 || true
docker-compose up -d 2>&1
echo "  Waiting 10s for collectors..."
sleep 10

for i in 1 2 3; do
    STATUS=$(docker-compose ps --format json 2>/dev/null | python3 -c "
import sys,json
for line in sys.stdin:
    obj = json.loads(line)
    if 'collector-$i' in obj.get('Name',''):
        print(obj.get('State','unknown'))
        break
" 2>/dev/null || echo "unknown")
    echo "  collector-$i: $STATUS"
done

# -------------------------------------------------------------------
# 3. Run the simulator
# -------------------------------------------------------------------
echo ""
echo "[3] Running simulator (delta, $NUM_SESSIONS sessions)..."
cd "$PROJECT_ROOT/simulator"
npm install --silent 2>&1

OUTPUT=$(TEMPORALITY=delta \
    NUM_SESSIONS="$NUM_SESSIONS" \
    EXPORT_INTERVAL_MS="$EXPORT_INTERVAL_MS" \
    SIMULATOR_OTLP_ENDPOINT="http://localhost:4318" \
    node simulator.mjs 2>&1)

echo "$OUTPUT"

TOTALS_LINE=$(echo "$OUTPUT" | grep "^TOTALS_JSON:" | tail -1)
EXPECTED_TOKENS=$(echo "$TOTALS_LINE" | sed 's/TOTALS_JSON://' | python3 -c "import sys,json; print(json.load(sys.stdin)['tokens'])")
EXPECTED_COST=$(echo "$TOTALS_LINE" | sed 's/TOTALS_JSON://' | python3 -c "import sys,json; print(json.load(sys.stdin)['cost'])")
EXPECTED_SESSIONS=$(echo "$TOTALS_LINE" | sed 's/TOTALS_JSON://' | python3 -c "import sys,json; print(json.load(sys.stdin)['sessions'])")

echo ""
echo "  Ground truth: tokens=$EXPECTED_TOKENS  cost=\$$EXPECTED_COST  sessions=$EXPECTED_SESSIONS"

# -------------------------------------------------------------------
# 4. Wait for CloudWatch propagation
# -------------------------------------------------------------------
echo ""
echo "[4] Waiting 120s for CloudWatch propagation..."
echo "  (CloudWatch has 1-2 minute ingestion delay)"
sleep 120

# -------------------------------------------------------------------
# 5. Validate
# -------------------------------------------------------------------
echo ""
echo "============================================================"
echo " VALIDATION"
echo "============================================================"

QUERY_START="$(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%S)"
QUERY_END="$(date -u -d '+5 minutes' +%Y-%m-%dT%H:%M:%S)"

# 5a. Check metrics exist
echo ""
echo "[5a] Metrics in namespace '$CW_NAMESPACE':"
METRICS=$(aws cloudwatch list-metrics --namespace "$CW_NAMESPACE" --region "$REGION" --output json 2>&1)
METRIC_NAMES=$(echo "$METRICS" | python3 -c "
import sys,json
data = json.load(sys.stdin)
names = sorted(set(m['MetricName'] for m in data.get('Metrics',[])))
for n in names: print(f'    {n}')
")
echo "$METRIC_NAMES"

METRIC_COUNT=$(echo "$METRICS" | python3 -c "
import sys,json; data=json.load(sys.stdin); print(len(set(m['MetricName'] for m in data.get('Metrics',[]))))
")
echo "  Count: $METRIC_COUNT / 8"

# 5b. Token totals
echo ""
echo "[5b] Token usage by model+type:"
TOTAL=0
for MODEL in "claude-sonnet-4-6" "claude-opus-4-6" "claude-haiku-4-5-20251001"; do
  for TYPE in "input" "output" "cacheRead" "cacheCreation"; do
    VAL=$(aws cloudwatch get-metric-statistics \
      --namespace "$CW_NAMESPACE" \
      --metric-name "claude_code.token.usage" \
      --dimensions Name=model,Value=$MODEL Name=type,Value=$TYPE \
      --start-time "$QUERY_START" --end-time "$QUERY_END" \
      --period 600 --statistics Sum \
      --region "$REGION" --output json 2>&1 | python3 -c "
import sys,json; data=json.load(sys.stdin); print(sum(d['Sum'] for d in data.get('Datapoints',[])))
")
    TOTAL=$(python3 -c "print($TOTAL + $VAL)")
    if [ "$VAL" != "0" ] && [ "$VAL" != "0.0" ]; then
      printf "    %-35s %-14s %s\n" "$MODEL" "$TYPE" "$VAL"
    fi
  done
done

echo ""
echo "  CloudWatch total: $TOTAL"
echo "  Expected:         $EXPECTED_TOKENS"
python3 -c "
t=$TOTAL; e=$EXPECTED_TOKENS
if e > 0:
    pct = (t - e) / e * 100
    status = 'PASS' if abs(pct) < 5 else 'FAIL'
    print(f'  Deviation:        {pct:+.1f}%  [{status}]')
"

# 5c. Sessions
echo ""
echo "[5c] Sessions:"
SESSION_TOTAL=0
for USER in "user-1" "user-2" "user-3"; do
  for TERM in "cursor" "Terminal.app" "iTerm.app" "vscode" "wezterm"; do
    VAL=$(aws cloudwatch get-metric-statistics \
      --namespace "$CW_NAMESPACE" \
      --metric-name "claude_code.session.count" \
      --dimensions Name=user.id,Value=$USER Name=terminal.type,Value=$TERM \
      --start-time "$QUERY_START" --end-time "$QUERY_END" \
      --period 600 --statistics Sum \
      --region "$REGION" --output json 2>&1 | python3 -c "
import sys,json; data=json.load(sys.stdin); print(sum(d['Sum'] for d in data.get('Datapoints',[])))
")
    if [ "$VAL" != "0" ] && [ "$VAL" != "0.0" ]; then
      echo "    $USER / $TERM: $VAL"
      SESSION_TOTAL=$(python3 -c "print(int($SESSION_TOTAL + $VAL))")
    fi
  done
done
echo "  Total sessions:   $SESSION_TOTAL"
echo "  Expected:         $EXPECTED_SESSIONS"

# 5d. Cost
echo ""
echo "[5d] Cost by model:"
COST_TOTAL=0
for MODEL in "claude-sonnet-4-6" "claude-opus-4-6" "claude-haiku-4-5-20251001"; do
  VAL=$(aws cloudwatch get-metric-statistics \
    --namespace "$CW_NAMESPACE" \
    --metric-name "claude_code.cost.usage" \
    --dimensions Name=model,Value=$MODEL \
    --start-time "$QUERY_START" --end-time "$QUERY_END" \
    --period 600 --statistics Sum \
    --region "$REGION" --output json 2>&1 | python3 -c "
import sys,json; data=json.load(sys.stdin); print(round(sum(d['Sum'] for d in data.get('Datapoints',[])), 6))
")
  COST_TOTAL=$(python3 -c "print(round($COST_TOTAL + $VAL, 6))")
  if [ "$VAL" != "0" ] && [ "$VAL" != "0.0" ]; then
    echo "    $MODEL: \$$VAL"
  fi
done
echo "  Total cost:       \$$COST_TOTAL"
echo "  Expected:         \$$EXPECTED_COST"

# 5e. Dimension check
echo ""
echo "[5e] Dimensions (session.id should be absent):"
DIMS=$(echo "$METRICS" | python3 -c "
import sys,json
data = json.load(sys.stdin)
all_dims = set()
for m in data.get('Metrics',[]):
    for d in m.get('Dimensions',[]):
        all_dims.add(d['Name'])
for d in sorted(all_dims): print(f'    {d}')
")
echo "$DIMS"

HAS_SESSION=$(echo "$DIMS" | grep -c "session" || true)
if [ "$HAS_SESSION" -gt 0 ]; then
    echo "  WARNING: session dimension found"
else
    echo "  session.id absent  [CLEAN]"
fi

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
echo ""
echo "============================================================"
echo " SUMMARY"
echo "============================================================"

TOKEN_PASS=$(python3 -c "
t=$TOTAL; e=$EXPECTED_TOKENS
print('PASS' if e > 0 and abs((t-e)/e*100) < 5 else 'FAIL')
")

echo "  Metrics:          $METRIC_COUNT / 8"
echo "  Tokens:           $TOKEN_PASS ($TOTAL / $EXPECTED_TOKENS)"
echo "  Sessions:         $SESSION_TOTAL / $EXPECTED_SESSIONS"
echo "  session.id drop:  $([ $HAS_SESSION -eq 0 ] && echo PASS || echo FAIL)"
echo ""

if [ "$TOKEN_PASS" = "PASS" ] && [ "$HAS_SESSION" -eq 0 ] && [ "$METRIC_COUNT" -ge 6 ]; then
    echo "  VERDICT: PASS"
else
    echo "  VERDICT: FAIL"
fi
echo "============================================================"
echo ""
echo "Cleanup:"
echo "  cd $SCRIPT_DIR && docker-compose down"
echo ""
