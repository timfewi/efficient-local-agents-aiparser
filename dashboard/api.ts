/** Read-only projection of body-free Python receipts; no model or execution API. */
import { Database, type Statement } from "bun:sqlite";
import { existsSync } from "node:fs";
import { StateError, StateExplorer } from "./state";
import type {
  Campaign,
  CampaignDetail,
  CampaignsResponse,
  Failure,
  Overview,
  Run,
  RunsResponse,
  Trial,
} from "./src/types";

type Row = Record<string, unknown>;
const STAGES = [
  "analyst",
  "responder",
  "jev",
  "loop",
  "optimizer_analyst",
] as const;
const SAFE_LABEL = /^[A-Za-z0-9_.:/+@ -]{1,200}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const CAMPAIGN_STATUSES = new Set([
  "running",
  "completed",
  "budget_exhausted",
  "timed_out",
  "error",
  "finalized",
  "unknown_cost",
  "already_finalized",
  "no_champion_to_finalize",
  "holdout_not_configured",
  "holdout_already_used",
  "development_is_reserved_holdout",
]);
const TRIAL_STATUSES = new Set([
  "running",
  "baseline",
  "accepted",
  "rejected",
  "error",
  "timed_out",
  "holdout",
]);
const CHECK_NAMES = [
  "status",
  "exact_answer",
  "answer_set",
  "actions",
  "contains",
  "excludes",
  "required_documents",
  "grounded_quotes",
] as const;

function object(value: unknown): Row {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Row)
    : {};
}
function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function label(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && SAFE_LABEL.test(value) ? value : fallback;
}
function timestamp(value: unknown): string {
  return typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT[\d:.+Z-]{5,30}$/.test(value)
    ? value
    : "";
}
function code(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value)
    ? value
    : fallback;
}

