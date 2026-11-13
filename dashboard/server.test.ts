import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi, TelemetryStore } from "./api";

const SCHEMA = `
  PRAGMA journal_mode=WAL;
  CREATE TABLE runs (id TEXT PRIMARY KEY,task_id TEXT,started_at TEXT,finished_at TEXT,
    status TEXT,mode TEXT,config_hash TEXT,config_json TEXT,metadata_json TEXT,answer_hash TEXT,score REAL);
  CREATE TABLE calls (id INTEGER PRIMARY KEY,run_id TEXT,created_at TEXT,provider TEXT,model TEXT,
    input_tokens INTEGER,output_tokens INTEGER,latency_ms REAL,status TEXT,input_rate REAL,
    output_rate REAL,cost_usd REAL,billable INTEGER,metadata_json TEXT);
  CREATE TABLE events (id INTEGER PRIMARY KEY,run_id TEXT,created_at TEXT,kind TEXT,data_json TEXT);
  CREATE INDEX calls_run ON calls(run_id);
  CREATE INDEX runs_started ON runs(started_at DESC,id DESC);
  CREATE TABLE optimization_campaigns (id TEXT PRIMARY KEY,created_at TEXT,updated_at TEXT,
    status TEXT,git_head TEXT,dev_digest TEXT,budget_usd REAL,max_iterations INTEGER,
    champion_config_json TEXT,champion_report_json TEXT,spent_usd REAL);
  CREATE TABLE optimization_trials (id INTEGER PRIMARY KEY,campaign_id TEXT,iteration INTEGER,
    created_at TEXT,status TEXT,config_json TEXT,report_json TEXT,decision_json TEXT);
`;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture(schema = SCHEMA, cacheMs = 0) {
  const directory = mkdtempSync(join(tmpdir(), "hacklab-dashboard-test-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "tracking.sqlite");
  const db = new Database(path);
  cleanup.push(() => db.close());
  if (schema.trim()) db.exec(schema);
  const store = new TelemetryStore(path, cacheMs);
  cleanup.push(() => store.close());
  const api = createApi(store);
  return {
    db,
    store,
    api,
    path,
    get: (path: string) => api(new Request(`http://127.0.0.1:3000${path}`))!,
  };
}

function addRun(
  db: Database,
  id: string,
  hour = "01",
  score: number | null = 1,
) {
  db.query(`INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id,
    `task-${id}`,
    `2026-11-13T${hour}:00:00+00:00`,
    `2026-11-13T${hour}:01:00+00:00`,
    "ok",
    "openai",
    "abcdef123",
    JSON.stringify({
      model: { model: "test-model" },
      agent: { workflow: "pipeline" },
    }),
    "{}",
    "answer-digest-only",
    score,
  );
}
function addCall(
  db: Database,
  id: number,
  runId: string,
  cost: number | null,
  input: number | null,
  output: number | null,
  stage: string,
  cached = false,
) {
  db.query("INSERT INTO calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    id,
    runId,
    "2026-11-13T01:00:00Z",
    "openai",
    "test-model",
    input,
    output,
    25,
    "ok",
    0.1,
    0.2,
    cost,
    1,
    JSON.stringify({ stage, cache_hit: cached }),
  );
}

function uncertainCampaign(db: Database) {
  db.query(
    "INSERT INTO optimization_campaigns VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "uncertain-campaign",
    "2026-11-13T01:00:00Z",
    "2026-11-13T02:00:00Z",
    "completed",
    "git-hash",
    "dev-hash",
    0.5,
    4,
    "{}",
    "{}",
    0,
  );
  const insert = db.query(
    "INSERT INTO optimization_trials VALUES (?,?,?,?,?,?,?,?)",
  );
  insert.run(
    1,
    "uncertain-campaign",
    1,
    "2026-11-13T01:00:00Z",
    "timed_out",
    "{}",
    "{}",
    JSON.stringify({
      phase: "tuning",
      reason: "measurement_timed_out",
      unobserved_external_attempt_possible: true,
    }),
  );
  // The uncertain trial is outside recentTrials; totals must examine all retained records.
  for (let id = 2; id <= 25; id++)
    insert.run(
      id,
      "uncertain-campaign",
      id,
      "2026-11-13T02:00:00Z",
      "rejected",
      "{}",
      "{}",
      JSON.stringify({
        unobserved_external_attempt_possible: id % 2 ? "true" : 1,
      }),
    );
}

describe("body-free statistics", () => {
  test("unknown cost and tokens stay null; stage counts and unweighted accuracy are exact", async () => {
    const { db, get } = fixture();
    addRun(db, "r1", "01", 1);
    addRun(db, "r2", "02", 0);
    addRun(db, "r3", "03", 1);
    addCall(db, 1, "r1", 0.1, 100, 50, "analyst");
    addCall(db, 2, "r1", null, null, 70, "responder");
    addCall(db, 3, "r3", 0.2, 200, 30, "jev", true);
    addCall(db, 4, "r3", 0, 0, 0, "optimizer_analyst");
    const data = await get("/api/overview").json();
    expect(data.totals).toEqual({
      runs: 3,
      calls: 4,
      costUsd: null,
      knownCostUsd: expect.closeTo(0.3),
      inputTokens: null,
      outputTokens: 150,
      unknownCostCalls: 1,
      unobservedAttempts: 0,
    });
    expect(data.trend[0].accuracy).toBeCloseTo(2 / 3);
    expect(data.trend[0].runs).toBe(3);
    expect(data.trend[0].costUsd).toBeNull();
    const page = await get("/api/runs?limit=2&offset=1").json();
    expect(page.total).toBe(3);
    expect(page.items.map((row: { id: string }) => row.id)).toEqual([
      "r2",
      "r1",
    ]);
    expect(page.items[0]).toMatchObject({
      calls: 0,
      costUsd: 0,
      inputTokens: 0,
    });
    expect(page.items[1]).toMatchObject({
      calls: 2,
      costUsd: null,
      stages: {
        analyst: 1,
        responder: 1,
        jev: 0,
        optimizerAnalyst: 0,
        loop: 0,
      },
    });
    const latest = await get("/api/runs?limit=1").json();
    expect(latest.items[0].stages).toEqual({
      analyst: 0,
      responder: 0,
      jev: 1,
      optimizerAnalyst: 1,
      loop: 0,
    });
  });

  test("unobserved measurement records leave cost unknown without fabricating provider requests", async () => {
    const { db, get } = fixture();
    uncertainCampaign(db);
    const data = await get("/api/overview").json();
    expect(data.totals).toMatchObject({
      calls: 0,
      costUsd: null,
      knownCostUsd: 0,
      unknownCostCalls: 0,
      unobservedAttempts: 1,
    });
    expect(data.recentTrials).toHaveLength(20);
    expect(
      data.recentTrials.every(
        (row: { uncertainExternalAttempt: boolean }) =>
          !row.uncertainExternalAttempt,
      ),
    ).toBe(true);
    expect(data.trend).toEqual([
      {
        date: "2026-11-13",
        runs: 0,
        calls: 0,
        costUsd: null,
        knownCostUsd: 0,
        accuracy: null,
      },
    ]);
    expect(data.latestCampaign.spendComplete).toBe(false);
    expect(
      (await get("/api/campaigns/uncertain-campaign").json()).campaign
        .spendComplete,
    ).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM calls").get()).toEqual({ n: 0 });
  });

  test("known receipts remain a lower bound when an unobserved measurement is possible", async () => {
    const { db, get } = fixture();
    uncertainCampaign(db);
    addRun(db, "known");
    addCall(db, 1, "known", 0.25, 100, 50, "analyst");
    const data = await get("/api/overview").json();
    expect(data.totals).toMatchObject({
      calls: 1,
      costUsd: null,
      knownCostUsd: 0.25,
      unknownCostCalls: 0,
      unobservedAttempts: 1,
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(data.trend[0]).toMatchObject({
      calls: 1,
      costUsd: null,
      knownCostUsd: 0.25,
    });
    db.query(
      "UPDATE optimization_campaigns SET status='development_is_reserved_holdout'",
    ).run();
    expect((await get("/api/campaigns").json()).items[0].status).toBe(
      "development_is_reserved_holdout",
    );
    expect(db.query("SELECT COUNT(*) AS n FROM calls").get()).toEqual({ n: 1 });
  });

  test("aggregate cache refreshes after its bounded TTL without losing WAL updates", () => {
    const { db, store } = fixture(SCHEMA, 2000);
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
      addRun(db, "first");
      expect(store.overview().totals.runs).toBe(1);
      addRun(db, "second");
      clock.mockReturnValue(2000);
      expect(store.overview().totals.runs).toBe(1);
      expect(store.runs(50, 0).total).toBe(2);
      clock.mockReturnValue(3001);
      expect(store.overview().totals.runs).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  test("missing database and optional tables produce empty states without creating files", async () => {
    const { get, path } = fixture("");
    expect(await get("/api/overview").json()).toMatchObject({
      totals: { runs: 0, calls: 0, costUsd: 0 },
      latestCampaign: null,
      recentTrials: [],
      trend: [],
      failures: [],
    });
    expect(await get("/api/runs").json()).toEqual({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    const absent = `${path}.absent`;
    const store = new TelemetryStore(absent);
    try {
      expect(store.overview().totals.runs).toBe(0);
    } finally {
      store.close();
    }
    expect(existsSync(absent)).toBe(false);
  });

  test("campaign and trial projections expose only allowed tuning controls and aggregates", async () => {
    const { db, get } = fixture();
    const secret = "NEVER_EXPOSE_PRIVATE_MODEL_OR_DOCUMENT_BODY";
    const config = JSON.stringify({
      model: { api_key: secret, base_url: `https://private.invalid/${secret}` },
      agent: { workflow: "pipeline", skills: `/private/${secret}` },
      limits: { max_steps: 4 },
      private_prompt: secret,
    });
    const report = JSON.stringify({
      accuracy: 0.8,
      cost_usd: null,
      known_cost_usd: 0.3,
      calls: 12,
      tasks: 10,
      unknown_cost_calls: 1,
      answers: [secret],
      failed_checks: {
        status: 2,
        exact_answer: 0,
        actions: -1,
        contains: 1.5,
        excludes: "3",
        required_documents: true,
        [secret]: 99,
      },
    });
    db.query(
      "INSERT INTO optimization_campaigns VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "campaign1",
      "2026-11-13T01:00:00Z",
      "2026-11-13T02:00:00Z",
      "completed",
      "git-hash",
      "dev-hash",
      0.5,
      4,
      config,
      report,
      0.12,
    );
    db.query("INSERT INTO optimization_trials VALUES (?,?,?,?,?,?,?,?)").run(
      1,
      "campaign1",
      0,
      "2026-11-13T01:00:00Z",
      "baseline",
      config,
      report,
      JSON.stringify({
        accepted: true,
        reason: "baseline",
        hypothesis: "initial",
        phase: "baseline",
        field: "agent.workflow",
        value: "pipeline",
        analysis: secret,
      }),
    );
    const detailResponse = get("/api/campaigns/campaign1");
    const detailText = await detailResponse.text();
    expect(detailText).not.toContain(secret);
    const detail = JSON.parse(detailText);
    expect(detail.campaign).toMatchObject({
      budgetUsd: 0.5,
      spentUsd: 0.12,
      championAccuracy: 0.8,
      championCostUsd: null,
      championCalls: 12,
    });
    expect(detail.campaign.championConfig).toEqual({
      agent: { workflow: "pipeline" },
      limits: { max_steps: 4 },
    });
    expect(detail.trials[0]).toMatchObject({
      reason: "baseline",
      accepted: true,
      unknownCostCalls: 1,
      costUsd: null,
      change: { field: "agent.workflow", value: "pipeline" },
      phase: "baseline",
      uncertainExternalAttempt: false,
      failedChecks: { status: 2, exact_answer: 0 },
    });
    db.query("UPDATE optimization_trials SET decision_json=? WHERE id=1").run(
      JSON.stringify({ field: "model.api_key", value: secret }),
    );
    const privateChange = await get("/api/campaigns/campaign1").text();
    expect(privateChange).not.toContain(secret);
    expect(JSON.parse(privateChange).trials[0].change).toBeNull();
    db.query(
      "UPDATE optimization_trials SET status='timed_out',decision_json=? WHERE id=1",
    ).run(
      JSON.stringify({
        phase: "holdout",
        reason: "measurement_timed_out",
        unobserved_external_attempt_possible: true,
      }),
    );
    const holdout = await get("/api/campaigns/campaign1").json();
    expect(holdout.trials[0]).toMatchObject({
      phase: "holdout",
      status: "timed_out",
      uncertainExternalAttempt: true,
      reason: "measurement_timed_out",
    });
    db.query("UPDATE optimization_trials SET decision_json=? WHERE id=1").run(
      JSON.stringify({
        phase: "untrusted phase text",
        unobserved_external_attempt_possible: "true",
      }),
    );
    const untrusted = await get("/api/campaigns/campaign1").json();
    expect(untrusted.trials[0]).toMatchObject({
      phase: "unknown",
      uncertainExternalAttempt: false,
    });
    expect((await get("/api/overview").json()).recentTrials).toHaveLength(1);
    expect((await get("/api/campaigns").json()).items).toHaveLength(1);
    expect(get("/api/campaigns/missing").status).toBe(404);
  });

  test("run configurations and event extras cannot expose private inputs", async () => {
    const { db, get } = fixture();
    addRun(db, "safe");
    const secret = "PRIVATE_BODY_SENTINEL";
    db.query(
      "UPDATE runs SET config_json=?,metadata_json=? WHERE id='safe'",
    ).run(
      JSON.stringify({
        model: { model: "test-model", api_key: secret },
        prompt: secret,
      }),
      JSON.stringify({ task_body: secret }),
    );
    db.query(
      "INSERT INTO events VALUES (1,'safe','2026-11-13T01:00:00Z','pipeline',?)",
    ).run(
      JSON.stringify({
        action: "analyst",
        status: "unsafe_query_plan",
        raw_output: secret,
      }),
    );
    db.query(
      "INSERT INTO events VALUES (2,'safe','2026-11-13T01:00:00Z','provider',?)",
    ).run(JSON.stringify({ status: secret, raw_output: secret }));
    expect(await get("/api/runs").text()).not.toContain(secret);
    const response = await get("/api/overview").text();
    expect(response).not.toContain(secret);
    expect(JSON.parse(response).failures).toEqual([
      { code: "pipeline:unsafe_query_plan", count: 1, stage: "analyst" },
    ]);
  });
});

