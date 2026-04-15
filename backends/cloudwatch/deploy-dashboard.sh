#!/usr/bin/env bash
set -euo pipefail

# Creates a CloudWatch dashboard from dashboard.json.
# Replaces ${AWS_REGION} in the template with the target region.
#
# Usage:
#   AWS_REGION=us-east-1 bash deploy-dashboard.sh
#   AWS_REGION=ap-northeast-2 bash deploy-dashboard.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGION="${AWS_REGION:-us-east-1}"
DASHBOARD_NAME="${DASHBOARD_NAME:-ClaudeCode}"

echo "Deploying CloudWatch dashboard '$DASHBOARD_NAME' to $REGION..."

# Replace region placeholder in the template
BODY=$(sed "s/\${AWS_REGION}/$REGION/g" "$SCRIPT_DIR/dashboard.json")

aws cloudwatch put-dashboard \
    --dashboard-name "$DASHBOARD_NAME" \
    --dashboard-body "$BODY" \
    --region "$REGION"

echo "Done. View at:"
echo "  https://$REGION.console.aws.amazon.com/cloudwatch/home?region=$REGION#dashboards/dashboard/$DASHBOARD_NAME"
