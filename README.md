# Claude Code OTel Metrics — Collector Deployment & Cost Monitoring

Deployment guidance and production manifests for collecting OpenTelemetry
metrics from Claude Code through load-balanced OTel Collectors into Mimir.

This repo addresses two issues:

1. **[Multi-Collector Ingestion](docs/multi-collector.md)** — How to correctly
   ingest cumulative counters when multiple OTel Collectors sit behind an ALB,
   and the architecture that prevents silent data inflation or loss.

2. **[Bedrock Cost Accuracy](docs/bedrock-cost.md)** — Why `claude_code_cost_usage`
   doesn't match your AWS bill when using Amazon Bedrock, and how to compute
   accurate cost from token counts.

## Prerequisites

- Mimir 2.17+
- AWS ALB (or any round-robin load balancer)
- OTel Collector Contrib 0.149.0+

## Claude Code Client Configuration

In your `settings.json` (or equivalent IDE settings):

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

`cumulative` temporality is required. See [Multi-Collector Ingestion](docs/multi-collector.md)
for why delta temporality causes data loss with Mimir 2.17.

## Metrics Emitted by Claude Code

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `claude_code_session_count` | Counter | `session_id`, `user_id`, `terminal_type` | Sessions started |
| `claude_code_token_usage` | Counter | `type` (input/output/cacheRead/cacheCreation), `model` | Tokens consumed |
| `claude_code_cost_usage` | Counter | `model` | Cost in USD (Anthropic API rates) |
| `claude_code_lines_of_code_count` | Counter | `type` (added/removed) | Lines modified |
| `claude_code_commit_count` | Counter | | Git commits created |
| `claude_code_pull_request_count` | Counter | | PRs created |
| `claude_code_code_edit_tool_decision` | Counter | `tool_name`, `decision`, `language` | Edit tool accept/reject |
| `claude_code_active_time_total` | Counter | `type` (cli/user) | Active time (seconds) |

All metrics also carry `session_id`, `user_id`, and `terminal_type` as common
labels. The `job` label is set to `claude-code` by the OTLP-to-Prometheus
conversion.

## Production Deployment

Kubernetes manifests are in `k8s-manifests/`. See the
[deployment guide](k8s-manifests/README.md) for setup instructions.

## Local Test Environment

A Docker Compose environment is included to validate the architecture locally
before deploying to production.

```bash
# Start nginx + 3 collectors + Mimir + Grafana
docker-compose up -d

# Run the validation test (~5 minutes)
cd simulator
bash run-test.sh
```

| Service | URL |
|---------|-----|
| OTLP ingestion (through nginx) | `http://localhost:4318` |
| Mimir | `http://localhost:9010` |
| Grafana | `http://localhost:3001` (admin/admin) |

The test simulates 6 concurrent Claude Code sessions emitting all 8 metrics
through a round-robin load balancer into 3 collectors and validates that
Mimir ingests the data with zero deviation from ground truth.

## Repository Structure

```
├── docs/
│   ├── multi-collector.md          # ALB + multi-collector architecture
│   └── bedrock-cost.md             # Bedrock cost accuracy
│
├── k8s-manifests/                  # Production Kubernetes manifests
│   ├── README.md                   # Deployment guide
│   ├── namespace.yml
│   ├── rbac.yml
│   ├── configmap.yml
│   ├── deployment.yml
│   ├── service.yml
│   ├── ingress.yml
│   ├── pdb.yml
│   └── hpa.yml
│
├── docker-compose.yml              # Local test environment
├── nginx/
│   └── nginx.conf                  # Round-robin ALB simulator
├── otel/
│   └── collector.yml               # Stateless passthrough collector config
├── mimir/
│   ├── mimir.yml                   # Mimir config (out_of_order_time_window)
│   └── bedrock-pricing-rules.yml   # Optional recording rules for Bedrock cost
│
├── grafana/
│   └── provisioning/
│       ├── datasources/
│       │   └── mimir.yml
│       └── dashboards/
│           └── json/
│               └── claude-code-bedrock-cost.json
│
└── simulator/                      # Test simulator
    ├── simulator.mjs               # Emits all 8 Claude Code metrics
    ├── validate.mjs                # Queries Mimir, compares vs ground truth
    ├── run-test.sh                 # Orchestrates the validation test
    └── package.json
```
