/** Synthetic API throughput only. This does not measure model quality or model cost. */
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi, TelemetryStore } from "./api";
import {
  StateExplorer,
  type StateDocument,
  type StateInventory,
} from "./state";

const RUNS = 10_000;
const CALLS_PER_RUN = 10;
const CAMPAIGNS = 100;
const TRIALS_PER_CAMPAIGN = 10;
const directory = mkdtempSync(join(tmpdir(), "hacklab-dashboard-bench-"));
const path = join(directory, "synthetic.sqlite");
let writer: Database | null = null;
let store: TelemetryStore | null = null;
let stopServer: (() => void | Promise<void>) | undefined;

function percentile(sorted: number[], proportion: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)]!;
}
function configuration(iteration: number) {
  return {
    agent: {
      workflow: "pipeline",
      preload_results: 5,
      inventory: true,
      preload_documents_under: 40,
      list_preview: 12,
    },
    limits: { max_observation_chars: 4000 - iteration * 200 },
    fixed_config_sha256: "a".repeat(64),
    config_sha256: String(iteration).padStart(64, "0"),
  };
}
function report(iteration: number) {
  const input = 10_000 - iteration * 200;
  const output = 5000;
  const cost = (input * 0.1 + output * 0.2) / 1_000_000;
  return {
    benchmark_kind: "local_development_not_organizer_score",
    mode: "openai",
    tasks: 10,
    accuracy: 0.8,
    cost_usd: cost,
    known_cost_usd: cost,
    unknown_cost_calls: 0,
    calls: 100,
    cache_hits: 0,
    known_input_tokens: input,
    known_output_tokens: output,
    usage_complete: true,
    p50_elapsed_ms: 250,
    p95_elapsed_ms: 400,
    dataset_sha256: "b".repeat(64),
    failed_checks: {
      status: 0,
      exact_answer: 1,
      answer_set: 0,
      actions: 1,
      contains: 0,
      excludes: 0,
      required_documents: 0,
      grounded_quotes: 0,
    },
  };
}