/** Only numeric/enum tuning controls may leave the private database. */
function tuningConfig(value: unknown): Record<string, unknown> {
  const input = object(value);
  const allowed: Record<string, Record<string, (value: unknown) => boolean>> = {
    agent: {
      workflow: (v) => v === "loop" || v === "pipeline",
      pipeline_rounds: (v) =>
        Number.isInteger(v) && number(v) >= 1 && number(v) <= 3,
      preload_results: (v) =>
        Number.isInteger(v) && number(v) >= 0 && number(v) <= 20,
      preload_documents_under: (v) =>
        Number.isInteger(v) && number(v) >= 0 && number(v) <= 200,
      list_preview: (v) =>
        Number.isInteger(v) && number(v) >= 1 && number(v) <= 100,
      inventory: (v) => typeof v === "boolean",
      thought_chars: (v) =>
        Number.isInteger(v) && number(v) >= 0 && number(v) <= 2000,
      on_unverified: (v) => v === "abstain" || v === "answer",
    },
    limits: Object.fromEntries(
      [
        "max_steps",
        "max_calls",
        "max_retries",
        "max_context_chars",
        "max_observation_chars",
        "max_output_tokens",
        "max_total_tokens",
        "timeout_seconds",
        "task_timeout_seconds",
      ].map((key) => [
        key,
        (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0,
      ]),
    ),
  };
  const result: Record<string, unknown> = {};
  for (const [section, rules] of Object.entries(allowed)) {
    const values = object(input[section]);
    const clean = Object.fromEntries(
      Object.entries(rules)
        .filter(([key, validate]) => validate(values[key]))
        .map(([key]) => [key, values[key]]),
    );
    if (Object.keys(clean).length) result[section] = clean;
  }
  return result;
}

function campaign(row: Row): Campaign {
  const report = object(row.champion_report_json);
  return {
    id: label(row.id),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    status: CAMPAIGN_STATUSES.has(String(row.status))
      ? String(row.status)
      : "unknown",
    budgetUsd: number(row.budget_usd),
    spentUsd: number(row.spent_usd),
    spendComplete:
      row.status !== "unknown_cost" &&
      number(row.unobserved_attempts) === 0 &&
      number(report.unknown_cost_calls) === 0,
    maxIterations: number(row.max_iterations),
    championAccuracy: nullableNumber(report.accuracy),
    championCostUsd: nullableNumber(report.cost_usd),
    championCalls: number(report.calls),
    championTasks: number(report.tasks),
    championConfig: tuningConfig(row.champion_config_json),
  };
}
function trial(row: Row): Trial {
  const report = object(row.report_json);
  const decision = object(row.decision_json);
  const failures = object(report.failed_checks);
  const failedChecks: Trial["failedChecks"] = {};
  for (const name of CHECK_NAMES) {
    const count = failures[name];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
      failedChecks[name] = count;
  }
  let change: Trial["change"] = null;
  if (typeof decision.field === "string") {
    const [section, key, extra] = decision.field.split(".");
    if (
      section &&
      key &&
      !extra &&
      ["string", "number", "boolean"].includes(typeof decision.value)
    ) {
      const clean = tuningConfig({ [section]: { [key]: decision.value } });
      if (object(clean[section])[key] === decision.value) {
        change = {
          field: decision.field,
          value: decision.value as string | number | boolean,
        };
      }
    }
  }
  return {
    id: number(row.id),
    campaignId: label(row.campaign_id),
    iteration: number(row.iteration),
    createdAt: timestamp(row.created_at),
    status: TRIAL_STATUSES.has(String(row.status))
      ? String(row.status)
      : "unknown",
    accepted: typeof decision.accepted === "boolean" ? decision.accepted : null,
    phase: ["baseline", "tuning", "holdout"].includes(String(decision.phase))
      ? (decision.phase as "baseline" | "tuning" | "holdout")
      : "unknown",
    uncertainExternalAttempt:
      decision.unobserved_external_attempt_possible === true,
    reason: code(decision.reason),
    hypothesis: code(decision.hypothesis),
    change,
    accuracy: nullableNumber(report.accuracy),
    costUsd: nullableNumber(report.cost_usd),
    knownCostUsd: number(report.known_cost_usd),
    calls: number(report.calls),
    tasks: number(report.tasks),
    unknownCostCalls: number(report.unknown_cost_calls),
    failedChecks,
    config: tuningConfig(row.config_json),
  };
}

const CALL_AGGREGATES = `
  COUNT(c.id) AS calls,
  SUM(CASE WHEN c.cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost_calls,
  COALESCE(SUM(c.cost_usd), 0) AS known_cost_usd,
  CASE WHEN COUNT(c.id)=COUNT(c.input_tokens) THEN COALESCE(SUM(c.input_tokens),0) END AS input_tokens,
  CASE WHEN COUNT(c.id)=COUNT(c.output_tokens) THEN COALESCE(SUM(c.output_tokens),0) END AS output_tokens,
  COALESCE(SUM(c.latency_ms),0) AS latency_ms,
  SUM(CASE WHEN json_extract(CASE WHEN json_valid(c.metadata_json) THEN c.metadata_json ELSE '{}' END,'$.cache_hit')=1
      THEN 1 ELSE 0 END) AS cache_hits,
  SUM(CASE WHEN json_extract(CASE WHEN json_valid(c.metadata_json) THEN c.metadata_json ELSE '{}' END,'$.stage')='analyst'
      THEN 1 ELSE 0 END) AS analyst_calls,
  SUM(CASE WHEN json_extract(CASE WHEN json_valid(c.metadata_json) THEN c.metadata_json ELSE '{}' END,'$.stage')='responder'
      THEN 1 ELSE 0 END) AS responder_calls,
  SUM(CASE WHEN json_extract(CASE WHEN json_valid(c.metadata_json) THEN c.metadata_json ELSE '{}' END,'$.stage')='jev'
      THEN 1 ELSE 0 END) AS jev_calls,
  SUM(CASE WHEN json_extract(CASE WHEN json_valid(c.metadata_json) THEN c.metadata_json ELSE '{}' END,'$.stage')='optimizer_analyst'
      THEN 1 ELSE 0 END) AS optimizer_calls`;

// These are uncertain measurement records, not evidence of a provider request.
// json_type is deliberate: numeric 1 and the string "true" are not a boolean flag.
const UNOBSERVED_ATTEMPT = `json_type(CASE WHEN json_valid(decision_json)
  THEN decision_json ELSE '{}' END,'$.unobserved_external_attempt_possible')='true'`;

function run(row: Row): Run {
  const config = object(row.config_json);
  const count = number(row.calls);
  const analyst = number(row.analyst_calls);
  const responder = number(row.responder_calls);
  const jev = number(row.jev_calls);
  const optimizerAnalyst = number(row.optimizer_calls);
  const unknown = number(row.unknown_cost_calls);
  const workflow = object(config.agent).workflow;
  return {
    id: label(row.id),
    taskId: label(row.task_id),
    startedAt: timestamp(row.started_at),
    finishedAt: row.finished_at === null ? null : timestamp(row.finished_at),
    status: ["running", "ok", "abstain", "error"].includes(String(row.status))
      ? String(row.status)
      : "unknown",
    mode: row.mode === "mock" ? "mock" : "openai",
    workflow: workflow === "pipeline" ? "pipeline" : "loop",
    model: label(object(config.model).model),
    score: nullableNumber(row.score),
    calls: count,
    costUsd: unknown ? null : number(row.known_cost_usd),
    knownCostUsd: number(row.known_cost_usd),
    inputTokens: count ? nullableNumber(row.input_tokens) : 0,
    outputTokens: count ? nullableNumber(row.output_tokens) : 0,
    unknownCostCalls: unknown,
    latencyMs: number(row.latency_ms),
    cacheHits: number(row.cache_hits),
    stages: {
      analyst,
      responder,
      jev,
      optimizerAnalyst,
      loop: count - analyst - responder - jev - optimizerAnalyst,
    },
  };
}

/** One read-only connection, prepared statements, and a two-second aggregate snapshot. */
export class TelemetryStore {
  private db: Database | null = null;
  private statements = new Map<string, Statement>();
  private cachedOverview: { expires: number; value: Overview } | null = null;
  constructor(
    private path: string,
    private cacheMs = 2000,
  ) {}

  private database(): Database | null {
    if (!this.db && existsSync(this.path)) {
      this.db = new Database(this.path, {
        readonly: true,
        create: false,
        strict: true,
      });
      this.db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100");
    }
    return this.db;
  }
  private statement(sql: string): Statement | null {
    const db = this.database();
    if (!db) return null;
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = db.query(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }
  private rows(sql: string, ...parameters: (string | number)[]): Row[] {
    return (this.statement(sql)?.all(...parameters) ?? []) as Row[];
  }
  private one(sql: string, ...parameters: (string | number)[]): Row {
    return (this.statement(sql)?.get(...parameters) ?? {}) as Row;
  }
  private has(table: string): boolean {
    return Boolean(
      this.one(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        table,
      ).name,
    );
  }
  close(): void {
    this.statements.clear();
    this.db?.close();
    this.db = null;
    this.cachedOverview = null;
  }

  private campaignProjection(): string {
    return this.has("optimization_trials")
      ? `c.*,EXISTS(
      SELECT 1 FROM optimization_trials t WHERE t.campaign_id=c.id AND ${UNOBSERVED_ATTEMPT}
    ) AS unobserved_attempts`
      : "c.*,0 AS unobserved_attempts";
  }

  campaigns(): CampaignsResponse {
    return {
      items: this.has("optimization_campaigns")
        ? this.rows(
            `SELECT ${this.campaignProjection()} FROM optimization_campaigns c
              ORDER BY c.created_at DESC,c.id DESC LIMIT 50`,
          ).map(campaign)
        : [],
    };
  }
  campaign(id: string): CampaignDetail | null {
    if (!this.has("optimization_campaigns")) return null;
    const row = this.one(
      `SELECT ${this.campaignProjection()} FROM optimization_campaigns c WHERE c.id=?`,
      id,
    );
    if (!row.id) return null;
    const trials = this.has("optimization_trials")
      ? this.rows(
          "SELECT * FROM optimization_trials WHERE campaign_id=? ORDER BY iteration DESC,id DESC LIMIT 200",
          id,
        ).map(trial)
      : [];
    return { campaign: campaign(row), trials };
  }
  runs(limit: number, offset: number): RunsResponse {
    if (!this.has("runs")) return { items: [], total: 0, limit, offset };
    const total = number(this.one("SELECT COUNT(*) AS n FROM runs").n);
    if (!this.has("calls")) {
      return {
        items: this.rows(
          "SELECT * FROM runs ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?",
          limit,
          offset,
        ).map(run),
        total,
        limit,
        offset,
      };
    }
    // Aggregate only the requested page's calls, using calls_run. No N+1 requests or full-call join.
    const rows = this.rows(
      `WITH page AS (
      SELECT * FROM runs ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?
    ), stats AS (
      SELECT c.run_id,${CALL_AGGREGATES} FROM calls c JOIN page ON page.id=c.run_id GROUP BY c.run_id
    ) SELECT page.*,stats.* FROM page LEFT JOIN stats ON stats.run_id=page.id
      ORDER BY page.started_at DESC,page.id DESC`,
      limit,
      offset,
    );
    return { items: rows.map(run), total, limit, offset };
  }

  overview(): Overview {
    const now = Date.now();
    if (this.cachedOverview && now < this.cachedOverview.expires)
      return this.cachedOverview.value;
    const hasRuns = this.has("runs");
    const hasCalls = this.has("calls");
    const totals = hasCalls
      ? this.one(`SELECT ${CALL_AGGREGATES} FROM calls c`)
      : {};
    const unknown = number(totals.unknown_cost_calls);
    const uncertainDays = this.has("optimization_trials")
      ? this.rows(`
      SELECT substr(created_at,1,10) AS day,COUNT(*) AS n FROM optimization_trials
      WHERE ${UNOBSERVED_ATTEMPT} GROUP BY day`)
      : [];
    const unobservedAttempts = uncertainDays.reduce(
      (sum, row) => sum + number(row.n),
      0,
    );
    const runs = hasRuns
      ? number(this.one("SELECT COUNT(*) AS n FROM runs").n)
      : 0;
    const recentTrials = this.has("optimization_trials")
      ? this.rows(
          "SELECT * FROM optimization_trials ORDER BY created_at DESC,id DESC LIMIT 20",
        ).map(trial)
      : [];
    const observedTrend =
      hasRuns && hasCalls
        ? this.rows(
            `WITH daily_runs AS (
      SELECT substr(started_at,1,10) AS day,COUNT(*) AS runs,AVG(score) AS accuracy FROM runs
      GROUP BY day ORDER BY day DESC LIMIT 14
    ), daily_calls AS (
      SELECT substr(r.started_at,1,10) AS day,COUNT(c.id) AS calls,
        SUM(CASE WHEN c.cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown,
        COALESCE(SUM(c.cost_usd),0) AS known
      FROM calls c JOIN runs r ON r.id=c.run_id GROUP BY day
    ) SELECT a.*,b.calls,b.unknown,b.known FROM daily_runs a
      LEFT JOIN daily_calls b ON b.day=a.day ORDER BY a.day`,
          ).map((row) => ({
            date: /^\d{4}-\d\d-\d\d$/.test(String(row.day))
              ? String(row.day)
              : "unknown",
            runs: number(row.runs),
            calls: number(row.calls),
            costUsd: number(row.unknown) ? null : number(row.known),
            knownCostUsd: number(row.known),
            accuracy: nullableNumber(row.accuracy),
          }))
        : [];
    const days = new Map(observedTrend.map((point) => [point.date, point]));
    for (const row of uncertainDays) {
      if (!/^\d{4}-\d\d-\d\d$/.test(String(row.day))) continue;
      const date = String(row.day);
      const point = days.get(date);
      if (point) point.costUsd = null;
      else
        days.set(date, {
          date,
          runs: 0,
          calls: 0,
          costUsd: null,
          knownCostUsd: 0,
          accuracy: null,
        });
    }
    const trend = [...days.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-14);
    const failures: Failure[] = this.has("events")
      ? this.rows(
          `WITH safe AS (
      SELECT kind,
        CASE WHEN json_valid(data_json) THEN json_extract(data_json,'$.status') END AS status,
        CASE WHEN json_valid(data_json) THEN COALESCE(json_extract(data_json,'$.stage'),
          CASE WHEN kind='pipeline' THEN json_extract(data_json,'$.action') END) END AS stage
      FROM events WHERE kind IN ('repair','provider','budget','local','verification','pipeline')
    ) SELECT kind,status,stage,COUNT(*) AS n FROM safe WHERE status IN (
      'error','exhausted','rejected','invalid_output','jev_unavailable','jev_rejected',
      'unsafe_query_plan','query_budget_exhausted','query_arguments_exceed_limit',
      'analyst_output_invalid','responder_output_invalid','no_new_evidence'
    ) GROUP BY kind,status,stage ORDER BY n DESC LIMIT 20`,
        ).map((row) => ({
          code: `${code(row.kind)}:${code(row.status)}`,
          count: number(row.n),
          stage: STAGES.includes(row.stage as (typeof STAGES)[number])
            ? String(row.stage)
            : null,
        }))
      : [];
    const value: Overview = {
      updatedAt: new Date(now).toISOString(),
      totals: {
        runs,
        calls: number(totals.calls),
        costUsd:
          unknown || unobservedAttempts ? null : number(totals.known_cost_usd),
        knownCostUsd: number(totals.known_cost_usd),
        inputTokens: hasCalls ? nullableNumber(totals.input_tokens) : 0,
        outputTokens: hasCalls ? nullableNumber(totals.output_tokens) : 0,
        unknownCostCalls: unknown,
        unobservedAttempts,
      },
      latestCampaign: this.campaigns().items[0] ?? null,
      recentTrials,
      trend,
      failures,
    };
    this.cachedOverview = { expires: now + this.cacheMs, value };
    return value;
  }
}

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
};
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: HEADERS });
}
function pageNumber(
  value: string | null,
  fallback: number,
  maximum: number,
  minimum: number,
): number | null {
  if (value === null) return fallback;
  if (!/^(0|[1-9]\d{0,6})$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= minimum && parsed <= maximum ? parsed : null;
}

/** Returns null only for non-API routes handled by Bun's HTML bundle. */
export function createApi(
  store: TelemetryStore,
  state = new StateExplorer(),
): (request: Request) => Response | null {
  return (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/"))
      return null;
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      return json({ error: "local_requests_only" }, 403);
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin)
      return json({ error: "cross_origin_request_denied" }, 403);
    if (request.method !== "GET") return json({ error: "read_only_api" }, 405);
    const allowed =
      url.pathname === "/api/state/document"
        ? new Set(["id"])
        : url.pathname === "/api/runs"
          ? new Set(["limit", "offset"])
          : new Set<string>();
    if (
      [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
      [...allowed].some((key) => url.searchParams.getAll(key).length > 1)
    ) {
      return json({ error: "invalid_query_parameters" }, 400);
    }
    try {
      if (url.pathname === "/api/state") return json(state.inventory());
      if (url.pathname === "/api/state/document") {
        const id = url.searchParams.get("id");
        if (!id || !/^[a-f0-9]{32}$/.test(id))
          return json({ error: "invalid_document_id" }, 400);
        return json(state.document(id));
      }
      if (url.pathname === "/api/overview") return json(store.overview());
      if (url.pathname === "/api/runs") {
        const limit = pageNumber(url.searchParams.get("limit"), 50, 100, 1);
        const offset = pageNumber(
          url.searchParams.get("offset"),
          0,
          1000000,
          0,
        );
        if (limit === null || offset === null)
          return json({ error: "invalid_pagination" }, 400);
        return json(store.runs(limit, offset));
      }
      if (url.pathname === "/api/campaigns") return json(store.campaigns());
      const detail = /^\/api\/campaigns\/([A-Za-z0-9_-]{1,100})$/.exec(
        url.pathname,
      );
      if (detail && SAFE_ID.test(detail[1]!)) {
        const result = store.campaign(detail[1]!);
        return result
          ? json(result)
          : json({ error: "campaign_not_found" }, 404);
      }
      return json({ error: "api_route_not_found" }, 404);
    } catch (error) {
      if (error instanceof StateError)
        return json({ error: error.code }, error.status);
      // Paths, SQLite diagnostics and private data never reach the browser.
      return json({ error: "telemetry_unavailable" }, 503);
    }
  };
}