describe("local read-only HTTP boundary", () => {
  test.each([
    "limit=0",
    "limit=101",
    "limit=1e2",
    "limit=1.5",
    "limit=-1",
    "offset=-1",
    "offset=1000001",
    "limit=1&limit=2",
    "db=/private/file",
    "path=/private/file",
  ])("rejects invalid request %s", (parameters) => {
    const { get } = fixture();
    expect(get(`/api/runs?${parameters}`).status).toBe(400);
  });

  test("unsupported methods, foreign origins and database-path injection are refused", async () => {
    const { db, api, get } = fixture();
    addRun(db, "safe");
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expect(
        api(new Request("http://127.0.0.1:3000/api/runs", { method }))!.status,
      ).toBe(405);
    }
    expect(
      api(
        new Request("http://127.0.0.1:3000/api/overview", {
          headers: { Origin: "https://untrusted.invalid" },
        }),
      )!.status,
    ).toBe(403);
    expect(
      api(new Request("http://attacker.invalid/api/overview"))!.status,
    ).toBe(403);
    const response = get("/api/overview");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(get("/api/overview?db=other.sqlite").status).toBe(400);
    expect(get("/api/execute").status).toBe(404);
    expect((await get("/api/runs").json()).total).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 1 });
  });

  test("SQLite failures have fixed responses without file paths or diagnostics", async () => {
    const { path } = fixture();
    const corrupt = `${path}.corrupt`;
    writeFileSync(corrupt, "PRIVATE_BODY_FROM_BROKEN_DATABASE");
    const store = new TelemetryStore(corrupt);
    try {
      const response = createApi(store)(
        new Request("http://127.0.0.1:3000/api/overview"),
      )!;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "telemetry_unavailable" });
    } finally {
      store.close();
    }
  });

  test("real Bun HTTP requests return the same paginated read-only projection", async () => {
    const { db, api } = fixture();
    addRun(db, "live");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        api(request) ?? new Response("Not found", { status: 404 }),
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/runs?limit=1`,
      );
      expect(response.status).toBe(200);
      expect((await response.json()).items[0].id).toBe("live");
    } finally {
      await server.stop(true);
    }
  });
});