try {
  const stateRoot = join(directory, "state");
  mkdirSync(stateRoot);
  const messages = [
    "agent=worker-01 result=contained count=2",
    "agent=worker-01 result=contained count=3",
    "agent=worker-01 result=not_contained count=2",
    "agent=worker-02 phase=validated attempts=1",
    "agent=worker-02 phase=not_validated attempts=1",
    "agent=worker-03 result=unchanged count=0",
  ];
  const sourceLines: string[] = [];
  let fixtureBytes = 0;
  for (let index = 0; ; index++) {
    const timestamp = new Date(
      Date.UTC(2026, 10, 13) + index * 1000,
    ).toISOString();
    const line = `[${timestamp}] ${messages[index % messages.length]}`;
    const bytes = Buffer.byteLength(line + "\n");
    if (fixtureBytes + bytes > 200 * 1024) break;
    sourceLines.push(line);
    fixtureBytes += bytes;
  }
  writeFileSync(join(stateRoot, "messages.log"), sourceLines.join("\n") + "\n");
  writeFileSync(
    join(stateRoot, "experiment.md"),
    "# Run 1\n## Results\nContained: 2.\n\n" +
      "# Run 2\n## Results\nNot contained: 2.\n\nAll timestamps and source positions remain available.\n",
  );
  const explorer = new StateExplorer([{ name: "synthetic", path: stateRoot }]);
  const logFile = explorer
    .inventory()
    .files.find((file) => file.name === "synthetic/messages.log");
  if (!logFile) throw new Error("synthetic_state_fixture_missing");
  const documentEndpoint = `/api/state/document?id=${logFile.id}`;
  const db = new Database(path);
  writer = db;
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE runs(id TEXT PRIMARY KEY,task_id TEXT,started_at TEXT,finished_at TEXT,status TEXT,
      mode TEXT,config_hash TEXT,config_json TEXT,metadata_json TEXT,answer_hash TEXT,score REAL);
    CREATE TABLE calls(id INTEGER PRIMARY KEY,run_id TEXT,created_at TEXT,provider TEXT,model TEXT,
      input_tokens INTEGER,output_tokens INTEGER,latency_ms REAL,status TEXT,input_rate REAL,
      output_rate REAL,cost_usd REAL,billable INTEGER,metadata_json TEXT);
    CREATE TABLE events(id INTEGER PRIMARY KEY,run_id TEXT,created_at TEXT,kind TEXT,data_json TEXT);
    CREATE TABLE optimization_campaigns(id TEXT PRIMARY KEY,created_at TEXT,updated_at TEXT,
      status TEXT,git_head TEXT,dev_digest TEXT,budget_usd REAL,max_iterations INTEGER,
      champion_config_json TEXT,champion_report_json TEXT,spent_usd REAL);
    CREATE TABLE optimization_trials(id INTEGER PRIMARY KEY,campaign_id TEXT,iteration INTEGER,
      created_at TEXT,status TEXT,config_json TEXT,report_json TEXT,decision_json TEXT);
    CREATE INDEX calls_run ON calls(run_id);
    CREATE INDEX events_run ON events(run_id);
    CREATE INDEX runs_started ON runs(started_at DESC,id DESC);
    CREATE INDEX optimization_trials_campaign ON optimization_trials(campaign_id,id);`);
  const insertRun = db.query("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const insertCall = db.query(
    "INSERT INTO calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insertCampaign = db.query(
    "INSERT INTO optimization_campaigns VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insertTrial = db.query(
    "INSERT INTO optimization_trials VALUES (?,?,?,?,?,?,?,?)",
  );
  db.transaction(() => {
    for (let index = 0; index < RUNS; index++) {
      const id = `synthetic-${String(index).padStart(5, "0")}`;
      const day = String((index % 14) + 1).padStart(2, "0");
      const created = `2026-11-${day}T00:00:00Z`;
      insertRun.run(
        id,
        id,
        created,
        created,
        "ok",
        "openai",
        "synthetic-digest",
        '{"model":{"model":"synthetic-model"},"agent":{"workflow":"pipeline"}}',
        "{}",
        "synthetic-answer-digest",
        index % 5 === 0 ? 0 : 1,
      );
      for (let call = 0; call < CALLS_PER_RUN; call++) {
        insertCall.run(
          index * CALLS_PER_RUN + call + 1,
          id,
          created,
          "openai",
          "synthetic-model",
          100,
          50,
          25,
          "ok",
          0.1,
          0.2,
          index % 20 === 0 ? null : 0.00002,
          1,
          JSON.stringify({
            stage:
              call === 0 && index % 25 === 0
                ? "optimizer_analyst"
                : call % 2
                  ? "responder"
                  : "analyst",
          }),
        );
      }
    }
    for (let campaign = 0; campaign < CAMPAIGNS; campaign++) {
      const id = `synthetic-campaign-${String(campaign).padStart(3, "0")}`;
      const day = String((campaign % 14) + 1).padStart(2, "0");
      const created = `2026-11-${day}T01:00:00Z`;
      const uncertainCampaign = campaign === CAMPAIGNS - 1;
      insertCampaign.run(
        id,
        created,
        created,
        uncertainCampaign ? "unknown_cost" : "finalized",
        "c".repeat(40),
        "b".repeat(64),
        0.5,
        8,
        JSON.stringify(configuration(8)),
        JSON.stringify(report(8)),
        0.018,
      );
      for (let iteration = 0; iteration < TRIALS_PER_CAMPAIGN; iteration++) {
        const phase =
          iteration === 0 ? "baseline" : iteration === 9 ? "holdout" : "tuning";
        const uncertain = uncertainCampaign && phase === "holdout";
        const accepted = phase === "tuning" && iteration % 2 === 0;
        const measuredIteration = phase === "holdout" ? 8 : iteration;
        const decision = {
          phase,
          ...(phase === "tuning" ? { accepted } : {}),
          reason: uncertain
            ? "measurement_timed_out"
            : phase === "baseline"
              ? "measured_baseline"
              : phase === "holdout"
                ? "heldout_once"
                : accepted
                  ? "pareto_improvement"
                  : "tradeoff_rejected",
          ...(phase === "tuning"
            ? {
                field: "limits.max_observation_chars",
                value: 4000 - iteration * 200,
                hypothesis: "reduce_context",
              }
            : {}),
          ...(uncertain ? { unobserved_external_attempt_possible: true } : {}),
        };
        insertTrial.run(
          campaign * TRIALS_PER_CAMPAIGN + iteration + 1,
          id,
          iteration,
          created,
          uncertain
            ? "timed_out"
            : phase === "baseline"
              ? "baseline"
              : phase === "holdout"
                ? "holdout"
                : accepted
                  ? "accepted"
                  : "rejected",
          JSON.stringify(configuration(measuredIteration)),
          JSON.stringify(
            uncertain
              ? {
                  cost_usd: null,
                  known_cost_usd: 0,
                  calls: 0,
                  unknown_cost_calls: 0,
                  usage_complete: false,
                }
              : report(measuredIteration),
          ),
          JSON.stringify(decision),
        );
      }
    }
  })();
  db.close();
  writer = null;
  store = new TelemetryStore(path);
  const api = createApi(store, explorer);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      api(request) ?? new Response("Not found", { status: 404 }),
  });
  stopServer = () => server.stop(true);
  async function request(endpoint: string) {
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:${server.port}${endpoint}`);
    const body = await response.arrayBuffer();
    if (!response.ok) throw new Error(`synthetic_api_http_${response.status}`);
    return {
      elapsedMs: performance.now() - start,
      bytes: body.byteLength,
      body,
    };
  }
  let sourceBytes = 0;
  let knowledge: {
    sourceBytes: number;
    sourceBlocks: number;
    uniqueNodes: number;
    retainedOccurrences: number;
    recoveredSourceLines: number;
    truncated: boolean;
    documentResponseBytes: number;
    visualNodeCompactionRatio: number;
    responseBodyToSourceRatio: number;
    interpretation: string;
  } | null = null;
  const measurements = [];
  for (const endpoint of [
    "/api/overview",
    "/api/runs?limit=50&offset=5000",
    "/api/campaigns",
    "/api/campaigns/synthetic-campaign-099",
    "/api/state",
    documentEndpoint,
  ]) {
    const cold = await request(endpoint);
    if (endpoint === "/api/state") {
      const inventory = JSON.parse(
        new TextDecoder().decode(cold.body),
      ) as StateInventory;
      sourceBytes =
        inventory.files.find((file) => file.id === logFile.id)?.bytes ?? 0;
    }
    if (endpoint === documentEndpoint) {
      const document = JSON.parse(
        new TextDecoder().decode(cold.body),
      ) as StateDocument;
      const recovered = new Set<number>();
      for (const node of document.nodes) {
        const message = node.text.replace(/^\[[^\]]+\] /, "");
        for (const occurrence of node.occurrences) {
          if (
            recovered.has(occurrence.line) ||
            `${occurrence.timestamp} ${message}` !==
              sourceLines[occurrence.line - 1]
          ) {
            throw new Error("synthetic_state_projection_mismatch");
          }
          recovered.add(occurrence.line);
        }
      }
      if (
        document.truncated ||
        recovered.size !== sourceLines.length ||
        !sourceBytes
      ) {
        throw new Error("synthetic_state_projection_incomplete");
      }
      knowledge = {
        sourceBytes,
        sourceBlocks: document.metrics.blocks,
        uniqueNodes: document.nodes.length,
        retainedOccurrences: document.nodes.reduce(
          (sum, node) => sum + node.occurrences.length,
          0,
        ),
        recoveredSourceLines: recovered.size,
        truncated: document.truncated,
        documentResponseBytes: cold.bytes,
        visualNodeCompactionRatio:
          document.metrics.blocks / document.nodes.length,
        responseBodyToSourceRatio: cold.bytes / sourceBytes,
        interpretation:
          "Repeated visual nodes are grouped; decoded response-body bytes include every timestamp and position. HTTP headers, transport overhead and compression are not measured. This is not a byte-compression or model-quality result.",
      };
    }
    for (let warmup = 0; warmup < 10; warmup++) await request(endpoint);
    const samples = [];
    let bytes = 0;
    for (let sample = 0; sample < 200; sample++) {
      const measured = await request(endpoint);
      samples.push(measured.elapsedMs);
      bytes = measured.bytes;
    }
    samples.sort((a, b) => a - b);
    measurements.push({
      endpoint,
      samples: samples.length,
      coldMs: cold.elapsedMs,
      p50Ms: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95),
      responseBytes: bytes,
    });
  }
  console.log(
    JSON.stringify(
      {
        scope:
          "synthetic local API; no model requests or model-quality measurement",
        bun: Bun.version,
        runs: RUNS,
        calls: RUNS * CALLS_PER_RUN,
        campaigns: CAMPAIGNS,
        trials: CAMPAIGNS * TRIALS_PER_CAMPAIGN,
        uncertainMeasurementRecords: 1,
        aggregateCacheMs: 2000,
        warmupsPerEndpoint: 10,
        coldDefinition:
          "First request per endpoint; SQLite and OS caches are not flushed",
        warmDefinition:
          "200 sequential requests after warmups; the aggregate cache may expire",
        measurements,
        knowledge,
      },
      null,
      2,
    ),
  );
} finally {
  // Also clean up when schema creation, insertion or server startup fails.
  try {
    await stopServer?.();
  } finally {
    try {
      store?.close();
    } finally {
      try {
        writer?.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
}
