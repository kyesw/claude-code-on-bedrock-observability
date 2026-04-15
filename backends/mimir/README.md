# Mimir Backend for Claude Code Metrics

Collects OpenTelemetry metrics from Claude Code through load-balanced OTel Collectors into Grafana Mimir. This backend is for teams already running Grafana Mimir (or willing to adopt it) that want PromQL-based dashboards and alerting.

For AWS-native teams that prefer a managed service, see the [CloudWatch backend](../cloudwatch/).

## Architecture

```
Claude Code (cumulative temporality)
  -> OTLP/HTTP (port 4318)
    -> AWS ALB (round-robin, no sticky sessions)
      -> OTel Collector pods (memory_limiter -> batch)
        -> Mimir 2.17 (OTLP endpoint, out_of_order_time_window: 5m)
```

Key design decisions:

- **Cumulative temporality** -- Mimir understands cumulative counters and extracts deltas at query time with `rate()` / `increase()`. Do NOT use delta temporality. Mimir 2.17 rejects delta Sums, resulting in 100% data loss.
- **Stateless collector pipeline** -- `memory_limiter -> batch` only. No transform processor, no label manipulation. All collectors write to the same Mimir series.
- **`session_id` is kept** -- Mimir handles high cardinality natively, so no dimensions need to be dropped (unlike the CloudWatch backend which drops `session_id` to control costs).
- **Out-of-order ingestion** -- `out_of_order_time_window: 5m` in Mimir's limits config allows it to accept samples that arrive slightly out of order when multiple collectors forward cumulative values. See [multi-collector docs](../../docs/multi-collector.md) for details.

## Prerequisites

| Component | Version | Notes |
|---|---|---|
| OTel Collector Contrib | 0.149.0+ | Must include `otlphttpexporter` |
| Grafana Mimir | 2.17+ | Requires `out_of_order_time_window: 5m` in limits config |
| Docker / Docker Compose | -- | For local testing |
| EKS + AWS LB Controller | -- | For production; ACM certificate required for TLS |

## Client Configuration

Add to your Claude Code `settings.json`:

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

`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` **must** be `cumulative`. If omitted or set to `delta`, Mimir 2.17 will reject all Sum metrics.

## Local Testing

Start the local environment (nginx ALB simulator + 3 OTel Collectors + Mimir + Grafana):

```bash
cd backends/mimir
docker-compose up -d
```

Then send test metrics with the simulator:

```bash
cd ../../simulator
bash run-test.sh
```

| Service | URL | Credentials |
|---|---|---|
| OTLP ingestion | http://localhost:4318 | -- |
| Mimir | http://localhost:9010 | -- |
| Grafana | http://localhost:3001 | admin / admin |

## Dashboards

Grafana dashboards use PromQL and are auto-provisioned in the local test environment.

| Dashboard | Path | Description |
|---|---|---|
| Bedrock Cost | `grafana/provisioning/dashboards/json/claude-code-bedrock-cost.json` | Computes cost from token counts x Bedrock rates, per-user cost breakdown |

See [Bedrock cost docs](../../docs/bedrock-cost.md) for how cost is derived from token counts.

## Bedrock Cost Recording Rules

`bedrock-pricing-rules.yml` defines Prometheus recording rules that pre-compute cost metrics from token counts and Bedrock pricing rates. Use these for alerting thresholds and long-term cost aggregation without repeated query-time computation.

## File Reference

| File | Purpose |
|---|---|
| `collector.yml` | OTel Collector config (OTLP receiver -> memory_limiter -> batch -> otlphttp to Mimir) |
| `mimir.yml` | Mimir config with `out_of_order_time_window: 5m` |
| `bedrock-pricing-rules.yml` | Recording rules for Bedrock cost metrics |
| `docker-compose.yml` | Local test environment (nginx + 3 collectors + Mimir + Grafana) |
| `nginx/nginx.conf` | Round-robin load balancer simulating an ALB |
| `grafana/` | Datasource and dashboard provisioning for Grafana |
| `k8s-manifests/` | Production Kubernetes deployment (namespace, deployment, HPA, PDB, ingress, RBAC) |

## Production Deployment

Kubernetes manifests are in `k8s-manifests/`. See [`k8s-manifests/README.md`](k8s-manifests/README.md) for deployment instructions.

The production topology mirrors the local test environment: an AWS ALB distributes traffic across multiple stateless OTel Collector pods, all writing to Mimir's OTLP endpoint. The ALB uses round-robin with no sticky sessions.

## Comparison with CloudWatch Backend

An alternative backend at [`../cloudwatch/`](../cloudwatch/) targets AWS-native teams that do not want to operate Mimir.

| | Mimir (this backend) | CloudWatch |
|---|---|---|
| Temporality | Cumulative | Delta |
| `session_id` dimension | Kept | Dropped (cost control) |
| Dashboards | Grafana + PromQL | CloudWatch native dashboards |
| Infrastructure | Self-managed Mimir (or Grafana Cloud) | Fully managed AWS service |
| Cost model | Mimir storage/compute | Per-metric + per-dimension-combination |

## Related Documentation

- [`../../docs/multi-collector.md`](../../docs/multi-collector.md) -- Why multiple collectors behind an ALB require cumulative temporality and out-of-order ingestion
- [`../../docs/bedrock-cost.md`](../../docs/bedrock-cost.md) -- Bedrock cost accuracy and how real cost is computed from token counts
