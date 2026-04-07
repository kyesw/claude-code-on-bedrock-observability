# Bedrock Cost Accuracy — Why `claude_code_cost_usage` Doesn't Match Your AWS Bill

## The Problem

Claude Code emits a `claude_code_cost_usage` counter that tracks spend in USD.
If you're using Claude through **Amazon Bedrock**, this metric will
**understate your actual AWS bill** by 10-40% depending on model and region.

The discrepancy is silent — the metric looks correct and there are no errors.
You only notice when comparing OTel dashboards against AWS Cost and Usage
Reports (CUR).

## Root Cause

`claude_code_cost_usage` is computed using **Anthropic direct API pricing**.
Amazon Bedrock has its own pricing schedule:

| Source | Pricing basis |
|--------|--------------|
| `claude_code_cost_usage` | Anthropic API rates (e.g., Sonnet input: $3/1M tokens) |
| AWS bill (CUR) | Bedrock on-demand rates (same or higher, varies by region) |

Two factors cause divergence:

1. **Different base rates** — Some model versions have different per-token
   pricing on Bedrock vs the Anthropic API.

2. **Regional pricing** — Bedrock endpoints in non-US regions (e.g.,
   `eu-west-1`, `ap-northeast-1`) carry a ~10% surcharge over US pricing.

The **token counts are accurate** regardless of provider. Claude Code's
`claude_code_token_usage` metric reports the same tokens whether you're on
Anthropic's API or Bedrock. Only the dollar-per-token rate differs.

## The Fix

Compute cost from **token counts x Bedrock rates** instead of using
`claude_code_cost_usage` directly. Two approaches are provided:

1. **Grafana dashboard** — computes cost at query time using PromQL with
   Bedrock rate constants
2. **Mimir recording rules** — pre-computes cost as new metrics for
   alerting and long-term aggregation

## Bedrock Pricing Reference

Bedrock on-demand pricing per 1M tokens (US regions):

| Model | Input | Output | Cache Read | Cache Write |
|-------|------:|-------:|-----------:|------------:|
| claude-opus-4-6 | $5 | $25 | $0.50 | $6.25 |
| claude-opus-4 | $15 | $75 | $1.50 | $18.75 |
| claude-sonnet-4-6 | $3 | $15 | $0.30 | $3.75 |
| claude-sonnet-4 | $3 | $15 | $0.30 | $3.75 |
| claude-haiku-4-5-20251001 | $1 | $5 | $0.10 | $1.25 |

Cache pricing follows the standard formula:
- **Cache read** = 0.1x input price
- **Cache write (creation)** = 1.25x input price

For non-US Bedrock regions, multiply all rates by **1.1** (10% surcharge).

## Grafana Dashboard

The included dashboard (`claude-code-bedrock-cost.json`) computes Bedrock
cost entirely from `claude_code_token_usage` and hardcoded rate constants.

### Dashboard variables

| Variable | Purpose |
|----------|---------|
| `user_id` | Filter by user (multi-select, default: All) |
| `model` | Filter by model (multi-select, default: All) |
| `bedrock_region_multiplier` | `1` for US regions, `1.1` for non-US (+10%) |

### Panels

| Panel | Description |
|-------|-------------|
| Estimated Bedrock Cost (Total) | Single stat — total cost for selected range |
| Total Sessions | Session count |
| Total Tokens | Token count |
| Claude Code Cost vs Bedrock Estimate | Side-by-side comparison showing the gap |
| Bedrock Cost Over Time by Model | Time series — cost rate by model |
| Token Usage by Type | Time series — input, output, cacheRead, cacheCreation |
| Bedrock Cost by User | Table — per-user cost breakdown |
| Cost by Model | Pie chart — proportional spend by model |
| Pricing Reference | Text panel — inline pricing table |

### How the cost query works

Each panel computes cost using this pattern:

```promql
(
  sum(increase(claude_code_token_usage{model="claude-opus-4-6", type="input"}[$__range]))
    / 1e6 * 5          # $5 per 1M input tokens
  +
  sum(increase(claude_code_token_usage{model="claude-opus-4-6", type="output"}[$__range]))
    / 1e6 * 25         # $25 per 1M output tokens
  +
  sum(increase(claude_code_token_usage{model="claude-opus-4-6", type="cacheRead"}[$__range]))
    / 1e6 * 0.5        # $0.50 per 1M cache read tokens
  +
  sum(increase(claude_code_token_usage{model="claude-opus-4-6", type="cacheCreation"}[$__range]))
    / 1e6 * 6.25       # $6.25 per 1M cache write tokens
  + ... # repeated for each model
) * $bedrock_region_multiplier
```

`increase()` over `claude_code_token_usage` gives raw token counts, which are
provider-agnostic. Multiplying by Bedrock rates produces an accurate estimate.

## Recording Rules (Optional)

For alerting or long-term aggregation, pre-computing cost as recording rules
is more efficient than repeating the PromQL in every dashboard panel.

### What are recording rules?

Recording rules are PromQL expressions that Mimir evaluates on a schedule
(e.g., every 1 minute) and stores the result as a new metric. They:

- Run inside Mimir's ruler component, not in Grafana
- Produce new time series (e.g., `claude_code:bedrock_cost_rate:total`)
- Can be queried like any other metric
- Reduce query-time computation for expensive or frequently-used expressions

### Provided rules

`bedrock-pricing-rules.yml` defines four aggregation levels:

| Recording rule metric | Aggregation |
|----------------------|-------------|
| `claude_code:bedrock_cost_rate:by_model_type` | Per-model, per-token-type cost rate ($/sec) |
| `claude_code:bedrock_cost_rate:by_model` | Cost rate by model |
| `claude_code:bedrock_cost_rate:by_user` | Cost rate by user |
| `claude_code:bedrock_cost_rate:total` | Total cost rate |

These use `rate(...[5m])` so the values represent cost per second. To get
total cost over a time range in Grafana:

```promql
sum(claude_code:bedrock_cost_rate:total) * $__range_s
```

### Installing the rules

Load the rules into Mimir's ruler via the API:

```bash
curl -X POST http://mimir:9009/prometheus/config/v1/rules/claude-code \
  -H "Content-Type: application/yaml" \
  --data-binary @mimir/bedrock-pricing-rules.yml
```

Or mount as a ConfigMap in Kubernetes and point Mimir's
`-ruler.rule-path` to it.

## Updating Prices

When Bedrock pricing changes, update:

1. **Grafana dashboard** — rate constants in each panel's PromQL
   (`claude-code-bedrock-cost.json`)
2. **Recording rules** — multipliers in `bedrock-pricing-rules.yml`
3. **This document** — pricing reference table above

The rate constants are hardcoded intentionally — they change infrequently
and embedding them in queries avoids adding a pricing lookup service.

## Relevant Files

| File | What to look at |
|------|----------------|
| `grafana/provisioning/dashboards/json/claude-code-bedrock-cost.json` | Grafana dashboard — cost queries, variables, panel layout |
| `mimir/bedrock-pricing-rules.yml` | Recording rules for pre-computed cost metrics |
| `mimir/mimir.yml` | Mimir config — ruler component for recording rules |
| `docs/multi-collector.md` | Companion doc — ensuring accurate token counts through multi-collector ingestion |
