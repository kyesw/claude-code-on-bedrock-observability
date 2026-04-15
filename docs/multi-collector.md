# Multi-Collector Ingestion — ALB + OTel Collectors

## The Problem

When collecting OpenTelemetry metrics from Claude Code through a load balancer
(ALB) fronting multiple OTel Collectors, cumulative counters can be silently
inflated or lost depending on how the collectors and backend are configured.

Two failure modes exist:

1. **Inflation (2-3x)** — Collectors add their own identity as a label
   (e.g., `collector_instance`). Each collector's partial cumulative series
   becomes a separate Mimir series. `sum()` at query time adds them all,
   producing 2-3x the actual values.

2. **Data loss (-40-100%)** — Delta temporality is used, but Mimir 2.17's
   OTLP endpoint rejects delta Sums. Or collectors independently convert
   delta-to-cumulative without a distinguishing label, causing interleaved
   writes that Mimir interprets as counter resets.

Both failures are **silent**. No errors in dashboards. No alerts. The data
looks plausible until compared against billing or ground truth.

## Root Cause

The problem is not inherent to having multiple collectors behind a load
balancer. It emerges from specific combinations of temporality, collector
processing, and label configuration.

The cumulative counter model works like this: each export carries the running
total since process start (`100, 250, 400, 500, ...`). When an ALB
distributes these exports across N collectors, each collector sees a subset
of the full sequence. What happens next depends entirely on what the
collectors do with the data:

**If collectors add per-collector labels** — the single source series splits
into N Mimir series. Summing them double-counts:

```
SDK cumulative:  100 → 250 → 400 → 500

Collector-1 forwards: {collector=C1} 100, 400
Collector-2 forwards: {collector=C2} 250, 500

sum() = 400 + 500 = 900    ← should be 500
```

**If collectors are pure passthrough (no extra labels)** — all writes go to
the same Mimir series. The monotonic sequence is preserved regardless of
which collector forwarded which point:

```
SDK cumulative:  100 → 250 → 400 → 500

Collector-1 forwards: 100, 400   → same series
Collector-2 forwards: 250, 500   → same series

Mimir sees: 100@T1, 250@T2, 400@T3, 500@T4 = correct
```

Mimir identifies a series by its **label set**. If all collectors forward
data with the same labels, Mimir sees one series. It has no concept of which
collector delivered which sample. The collectors are invisible — they're
just TCP connections delivering data points.

The problem only appears when a label **varies** across collectors
(`collector_instance=C1` vs `C2` vs `C3`). That single differing label
splits one series into three.

## The Fix

Use **cumulative temporality** with **stateless passthrough collectors** and
**no additional labels**. Enable `out_of_order_time_window` in Mimir to handle
timing jitter when multiple collectors write to the same series.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Claude Code                                             │
│                                                         │
│  OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE      │
│  = cumulative                                           │
└────────────────────────┬────────────────────────────────┘
                         │ OTLP/HTTP
                         ▼
               ┌───────────────────┐
               │   AWS ALB / nginx │
               │   (round-robin)   │
               │  No sticky needed │
               └────┬──────┬──────┬┘
                    │      │      │
         ┌──────────┘      │      └──────────┐
         ▼                 ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Collector-1  │  │ Collector-2  │  │ Collector-3  │
│              │  │              │  │              │
│ memory_limit │  │ memory_limit │  │ memory_limit │
│ batch        │  │ batch        │  │ batch        │
│              │  │              │  │              │
│ (stateless   │  │ (stateless   │  │ (stateless   │
│  passthrough)│  │  passthrough)│  │  passthrough)│
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                  │
       └────────────┬────┘──────────────────┘
                    ▼
          ┌───────────────────┐
          │   Mimir 2.17      │
          │   OTLP endpoint   │
          │                   │
          │ out_of_order_     │
          │ time_window: 5m   │
          └───────────────────┘
```

### Why this works

- Cumulative values from the SDK are monotonically increasing within a session
- Without per-collector labels, all collectors write to the same Mimir series
- The ALB is transparent — it doesn't matter which collector forwards which point
- Mimir reconstructs the full monotonic sequence from interleaved writes
- `out_of_order_time_window` handles cases where network latency causes a
  later-timestamped sample to arrive before an earlier one
- Collectors hold zero state — they batch and forward, nothing else
- Each Claude Code session has a unique `session_id` label, so counter resets
  between sessions don't interfere (they're different series)

### Why delta temporality doesn't work here

- Mimir 2.17's OTLP endpoint rejects delta Sums (HTTP 400)
- Adding `deltatocumulative` in each collector requires a per-collector label
  to prevent series collision — inflating cardinality
- Without that label, independently accumulated cumulative counters from
  different collectors interleave and Mimir misinterprets drops as counter
  resets, losing ~40-50% of data

### Will the collector add pod-specific labels to pass-through data?

No. The OTel Collector has two separate identities:

1. **Its own telemetry** — the collector reports its own health metrics with
   `service.instance.id=<uuid>`, pod name, etc. This is self-monitoring only.

2. **Data passing through it** — Claude Code's metrics flow through the
   pipeline untouched. The collector does not inject its own identity into
   pass-through data unless you **explicitly** add a processor that does so.

| Risk | Affects pass-through data? |
|------|---------------------------|
| `OTEL_RESOURCE_ATTRIBUTES` env var on the pod | No — collector's own telemetry only |
| Auto-generated `service.instance.id` (UUID per pod) | No — collector's own metrics only |
| K8s downward API env vars (`POD_NAME`, etc.) | No — unused unless a processor references them |
| `k8sattributes` processor | **Yes** — but not in this config |
| `resource` processor | **Yes** — but not in this config |

As long as the collector config only has `memory_limiter` and `batch`, the
data is a clean passthrough.

## Mimir Configuration — `out_of_order_time_window`

This is the **one required Mimir-side change**:

```yaml
limits:
  out_of_order_time_window: 5m
