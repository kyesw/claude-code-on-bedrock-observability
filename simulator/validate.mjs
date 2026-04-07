/**
 * Validates metrics in Mimir by querying Prometheus-compatible API.
 * Compares what was emitted locally vs what Mimir ingested to detect
 * data loss or double-counting from the ALB fan-out problem.
 *
 * Usage:
 *   PHASE=cumulative EXPECTED_TOKENS=12345 node validate.mjs
 *   PHASE=delta       EXPECTED_TOKENS=12345 node validate.mjs
 */

const MIMIR_URL =
  process.env.MIMIR_URL || "http://localhost:9010/prometheus";
const PHASE = process.env.PHASE || "unknown";
const EXPECTED_TOKENS = parseFloat(process.env.EXPECTED_TOKENS || "0");
const EXPECTED_COST = parseFloat(process.env.EXPECTED_COST || "0");
const EXPECTED_SESSIONS = parseInt(process.env.EXPECTED_SESSIONS || "0", 10);

async function query(promql) {
  const url = `${MIMIR_URL}/api/v1/query?query=${encodeURIComponent(promql)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== "success") {
    throw new Error(`Query failed: ${JSON.stringify(json)}`);
  }
  return json.data.result;
}

async function queryRange(promql, start, end, step) {
  const url =
    `${MIMIR_URL}/api/v1/query_range?query=${encodeURIComponent(promql)}` +
    `&start=${start}&end=${end}&step=${step}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== "success") {
    throw new Error(`Query failed: ${JSON.stringify(json)}`);
  }
  return json.data.result;
}

function pct(actual, expected) {
  if (expected === 0) return "N/A";
  const diff = ((actual - expected) / expected) * 100;
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${diff.toFixed(1)}%`;
}

function verdict(actual, expected, tolerancePct = 5) {
  if (expected === 0) return "?";
  const diff = Math.abs((actual - expected) / expected) * 100;
  if (diff <= tolerancePct) return "PASS";
  return "FAIL";
}

async function main() {
  console.log("=".repeat(70));
  console.log(`Validation Report — ${PHASE.toUpperCase()} temporality`);
  console.log(`Querying: ${MIMIR_URL}`);
  console.log("=".repeat(70));

  // 1. Session count
  console.log("\n[1] claude_code_session_count");
  const sessions = await query("sum(claude_code_session_count)");
  const totalSessions =
    sessions.length > 0 ? parseFloat(sessions[0].value[1]) : 0;
  console.log(`    Mimir total:    ${totalSessions}`);
  if (EXPECTED_SESSIONS > 0) {
    console.log(`    Expected:       ${EXPECTED_SESSIONS}`);
    console.log(
      `    Deviation:      ${pct(totalSessions, EXPECTED_SESSIONS)}  [${verdict(totalSessions, EXPECTED_SESSIONS)}]`
    );
  }

  // 2. Total tokens
  console.log("\n[2] claude_code_token_usage (all types, all models)");
  const tokens = await query("sum(claude_code_token_usage)");
  const totalTokens =
    tokens.length > 0 ? parseFloat(tokens[0].value[1]) : 0;
  console.log(`    Mimir total:    ${totalTokens.toLocaleString()}`);
  if (EXPECTED_TOKENS > 0) {
    console.log(`    Expected:       ${EXPECTED_TOKENS.toLocaleString()}`);
    console.log(
      `    Deviation:      ${pct(totalTokens, EXPECTED_TOKENS)}  [${verdict(totalTokens, EXPECTED_TOKENS)}]`
    );
  }

  // 3. Token breakdown by type
  console.log("\n[3] Token breakdown by type");
  const byType = await query(
    "sum(claude_code_token_usage) by (type)"
  );
  for (const r of byType) {
    console.log(
      `    ${(r.metric.type || "?").padEnd(16)} ${parseFloat(r.value[1]).toLocaleString()}`
    );
  }

  // 4. Cost
  console.log("\n[4] claude_code_cost_usage");
  const cost = await query("sum(claude_code_cost_usage)");
  const totalCost =
    cost.length > 0 ? parseFloat(cost[0].value[1]) : 0;
  console.log(`    Mimir total:    $${totalCost.toFixed(4)}`);
  if (EXPECTED_COST > 0) {
    console.log(`    Expected:       $${EXPECTED_COST.toFixed(4)}`);
    console.log(
      `    Deviation:      ${pct(totalCost, EXPECTED_COST)}  [${verdict(totalCost, EXPECTED_COST)}]`
    );
  }

  // 5. Cardinality check — ensure no collector pipeline labels leaked
  console.log("\n[5] Label cardinality check");
  const sampleSeries = await query("claude_code_token_usage");
  if (sampleSeries.length > 0) {
    const labels = Object.keys(sampleSeries[0].metric).filter(
      (k) => k !== "__name__"
    );
    console.log(`    Labels on claude_code_token_usage: ${labels.join(", ")}`);
    const pipelineLabels = labels.filter(
      (l) =>
        l.includes("collector") ||
        l.includes("k8s") ||
        l.includes("pod") ||
        l.includes("node")
    );
    if (pipelineLabels.length > 0) {
      console.log(
        `    WARNING: pipeline labels found: ${pipelineLabels.join(", ")}`
      );
    } else {
      console.log("    No pipeline labels found  [CLEAN]");
    }
  }

  // 6. Rate analysis — look for negative rates (phantom resets)
  console.log("\n[6] Rate analysis (rate over 1m windows)");
  const end = Math.floor(Date.now() / 1000);
  const start = end - 300;
  const rates = await queryRange(
    "sum(rate(claude_code_token_usage[1m])) by (type)",
    start,
    end,
    "15"
  );
  let anyNegative = false;
  for (const series of rates) {
    const type = series.metric.type || "unknown";
    const values = series.values.map((v) => parseFloat(v[1]));
    const negatives = values.filter((v) => v < 0).length;
    const max = Math.max(...values);
    const avg =
      values.length > 0
        ? values.reduce((a, b) => a + b, 0) / values.length
        : 0;
    const status = negatives > 0 ? "!! NEGATIVE RATES" : "ok";
    console.log(
      `    ${type.padEnd(16)} avg=${avg.toFixed(1).padStart(8)} ` +
        `max=${max.toFixed(1).padStart(8)} negatives=${negatives}  [${status}]`
    );
    if (negatives > 0) anyNegative = true;
  }

  // 7. Summary verdict
  console.log("\n" + "=".repeat(70));
  const tokenPass =
    EXPECTED_TOKENS > 0
      ? verdict(totalTokens, EXPECTED_TOKENS) === "PASS"
      : null;
  const costPass =
    EXPECTED_COST > 0
      ? verdict(totalCost, EXPECTED_COST) === "PASS"
      : null;

  if (tokenPass === false || costPass === false || anyNegative) {
    console.log(
      `VERDICT: FAIL — ${PHASE} temporality produced incorrect metrics`
    );
    if (tokenPass === false) console.log("  - Token count mismatch");
    if (costPass === false) console.log("  - Cost mismatch");
    if (anyNegative) console.log("  - Negative rates (phantom counter resets)");
  } else if (tokenPass === true && costPass === true && !anyNegative) {
    console.log(
      `VERDICT: PASS — ${PHASE} temporality produced correct metrics`
    );
  } else {
    console.log(`VERDICT: INCONCLUSIVE — provide expected values for comparison`);
  }
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
