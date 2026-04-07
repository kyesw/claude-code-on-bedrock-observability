/**
 * Claude Code OTel Metrics Simulator
 *
 * Simulates realistic Claude Code sessions emitting the exact same metrics
 * that the real CLI produces. Each "session" is a short-lived meter that
 * mimics a user running `claude` for a coding task, then shutting down.
 *
 * Usage:
 *   TEMPORALITY=cumulative node simulator.mjs   # broken with ALB round-robin
 *   TEMPORALITY=delta       node simulator.mjs   # correct with ALB round-robin
 *
 * The simulator runs multiple overlapping sessions to stress the ALB fan-out.
 */

import { randomUUID } from "node:crypto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OTLP_ENDPOINT =
  process.env.SIMULATOR_OTLP_ENDPOINT || "http://localhost:4318";
const TEMPORALITY = process.env.TEMPORALITY || "delta";
const NUM_SESSIONS = parseInt(process.env.NUM_SESSIONS || "6", 10);
const EXPORT_INTERVAL_MS = parseInt(
  process.env.EXPORT_INTERVAL_MS || "5000",
  10
);

// Models Claude Code can use, weighted toward sonnet for realism
const MODELS = [
  { id: "claude-sonnet-4-6", weight: 0.6 },
  { id: "claude-opus-4-6", weight: 0.25 },
  { id: "claude-haiku-4-5-20251001", weight: 0.15 },
];

const TERMINALS = ["vscode", "cursor", "iTerm.app", "Terminal.app", "wezterm"];
const LANGUAGES = ["typescript", "python", "go", "rust", "java"];
const TOOL_NAMES = ["Edit", "Write", "NotebookEdit"];