```

### What problem does this solve?

Mimir expects samples for a given series to arrive in timestamp order.
Normally with one writer this is guaranteed. But with multiple collectors
behind an ALB, network timing jitter can cause out-of-order delivery:

```
Claude Code SDK exports:
  T1 (cumulative=100) → ALB → collector-2
  T2 (cumulative=250) → ALB → collector-3
  T3 (cumulative=400) → ALB → collector-1

What actually arrives at Mimir's ingestion endpoint:

  collector-1 delivers 400@T3  ← arrives first (fast network path)
  collector-2 delivers 100@T1  ← arrives second (slight delay)
  collector-3 delivers 250@T2  ← arrives third
```

Without `out_of_order_time_window`, Mimir enforces strict ordering. After
accepting `400@T3`, it sees `100@T1` and rejects it:

```
err-mimir-sample-out-of-order: sample timestamp T1 is older than
the latest accepted timestamp T3 for series {session=X, type=input}
```

The sample is **dropped silently**. Data loss.

### What the setting does

`out_of_order_time_window: 5m` tells Mimir: "accept samples up to 5 minutes
older than the most recent sample for the same series." So after accepting
`400@T3`, it will still accept `100@T1` and `250@T2` as long as
`T3 - T1 < 5 minutes`.

Mimir stores the out-of-order samples, sorts them into the correct time
position internally, and the series is reconstructed correctly:
`100@T1, 250@T2, 400@T3`.

### How likely is out-of-order delivery?

With collectors in the same cluster as Mimir, timing jitter is typically
milliseconds — but it **does** happen because:

- Different collectors have different batch timer offsets (5s window, not
  synchronized across pods)
- Network latency varies between pods and nodes
- One collector pod might be under higher CPU load and flush later
- A collector pod restart causes queued samples to be delayed

### Trade-off

This setting has a cost: Mimir uses more memory to hold a buffer for
out-of-order ingestion. With a 5-minute window, it keeps the last 5 minutes
of samples per series in a write-ahead log before flushing to blocks. For
Claude Code metrics (low cardinality — sessions x metrics x models), this
overhead is negligible.

5 minutes is conservative for this use case. Even 1 minute would likely be
sufficient, but 5 minutes provides a comfortable margin for pod restarts
or network hiccups across availability zones.

## Validation Results

The included test environment simulates 6 concurrent Claude Code sessions
(all 8 metrics, realistic token counts, multiple models) through a
round-robin load balancer into 3 collectors and compares ground truth
against what Mimir ingested.

### Delta temporality — stateless collectors (broken)

| Metric | Ground Truth | Mimir | Deviation |
|--------|-------------|-------|-----------|
| Sessions | 6 | 0 | **-100%** |
| Tokens | 236,998 | 0 | **-100%** |
| Cost | $3.01 | $0.00 | **-100%** |

Complete data loss. Mimir rejects every delta Sum.

### Cumulative temporality — stateless collectors (correct)

| Metric | Ground Truth | Mimir | Deviation |
|--------|-------------|-------|-----------|
| Sessions | 6 | 6 | **+0.0%** |
| Tokens | 220,126 | 220,126 | **+0.0%** |
| Cost | $1.4934 | $1.4934 | **-0.0%** |

Exact match. Clean labels with no pipeline artifacts.

### Label cardinality check

```
Labels on claude_code_token_usage: job, model, session_id, terminal_type, type, user_id
No pipeline labels found  [CLEAN]
```

Only Claude Code's native labels. No `collector_instance`, no `k8s_*`.

## Running the Validation Test

```bash
cd backends/mimir
docker-compose up -d

cd ../../simulator
bash run-test.sh
```

The test tears down and rebuilds Mimir between phases to ensure clean state.

## Relevant Files

### Mimir backend (`backends/mimir/`)

| File | What to look at |
|------|----------------|
| `backends/mimir/collector.yml` | Stateless passthrough pipeline — `memory_limiter` + `batch`, nothing else |
| `backends/mimir/mimir.yml` | `out_of_order_time_window: 5m` under limits |
| `backends/mimir/nginx/nginx.conf` | Round-robin upstream simulating an ALB |
| `backends/mimir/k8s-manifests/` | Production K8s deployment (Deployment, Service, ALB Ingress, HPA, PDB) |
| `backends/mimir/docker-compose.yml` | Local test environment: nginx + 3 collectors + Mimir + Grafana |

### CloudWatch backend (`backends/cloudwatch/`)

| File | What to look at |
|------|----------------|
| `backends/cloudwatch/collector.yml` | Pipeline with `awsemf` exporter and `session_id` drop |
| `backends/cloudwatch/k8s-manifests/` | Production K8s deployment with IRSA |

### Shared

| File | What to look at |
|------|----------------|
| `simulator/simulator.mjs` | Emits all 8 Claude Code metrics with realistic values |
| `simulator/validate.mjs` | Queries Mimir and compares against ground truth |
| `simulator/run-test.sh` | Orchestrates the validation test |
