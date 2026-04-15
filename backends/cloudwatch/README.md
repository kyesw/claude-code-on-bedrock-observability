# CloudWatch Backend

Collects OpenTelemetry metrics from Claude Code and exports them to Amazon CloudWatch via the Embedded Metric Format (EMF). This is the AWS-native option -- fully managed, no additional infrastructure to operate. For teams already running Grafana Mimir, see the [Mimir backend](../mimir/).

## Architecture

```
Claude Code (delta temporality)
  -> OTLP/HTTP (port 4318)
    -> AWS ALB (round-robin, no sticky sessions)
      -> OTel Collector pods (memory_limiter -> transform -> batch)
        -> CloudWatch (via Embedded Metric Format)
```

The collector receives OTLP metrics over HTTP, drops the high-cardinality `session.id` attribute, batches data points, and pushes them to CloudWatch Logs as EMF. CloudWatch automatically extracts metrics from these structured log entries.

## Prerequisites

- OTel Collector Contrib 0.149.0+
- AWS credentials with CloudWatch Logs write permissions
- For production: EKS cluster with AWS Load Balancer Controller, IRSA role, ACM certificate

## Why delta temporality

CloudWatch treats each data point independently and sums them. If the client exported cumulative counters, CloudWatch would double-count overlapping values, inflating totals by roughly 32%. Delta temporality exports only the increment since the last export, which CloudWatch adds correctly.

## Collector pipeline

The pipeline runs three processors in order: `memory_limiter -> transform -> batch`.

| Processor | Purpose |
|-----------|---------|
| `memory_limiter` | Back-pressure at 80% memory, 25% spike limit |
| `transform` | Drops `session.id` to avoid high-cardinality dimensions |
| `batch` | Groups up to 1000 data points or flushes every 5s |

**Cardinality note:** CloudWatch charges per unique dimension combination. `session.id` creates a new combination per invocation, which gets expensive fast. The `transform` processor removes it. Delete the transform processor from `collector.yml` if you need per-session granularity, but expect significantly higher CloudWatch costs.

## awsemf exporter

Key configuration details in `collector.yml`:

- **Namespace:** `ClaudeCode`
- **Log group:** `/metrics/claude-code`
- **Region:** Set via `${env:AWS_REGION}` environment variable substitution
- **Dimension rollup:** `NoDimensionRollup` -- only explicitly declared dimension sets are published
- **Metric names:** Use OTel names with dots (e.g., `claude_code.token.usage`), not underscores. The exporter matches against original OTel names.
- **Dimension names:** Also use dots as emitted by the SDK (e.g., `user.id`, `terminal.type`)

## Client configuration

Add to Claude Code `settings.json`:

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

## IAM requirements

For production, the IRSA role needs CloudWatch Logs write permissions:

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

## Dashboard

Native CloudWatch dashboard defined in `dashboard.json`, deployed via `deploy-dashboard.sh`.

**Panels included:**

- Total tokens, sessions, cost (Anthropic rates), estimated Bedrock cost
- Token usage by model, cache token usage
- Bedrock cost over time by model
- Per-user Bedrock cost (bar chart and time series)
- Sessions over time by user
- Lines of code, active time, commits and PRs, edit decisions
- Pricing reference panel

**Deploy:**

```bash
AWS_REGION=us-east-1 bash deploy-dashboard.sh
```

## Per-user cost tracking

The collector declares `[user.id]` as a dimension for `claude_code.cost.usage` and `claude_code.token.usage`. The dashboard breaks down cost per user using:

```
SEARCH('{ClaudeCode,user.id} MetricName="claude_code.cost.usage"')
```

## Bedrock cost accuracy

`claude_code.cost.usage` uses Anthropic API rates. For current models in US regions, Anthropic and Bedrock rates are identical. For non-US regions, multiply by 1.1 (10% surcharge). See `../../docs/bedrock-cost.md` for details.

## Local testing

Requires AWS credentials. The test environment starts 3 collectors behind nginx (simulating ALB round-robin), runs a metric simulator with delta temporality, waits for CloudWatch propagation, then validates results.

```bash
AWS_REGION=us-east-1 bash run-test.sh
```

The script resolves credentials from environment variables, instance role (IMDSv2), or `~/.aws`.

## Verify after deployment

List metrics in the namespace:

```bash
aws cloudwatch list-metrics --namespace ClaudeCode
```

Query a specific metric:

```bash
aws cloudwatch get-metric-statistics \
  --namespace ClaudeCode \
  --metric-name claude_code.token.usage \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Sum \
  --dimensions Name=model,Value=claude-sonnet-4-6 Name=type,Value=input
```

## File reference

| File | Purpose |
|------|---------|
| `collector.yml` | OTel Collector config (awsemf exporter to CloudWatch) |
| `dashboard.json` | Native CloudWatch dashboard (uses `${AWS_REGION}` placeholder) |
| `deploy-dashboard.sh` | Deploy dashboard via AWS CLI |
| `docker-compose.yml` | Test environment (needs AWS credentials) |
| `run-test.sh` | Validation test |
| `nginx/nginx.conf` | Round-robin ALB simulator |
| `k8s-manifests/` | Production Kubernetes deployment with IRSA |

## CloudWatch vs. Mimir

The [Mimir backend](../mimir/) is the alternative for teams already running Grafana Mimir. Key differences:

| Concern | CloudWatch | Mimir |
|---------|-----------|-------|
| Client temporality | **Delta** | **Cumulative** |
| Series identity | Not an issue -- push-based, additive | Requires stateless collectors + no extra labels |
| Out-of-order samples | Accepts any timestamp within 14 days | Needs `out_of_order_time_window: 5m` |
| Query language | CloudWatch Metrics Insights | PromQL |
| Cardinality cost | Charges per dimension combination | Free (up to ingestion limits) |
| Per-user cost | SEARCH by `user.id` dimension | PromQL `sum by (user_id)` |
| Recording rules | Metric Math (limited) | Full PromQL recording rules |
| Operations | Fully managed | Self-managed |

Choose CloudWatch if you want zero additional infrastructure and your team is already in the AWS console. Choose Mimir if you need PromQL, recording rules, or want to avoid per-dimension charges at scale.

## Related docs

- `../../docs/multi-collector.md` -- Why multiple collectors behind an ALB need specific architecture
- `../../docs/bedrock-cost.md` -- Bedrock cost accuracy and how to compute real cost from token counts
