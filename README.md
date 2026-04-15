# Claude Code OTel Metrics — Collector Deployment & Cost Monitoring

Deployment guidance and production manifests for collecting OpenTelemetry
metrics from Claude Code through load-balanced OTel Collectors.

Two backend options are provided:

| Backend | Path | Best for |
|---------|------|----------|
| **[Mimir](backends/mimir/)** | `backends/mimir/` | Teams already running Grafana Mimir — full PromQL, recording rules, Grafana dashboards |
| **[CloudWatch](backends/cloudwatch/)** | `backends/cloudwatch/` | AWS-native teams — fully managed, no infrastructure to operate, native IAM auth |

Both use stateless passthrough collectors behind an ALB. The key difference
is the **temporality setting** on the Claude Code client.

## Documentation

| Document | What it covers |
|----------|---------------|
| [Multi-Collector Ingestion](docs/multi-collector.md) | Why multiple collectors behind an ALB can inflate or lose data, and the architecture that prevents it |
| [Bedrock Cost Accuracy](docs/bedrock-cost.md) | Why `claude_code_cost_usage` doesn't match your AWS bill, and how to compute accurate cost from token counts |

## Prerequisites

- AWS ALB (or any round-robin load balancer)
- OTel Collector Contrib 0.149.0+
- **Mimir backend:** Mimir 2.17+ with `out_of_order_time_window: 5m`
- **CloudWatch backend:** IRSA role with CloudWatch Logs write permissions

## Claude Code Client Configuration

The two backends require **different temporality settings**:

**Mimir** — use `cumulative` (Mimir understands cumulative counters and extracts
deltas at query time with `rate()`/`increase()`):

```jsonc
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://otel-ingest.example.com:4318",
    "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "cumulative"
  }
}
```

**CloudWatch** — use `delta` (CloudWatch treats each data point independently
and sums them; cumulative values would be double-counted):

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

See [Multi-Collector Ingestion](docs/multi-collector.md) for the detailed
analysis behind these temporality requirements.

## Metrics Emitted by Claude Code

| Metric | Type | Attributes | Description |
|--------|------|------------|-------------|
| `claude_code.session.count` | Counter | `session.id`, `user.id`, `terminal.type` | Sessions started |
| `claude_code.token.usage` | Counter | `type` (input/output/cacheRead/cacheCreation), `model` | Tokens consumed |
| `claude_code.cost.usage` | Counter | `model` | Cost in USD (Anthropic API rates) |
| `claude_code.lines_of_code.count` | Counter | `type` (added/removed) | Lines modified |
| `claude_code.commit.count` | Counter | | Git commits created |
| `claude_code.pull_request.count` | Counter | | PRs created |
| `claude_code.code_edit_tool.decision` | Counter | `tool_name`, `decision`, `language` | Edit tool accept/reject |
| `claude_code.active_time.total` | Counter | `type` (cli/user) | Active time (seconds) |

All metrics also carry `session.id`, `user.id`, and `terminal.type` as common attributes.
Mimir converts dots to underscores (e.g., `claude_code_token_usage`, `user_id`).

## Test Environments

Both backends include a Docker Compose test environment with nginx simulating
an ALB round-robin across 3 collectors.

### Mimir (local only — no cloud credentials needed)

```bash
cd backends/mimir
docker-compose up -d

cd ../../simulator
bash run-test.sh
```

| Service | URL |
|---------|-----|
| OTLP ingestion (through nginx) | `http://localhost:4318` |
| Mimir | `http://localhost:9010` |
| Grafana | `http://localhost:3001` (admin/admin) |

### CloudWatch (requires AWS credentials)

```bash
cd backends/cloudwatch
AWS_REGION=us-east-1 bash run-test.sh
```

The script resolves credentials from env vars, instance role (IMDSv2), or
`~/.aws`. It starts 3 collectors, runs the simulator with delta temporality,
waits for CloudWatch propagation, then validates token counts, sessions,
cost, and dimension cardinality against ground truth.

## Repository Structure

```
├── docs/
│   ├── multi-collector.md              # ALB + multi-collector architecture
│   └── bedrock-cost.md                 # Bedrock cost accuracy
│
├── backends/
│   ├── mimir/
│   │   ├── collector.yml               # OTel Collector config (otlphttp → Mimir)
│   │   ├── mimir.yml                   # Mimir config (out_of_order_time_window)
│   │   ├── bedrock-pricing-rules.yml   # Recording rules for Bedrock cost
│   │   ├── docker-compose.yml          # Local test environment
│   │   ├── nginx/
│   │   │   └── nginx.conf              # Round-robin ALB simulator
│   │   ├── grafana/                    # Mimir datasource + dashboards
│   │   └── k8s-manifests/              # Production K8s deployment
│   │
│   └── cloudwatch/
│       ├── collector.yml               # OTel Collector config (awsemf → CloudWatch)
│       ├── dashboard.json              # Native CloudWatch dashboard
│       ├── deploy-dashboard.sh         # Deploy dashboard via AWS CLI
│       ├── docker-compose.yml          # Test environment (needs AWS credentials)
│       ├── run-test.sh                 # Validation test
│       ├── nginx/
│       │   └── nginx.conf              # Round-robin ALB simulator
│       └── k8s-manifests/              # Production K8s deployment (with IRSA)
│
└── simulator/                          # Shared test simulator
    ├── simulator.mjs
    ├── validate.mjs
    ├── run-test.sh
    └── package.json
```
