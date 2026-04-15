# Claude Code OTel Metrics → CloudWatch via AWS ALB

Collects OpenTelemetry metrics from Claude Code through an AWS ALB-fronted
pool of OTel Collectors into Amazon CloudWatch.

## Architecture

```
Claude Code (delta temporality)
  → OTLP/HTTP (port 4318)
    → AWS ALB (round-robin, no sticky sessions)
      → OTel Collector pods (memory_limiter → transform → batch)
        → CloudWatch (via Embedded Metric Format)
```

CloudWatch is push-based and natively additive. No series identity issues
arise from multiple collectors — each data point is independent.

**Delta temporality is required.** CloudWatch treats each data point as an
independent value. Cumulative counters would be summed as-is, inflating
the totals. Delta exports only the increment since the last export, which
CloudWatch's `Sum` statistic correctly totals.

The `transform` processor drops `session.id` to avoid high-cardinality
CloudWatch dimensions. Remove it if you need per-session granularity
(note: this significantly increases CloudWatch cost).

## Prerequisites

- EKS cluster with AWS Load Balancer Controller installed
- IRSA role with CloudWatch Logs write permissions
- ACM certificate for ALB TLS termination

## IAM Policy

The IRSA role needs this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams"
      ],
      "Resource": "arn:aws:logs:*:*:log-group:/metrics/claude-code:*"
    }
  ]
}
```

## Before applying

Edit these values:

| File | What to change |
|------|---------------|
| `rbac.yml` | `eks.amazonaws.com/role-arn` → your IRSA role ARN |
| `deployment.yml` | `AWS_REGION` env var → your region |
| `ingress.yml` | `certificate-arn` → your ACM cert ARN |
| `ingress.yml` | `spec.rules[0].host` → your OTLP ingestion hostname |

## Apply

```bash
kubectl apply -f namespace.yml
kubectl apply -f rbac.yml
kubectl apply -f configmap.yml
kubectl apply -f deployment.yml
kubectl apply -f service.yml
kubectl apply -f ingress.yml
kubectl apply -f pdb.yml
kubectl apply -f hpa.yml
```

Or all at once:

```bash
kubectl apply -f .
```

## Verify

After a Claude Code session completes, check CloudWatch:

```bash
# List metrics in the ClaudeCode namespace
aws cloudwatch list-metrics --namespace ClaudeCode

# Query token usage
aws cloudwatch get-metric-statistics \
  --namespace ClaudeCode \
  --metric-name claude_code.token.usage \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Sum \
  --dimensions Name=model,Value=claude-sonnet-4-6 Name=type,Value=input
```

## Dashboard

Deploy the CloudWatch dashboard:

```bash
AWS_REGION=us-east-1 bash ../deploy-dashboard.sh
```

This creates a `ClaudeCode` dashboard with token usage, sessions, cost
(Anthropic rates + estimated Bedrock rates), lines of code, commits/PRs,
and a pricing reference panel.

## Claude Code client configuration

In your `settings.json` (or equivalent IDE settings):

```jsonc
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://otel-ingest.example.com:4318",
    "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "delta"
  }
}
```

## CloudWatch vs Mimir

| Concern | CloudWatch | Mimir |
|---------|-----------|-------|
| Client temporality | **Delta** | **Cumulative** |
| Series identity | Not an issue — push-based, additive | Requires stateless collectors + no extra labels |
| Out-of-order samples | Accepts any timestamp within 14 days | Needs `out_of_order_time_window: 5m` |
| Query language | CloudWatch Metrics Insights | PromQL |
| Cardinality cost | Charges per dimension combination | Free (up to ingestion limits) |
| Recording rules | Metric Math (limited) | Full PromQL recording rules |
| Operations | Fully managed | Self-managed |