function pickModel() {
  const r = Math.random();
  let cumulative = 0;
  for (const m of MODELS) {
    cumulative += m.weight;
    if (r < cumulative) return m.id;
  }
  return MODELS[0].id;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Realistic token counts per API call
function generateTokenCounts(model) {
  const isOpus = model.includes("opus");
  const isHaiku = model.includes("haiku");
  return {
    input: isOpus
      ? 2000 + Math.floor(Math.random() * 8000)
      : isHaiku
        ? 500 + Math.floor(Math.random() * 2000)
        : 1000 + Math.floor(Math.random() * 5000),
    output: isOpus
      ? 500 + Math.floor(Math.random() * 3000)
      : isHaiku
        ? 100 + Math.floor(Math.random() * 500)
        : 200 + Math.floor(Math.random() * 1500),
    cacheRead: Math.random() > 0.3 ? Math.floor(Math.random() * 4000) : 0,
    cacheCreation: Math.random() > 0.7 ? Math.floor(Math.random() * 2000) : 0,
  };
}

// Cost per 1M tokens (approximate)
const COST_TABLE = {
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
};

function estimateCost(model, tokens) {
  const rates = COST_TABLE[model] || COST_TABLE["claude-sonnet-4-6"];
  return (
    (tokens.input * rates.input) / 1_000_000 +
    (tokens.output * rates.output) / 1_000_000 +
    (tokens.cacheRead * rates.input * 0.1) / 1_000_000 +
    (tokens.cacheCreation * rates.input * 1.25) / 1_000_000
  );
}

// ---------------------------------------------------------------------------
// Session Simulator
// ---------------------------------------------------------------------------

/**
 * Simulates a single Claude Code session. Each session:
 * 1. Creates its own MeterProvider (just like a real CLI process)
 * 2. Registers counters matching Claude Code's real metric names
 * 3. Simulates N "turns" (user prompt → tool use → API calls)
 * 4. Shuts down after the session completes
 */
// Global accumulators for ground-truth comparison
const totals = { tokens: 0, cost: 0, sessions: 0 };

async function runSession(sessionIndex) {
  const sessionId = randomUUID();
  const userId = `user-${(sessionIndex % 3) + 1}`; // 3 simulated users
  const terminal = pickRandom(TERMINALS);
  const startTime = Date.now();
  totals.sessions++;

  const temporality =
    TEMPORALITY === "cumulative"
      ? AggregationTemporality.CUMULATIVE
      : AggregationTemporality.DELTA;

  console.log(
    `[session ${sessionIndex}] id=${sessionId.slice(0, 8)} user=${userId} ` +
      `terminal=${terminal} temporality=${TEMPORALITY}`
  );

  // Each CLI invocation gets its own MeterProvider — this is how Claude Code works
  const exporter = new OTLPMetricExporter({
    url: `${OTLP_ENDPOINT}/v1/metrics`,
    temporalityPreference: temporality,
  });

  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: EXPORT_INTERVAL_MS,
    exportTimeoutMillis: Math.min(5000, EXPORT_INTERVAL_MS),
  });

  const resource = new Resource({
    "service.name": "claude-code",
    "service.version": "2.1.92",
    "os.type": "linux",
    "os.version": "6.1.0",
    "host.arch": "amd64",
  });

  const meterProvider = new MeterProvider({
    resource,
    readers: [reader],
  });

  const meter = meterProvider.getMeter("com.anthropic.claude_code", "2.1.92");

  // --- Create counters matching Claude Code's exact metric names ---

  const sessionCounter = meter.createCounter("claude_code.session.count", {
    description: "Sessions started",
    unit: "count",
  });

  const tokenCounter = meter.createCounter("claude_code.token.usage", {
    description: "Tokens used",
    unit: "tokens",
  });

  const costCounter = meter.createCounter("claude_code.cost.usage", {
    description: "Session cost",
    unit: "USD",
  });

  const locCounter = meter.createCounter("claude_code.lines_of_code.count", {
    description: "Lines of code modified",
    unit: "count",
  });

  const commitCounter = meter.createCounter("claude_code.commit.count", {
    description: "Git commits created",
    unit: "count",
  });

  const prCounter = meter.createCounter("claude_code.pull_request.count", {
    description: "PRs created",
    unit: "count",
  });

  const editDecisionCounter = meter.createCounter(
    "claude_code.code_edit_tool.decision",
    {
      description: "Edit/Write tool accept/reject decisions",
      unit: "count",
    }
  );

  const activeTimeCounter = meter.createCounter(
    "claude_code.active_time.total",
    {
      description: "Active time in session",
      unit: "seconds",
    }
  );

  // Common attributes for this session (attached to every data point)
  const sessionAttrs = {
    "session.id": sessionId,
    "user.id": userId,
    "terminal.type": terminal,
  };

  // --- Session start ---
  sessionCounter.add(1, sessionAttrs);

  // Simulate 3-8 "turns" (user prompts) in this session
  const numTurns = 3 + Math.floor(Math.random() * 6);
  const turnDurationMs = EXPORT_INTERVAL_MS * 1.2; // slightly longer than export interval

  for (let turn = 0; turn < numTurns; turn++) {
    const model = pickModel();
    const tokens = generateTokenCounts(model);
    const cost = estimateCost(model, tokens);

    // Track ground truth
    totals.tokens += tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
    totals.cost += cost;

    // Token usage — each type is a separate add, matching real Claude Code
    tokenCounter.add(tokens.input, {
      ...sessionAttrs,
      type: "input",
      model,
    });
    tokenCounter.add(tokens.output, {
      ...sessionAttrs,
      type: "output",
      model,
    });
    if (tokens.cacheRead > 0) {
      tokenCounter.add(tokens.cacheRead, {
        ...sessionAttrs,
        type: "cacheRead",
        model,
      });
    }
    if (tokens.cacheCreation > 0) {
      tokenCounter.add(tokens.cacheCreation, {
        ...sessionAttrs,
        type: "cacheCreation",
        model,
      });
    }

    // Cost
    costCounter.add(cost, { ...sessionAttrs, model });

    // Lines of code — some turns produce edits
    if (Math.random() > 0.3) {
      const linesAdded = Math.floor(Math.random() * 50);
      const linesRemoved = Math.floor(Math.random() * 20);
      locCounter.add(linesAdded, { ...sessionAttrs, type: "added" });
      locCounter.add(linesRemoved, { ...sessionAttrs, type: "removed" });

      // Edit tool decisions
      const toolName = pickRandom(TOOL_NAMES);
      const lang = pickRandom(LANGUAGES);
      editDecisionCounter.add(1, {
        ...sessionAttrs,
        tool_name: toolName,
        decision: Math.random() > 0.1 ? "accepted" : "rejected",
        source: "tool_use",
        language: lang,
      });
    }

    // Active time — 10-60 seconds per turn
    const activeSeconds = 10 + Math.floor(Math.random() * 50);
    activeTimeCounter.add(activeSeconds, { ...sessionAttrs, type: "cli" });
    // Small amount of user think time counted
    activeTimeCounter.add(Math.floor(activeSeconds * 0.3), {
      ...sessionAttrs,
      type: "user",
    });

    console.log(
      `  [session ${sessionIndex}] turn ${turn + 1}/${numTurns}: ` +
        `model=${model} in=${tokens.input} out=${tokens.output} cost=$${cost.toFixed(4)}`
    );

    // Wait for the next turn — this ensures multiple exports happen per session
    await sleep(turnDurationMs);
  }

  // Some sessions create commits / PRs
  if (Math.random() > 0.5) {
    const numCommits = 1 + Math.floor(Math.random() * 3);
    commitCounter.add(numCommits, sessionAttrs);
    console.log(
      `  [session ${sessionIndex}] created ${numCommits} commit(s)`
    );
  }
  if (Math.random() > 0.8) {
    prCounter.add(1, sessionAttrs);
    console.log(`  [session ${sessionIndex}] created PR`);
  }

  // --- Graceful shutdown (mimics Claude Code's 2s timeout) ---
  console.log(`[session ${sessionIndex}] shutting down...`);
  await Promise.race([
    meterProvider.shutdown(),
    sleep(2000).then(() => {
      console.log(`  [session ${sessionIndex}] shutdown timed out (2s)`);
      return meterProvider.forceFlush();
    }),
  ]);
  console.log(
    `[session ${sessionIndex}] done (${((Date.now() - startTime) / 1000).toFixed(1)}s)`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main — launch overlapping sessions like real usage
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(70));
  console.log(
    `Claude Code OTel Simulator — ${TEMPORALITY.toUpperCase()} temporality`
  );
  console.log(`Endpoint: ${OTLP_ENDPOINT}`);
  console.log(`Sessions: ${NUM_SESSIONS}`);
  console.log(`Export interval: ${EXPORT_INTERVAL_MS}ms`);
  console.log("=".repeat(70));

  // Stagger session starts (real-world: users don't all start at once)
  const promises = [];
  for (let i = 0; i < NUM_SESSIONS; i++) {
    promises.push(runSession(i));
    // Stagger by 2-5 seconds between session starts
    if (i < NUM_SESSIONS - 1) {
      await sleep(2000 + Math.random() * 3000);
    }
  }

  await Promise.all(promises);
  console.log("\n" + "=".repeat(70));
  console.log("All sessions complete.");
  console.log(`Ground truth — tokens: ${totals.tokens}  cost: $${totals.cost.toFixed(4)}  sessions: ${totals.sessions}`);
  // Machine-readable line for the run script to parse
  console.log(`TOTALS_JSON:${JSON.stringify(totals)}`);
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
