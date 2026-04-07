# Claude Code OTel Metrics → Mimir 2.17 via AWS ALB

Collects OpenTelemetry metrics from Claude Code through an AWS ALB-fronted
pool of stateless OTel Collectors into Mimir 2.17.

## Architecture

```
Claude Code (cumulative temporality)
  → OTLP/HTTP (port 4318)
    → AWS ALB (round-robin, no sticky sessions)
      → OTel Collector pods (stateless passthrough)
        → Mimir 2.17 (OTLP endpoint, out_of_order_time_window: 5m)
```

Collectors are pure passthrough: `memory_limiter → batch`. No conversion
processors, no extra labels. All collectors write to the same Mimir series.

## Prerequisites

- EKS cluster with AWS Load Balancer Controller installed
- Mimir 2.17 with `out_of_order_time_window: 5m` in limits config
- ACM certificate for the ALB TLS termination

## Mimir requirement

Add this to your Mimir `limits` config if not already present:

```yaml
limits:
  out_of_order_time_window: 5m
```

This allows Mimir to accept samples that arrive slightly out of order
when multiple collectors forward cumulative values from the same series.

## Before applying

Edit these values:

| File | What to change |
|------|---------------|
| `configmap.yml` | `exporters.otlphttp.endpoint` → your Mimir distributor OTLP URL |
| `ingress.yml` | `alb.ingress.kubernetes.io/certificate-arn` → your ACM cert ARN |
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

## Claude Code client configuration

Set these environment variables for each Claude Code user:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-ingest.example.com:4318
export OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=cumulative
```

## Verify

After a Claude Code session completes, check Mimir:

```bash
# Session count
curl -s "http://MIMIR:9009/prometheus/api/v1/query?query=sum(claude_code_session_count)" | jq .

# Token usage by model
curl -s "http://MIMIR:9009/prometheus/api/v1/query?query=sum(claude_code_token_usage)%20by%20(model,type)" | jq .

# Cost
curl -s "http://MIMIR:9009/prometheus/api/v1/query?query=sum(claude_code_cost_usage)%20by%20(model)" | jq .
```

## Metrics reference

Claude Code emits these 8 counters:

| Metric | Labels | Description |
|--------|--------|-------------|
| `claude_code_session_count` | `session_id`, `user_id`, `terminal_type` | Sessions started |
| `claude_code_token_usage` | `type`, `model`, `session_id`, `user_id`, `terminal_type` | Tokens used |
| `claude_code_cost_usage` | `model`, `session_id`, `user_id`, `terminal_type` | Cost in USD |
| `claude_code_lines_of_code_count` | `type`, `session_id`, `user_id`, `terminal_type` | Lines added/removed |
| `claude_code_commit_count` | `session_id`, `user_id`, `terminal_type` | Git commits |
| `claude_code_pull_request_count` | `session_id`, `user_id`, `terminal_type` | PRs created |
| `claude_code_code_edit_tool_decision` | `tool_name`, `decision`, `language`, `session_id`, `user_id`, `terminal_type` | Edit accept/reject |
| `claude_code_active_time_total` | `type`, `session_id`, `user_id`, `terminal_type` | Active time (seconds) |

No pipeline labels (`collector_instance`, `k8s_*`, etc.) are added.
