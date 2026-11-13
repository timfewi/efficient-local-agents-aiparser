import { Component, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import Knowledge, { KnowledgeNodeDetail } from "./Knowledge";
import type {
  Campaign,
  CampaignDetail,
  CampaignsResponse,
  Failure,
  Overview,
  Run,
  RunsResponse,
  TrendPoint,
  Trial,
  StateDocument,
  StateNode,
  Totals,
} from "./types";

type View = "overview" | "runs" | "feedback" | "knowledge";
type IconName =
  | "grid"
  | "runs"
  | "feedback"
  | "spark"
  | "arrow"
  | "chevron"
  | "refresh"
  | "target"
  | "coin"
  | "layers"
  | "tokens"
  | "search"
  | "shield"
  | "check"
  | "clock"
  | "warning"
  | "close"
  | "menu"
  | "activity"
  | "terminal";

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    runs: (
      <>
        <path d="m8 5 12 7-12 7z" />
        <path d="M3 5v14" />
      </>
    ),
    feedback: (
      <>
        <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1V11.5a8.5 8.5 0 0 1 17-1" />
        <path d="M8 10h8M8 14h5" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7z" />
        <path d="M20 2v4M18 4h4" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14m-5-5 5 5-5 5" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    refresh: (
      <>
        <path d="M20 8a8 8 0 0 0-14-2L3 9m0-6v6h6M4 16a8 8 0 0 0 14 2l3-3m0 6v-6h-6" />
      </>
    ),
    target: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1" />
      </>
    ),
    coin: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M15 8h-4a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9m3-10v12" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5" />
      </>
    ),
    tokens: (
      <>
        <rect x="5" y="5" width="14" height="14" rx="3" />
        <path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4M9 9h6v6H9z" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    warning: (
      <>
        <path d="m10.3 4.5-8 14A1.7 1.7 0 0 0 3.8 21h16.4a1.7 1.7 0 0 0 1.5-2.5l-8-14a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4m0 4h.01" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    activity: <path d="M2 12h4l3-8 6 16 3-8h4" />,
    terminal: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="m7 9 3 3-3 3m6 0h4" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function money(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return "Unknown";
  if (value > 0 && value < 0.5 * 10 ** -digits)
    return `<$${(10 ** -digits).toFixed(digits)}`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(value);
}
export function percentage(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "Unscored"
    : `${(value * 100).toFixed(1)}%`;
}
const integer = (value: number | null) =>
  value === null ? "Unknown" : new Intl.NumberFormat("en-US").format(value);
const compact = (value: number | null) =>
  value === null
    ? "Unknown"
    : new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
function dateLabel(value: string, full = false) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(
        "en-US",
        full
          ? {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }
          : { month: "short", day: "numeric" },
      ).format(date);
}
function duration(ms: number) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
function statusTone(status: string) {
  if (
    ["accepted", "ok", "complete", "completed", "passed", "finalized"].includes(
      status,
    )
  )
    return "success";
  if (["error", "failed", "rejected"].includes(status)) return "danger";
  if (
    [
      "unknown_cost",
      "budget_exhausted",
      "timed_out",
      "abstain",
      "holdout_not_configured",
    ].includes(status)
  )
    return "warning";
  if (["running", "pending", "evaluating", "active"].includes(status))
    return "running";
  return "neutral";
}
function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${statusTone(status)}`}>
      {status === "running" && <span className="status-dot" />}
      {status.replaceAll("_", " ")}
    </span>
  );
}

async function getJSON<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error(`The local API returned HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

function Empty({
  title,
  children,
  icon = "layers",
}: {
  title: string;
  children: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={19} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  icon,
  warning = false,
}: {
  label: string;
  value: ReactNode;
  note: string;
  icon: IconName;
  warning?: boolean;
}) {
  return (
    <article className="metric-card">
      <div className="metric-topline">
        <span>{label}</span>
        <span className="metric-icon">
          <Icon name={icon} size={14} />
        </span>
      </div>
      <div className="metric-value">{value}</div>
      <div className={`metric-footnote ${warning ? "warning" : ""}`}>
        {warning && <Icon name="warning" />}
        {note}
      </div>
    </article>
  );
}

export function TrendChart({
  points,
  metric,
}: {
  points: TrendPoint[];
  metric: "accuracy" | "cost";
}) {
  const gradientId = useId().replaceAll(":", "");
  const values = points.map((point) =>
    metric === "accuracy" ? point.accuracy : point.costUsd,
  );
  const known = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (!known.length)
    return (
      <div className="chart-empty">
        <Empty
          title={
            metric === "accuracy"
              ? "Accuracy will appear here"
              : "No fully priced days yet"
          }
          icon="activity"
        >
          {metric === "accuracy"
            ? "Score a benchmark run to start an evidence-backed trend."
            : "A day needs usage and prices for every call. Partial costs stay visible in the run details."}
        </Empty>
      </div>
    );
  const max = metric === "accuracy" ? 1 : Math.max(...known, 0.0001) * 1.2;
  const left = 43,
    right = 590,
    top = 18,
    bottom = 166;
  const times = points.map((point) => new Date(point.date).getTime());
  const timeSpan = Math.max(...times) - Math.min(...times);
  const x = (index: number) =>
    points.length === 1
      ? (left + right) / 2
      : Number.isFinite(timeSpan) && timeSpan > 0
        ? left +
          ((times[index] - Math.min(...times)) / timeSpan) * (right - left)
        : left + (index * (right - left)) / (points.length - 1);
  const y = (value: number) =>
    bottom - Math.min(Math.max(value / max, 0), 1) * (bottom - top);
  const segments: { x: number; y: number }[][] = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) return;
    if (
      index === 0 ||
      values[index - 1] === null ||
      !Number.isFinite(values[index - 1])
    )
      segments.push([]);
    segments[segments.length - 1].push({ x: x(index), y: y(value) });
  });
  const label = (value: number) =>
    metric === "accuracy"
      ? `${Math.round(value * 100)}%`
      : money(value, value < 0.01 ? 4 : 2);
  return (
    <>
      <svg
        className="chart-svg"
        viewBox="0 0 620 205"
        role="img"
        aria-label={`${metric === "accuracy" ? "Daily scored accuracy" : "Daily fully known cost"} across ${points.length} recorded days. Missing values are gaps.`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor={metric === "accuracy" ? "#c6d9b6" : "#ded3b9"}
              stopOpacity=".44"
            />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
          <g key={tick}>
            <line
              x1={left}
              y1={y(tick * max)}
              x2={right}
              y2={y(tick * max)}
              stroke="#edf0e7"
              strokeDasharray={tick === 0 ? undefined : "3 4"}
            />
            <text x={left - 10} y={y(tick * max) + 3} textAnchor="end">
              {label(tick * max)}
            </text>
          </g>
        ))}
        {segments.map((segment, index) => {
          const path = segment
            .map((point, i) => `${i === 0 ? "M" : "L"} ${point.x} ${point.y}`)
            .join(" ");
          return (
            <g key={index}>
              <path
                d={`${path} L ${segment[segment.length - 1].x} ${bottom} L ${segment[0].x} ${bottom} Z`}
                fill={`url(#${gradientId})`}
              />
              <path
                d={path}
                fill="none"
                stroke={metric === "accuracy" ? "#84a56f" : "#b8a37e"}
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          );
        })}
        {values.map((value, index) =>
          value !== null && Number.isFinite(value) ? (
            <circle
              key={index}
              cx={x(index)}
              cy={y(value)}
              r="3"
              fill={metric === "accuracy" ? "#7c9f67" : "#b8a37e"}
              stroke="white"
              strokeWidth="1.5"
            >
              <title>
                {`${dateLabel(points[index].date)}: ${label(value)}`}
              </title>
            </circle>
          ) : null,
        )}
        {points.map((point, index) =>
          index === 0 ||
          index === points.length - 1 ||
          points.length <= 7 ||
          index % Math.ceil(points.length / 5) === 0 ? (
            <text key={point.date} x={x(index)} y={190} textAnchor="middle">
              {dateLabel(point.date)}
            </text>
          ) : null,
        )}
      </svg>
      <ol className="sr-only">
        {points.map((point, i) => (
          <li key={point.date}>
            {dateLabel(point.date)}:{" "}
            {values[i] === null ? "unknown" : label(values[i] as number)}
          </li>
        ))}
      </ol>
    </>
  );
}

function Trends({ overview }: { overview: Overview }) {
  const [metric, setMetric] = useState<"accuracy" | "cost">("accuracy");
  const [range, setRange] = useState("14");
  const points =
    range === "all" ? overview.trend : overview.trend.slice(-Number(range));
  const scoredDays = points.filter((point) => point.accuracy !== null).length;
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">Performance over time</h2>
          <p className="panel-subtitle">Small changes. Measurable progress.</p>
        </div>
        <select
          className="quiet-select"
          value={range}
          onChange={(event) => setRange(event.target.value)}
          aria-label="Trend range"
        >
          <option value="7">Last 7 recorded days</option>
          <option value="14">Last 14 recorded days</option>
          <option value="all">All recorded days</option>
        </select>
      </div>
      <div className="chart-tabs" role="group" aria-label="Chart metric">
        {(["accuracy", "cost"] as const).map((value) => (
          <button
            key={value}
            className={`chart-tab ${metric === value ? "active" : ""}`}
            aria-pressed={metric === value}
            onClick={() => setMetric(value)}
          >
            <span className="chart-legend-dot" />
            {value === "accuracy" ? "Accuracy" : "Estimated cost"}
          </button>
        ))}
      </div>
      <div className="chart-wrap">
        <TrendChart points={points} metric={metric} />
      </div>
      <div className="chart-summary">
        <Icon name="shield" size={11} />
        {metric === "accuracy"
          ? `${scoredDays} scored ${scoredDays === 1 ? "day" : "days"} · unscored tasks excluded, never treated as failures`
          : "Reported usage × configured prices · unknown costs are gaps"}
      </div>
      <div className="panel-footer">
        <span>{integer(overview.totals.runs)} task runs recorded</span>
        <strong>Evidence before intuition</strong>
      </div>
    </section>
  );
}

function CampaignPanel({
  campaign,
  trials,
  onTrial,
  onCampaign,
}: {
  campaign: Campaign | null;
  trials: Trial[];
  onTrial: (trial: Trial) => void;
  onCampaign: (id: string) => void;
}) {
  const unknownCost =
    (campaign !== null && !campaign.spendComplete) ||
    campaign?.status === "unknown_cost" ||
    trials.some((trial) => trial.unknownCostCalls > 0);
  const remaining =
    campaign && !unknownCost
      ? Math.max(0, campaign.budgetUsd - campaign.spentUsd)
      : null;
  return (
    <section className="panel campaign-panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">Improvement loop</h2>
          <p className="panel-subtitle">
            Scout → analyst → validator → reviewer
          </p>
        </div>
        {campaign && <Badge status={campaign.status} />}
      </div>
      {campaign ? (
        <>
          <div className="campaign-summary">
            <div className="campaign-budget-top">
              <span>Budget remaining</span>
              <strong>{money(remaining, 2)}</strong>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-label="Recorded campaign budget used"
              aria-valuetext={
                unknownCost
                  ? "Known spend only; remaining budget is unknown"
                  : undefined
              }
              aria-valuenow={Math.min(campaign.spentUsd, campaign.budgetUsd)}
              aria-valuemin={0}
              aria-valuemax={campaign.budgetUsd}
            >
              <div
                className="progress-fill"
                style={{
                  width: `${campaign.budgetUsd > 0 ? Math.min(100, (campaign.spentUsd / campaign.budgetUsd) * 100) : 0}%`,
                }}
              />
            </div>
            <p className="budget-note">
              {money(campaign.spentUsd)} {unknownCost ? "known spend" : "spent"}{" "}
              of {money(campaign.budgetUsd, 2)}
              <br />
              {unknownCost && (
                <>
                  Full cost is unknown.
                  <br />
                </>
              )}
              Up to {campaign.maxIterations} iterations · controlled from the
              CLI
            </p>
          </div>
          <div className="timeline">
            {trials.length ? (
              trials.slice(0, 3).map((trial) => (
                <div className="timeline-item" key={trial.id}>
                  <span
                    className={`timeline-marker ${trial.accepted === true ? "accepted" : trial.accepted === false ? "rejected" : ""}`}
                  />
                  <button
                    className="timeline-button"
                    onClick={() => onTrial(trial)}
                    aria-label={`Open iteration ${trial.iteration}: ${trial.status}`}
                  >
                    <span className="timeline-title">
                      <span>{trialLabel(trial)}</span>
                      <Badge
                        status={
                          trial.accepted === true
                            ? "accepted"
                            : trial.accepted === false
                              ? "rejected"
                              : trial.status
                        }
                      />
                    </span>
                    <span className="timeline-meta">
                      {percentage(trial.accuracy)} accuracy ·{" "}
                      {money(trial.costUsd)}
                    </span>
                    <span className="timeline-reason">
                      {trial.hypothesis ||
                        trial.reason ||
                        "Waiting for a measured result."}
                    </span>
                  </button>
                </div>
              ))
            ) : (
              <p className="budget-note">No candidate trials recorded yet.</p>
            )}
          </div>
          <div className="panel-footer">
            <span>{campaign.championTasks} champion tasks</span>
            <button
              className="text-button"
              onClick={() => onCampaign(campaign.id)}
            >
              Campaign details <Icon name="arrow" size={12} />
            </button>
          </div>
        </>
      ) : (
        <Empty title="Your next experiment starts here" icon="spark">
          Start a bounded campaign from the CLI. Its candidates, budget and
          decisions will appear here.
        </Empty>
      )}
    </section>
  );
}

export function filterRuns(
  runs: Run[],
  query: string,
  workflow: string,
): Run[] {
  const search = query.trim().toLowerCase();
  return runs.filter(
    (run) =>
      (workflow === "all" || run.workflow === workflow) &&
      (!search ||
        [
          run.id,
          run.taskId,
          run.model,
          run.workflow,
          run.status,
          run.mode,
        ].some((value) => value.toLowerCase().includes(search))),
  );
}

function RunsTable({
  data,
  page,
  setPage,
  onRun,
  compact: isCompact = false,
}: {
  data: RunsResponse;
  page: number;
  setPage: (page: number) => void;
  onRun: (run: Run) => void;
  compact?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [workflow, setWorkflow] = useState("all");
  const workflows = [...new Set(data.items.map((run) => run.workflow))].filter(
    Boolean,
  );
  const filtered = filterRuns(data.items, query, workflow);
  const rows = isCompact ? filtered.slice(0, 5) : filtered;
  const pageCount = Math.max(1, Math.ceil(data.total / data.limit));
  return (
    <section className="panel">
      <div className="table-toolbar">
        <label className="search-field">
          <Icon name="search" size={14} />
          <span className="sr-only">Filter runs on this page</span>
          <input
            placeholder="Filter this page…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          className="quiet-select"
          value={workflow}
          onChange={(event) => setWorkflow(event.target.value)}
          aria-label="Workflow filter"
        >
          <option value="all">All workflows</option>
          {workflows.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <caption className="sr-only">
              Recorded task runs. Filters apply to the currently loaded page.
            </caption>
            <thead>
              <tr>
                <th scope="col">Task / model</th>
                <th scope="col">Workflow</th>
                <th scope="col">Accuracy</th>
                <th scope="col">Calls</th>
                <th scope="col">Cost</th>
                <th scope="col">Status</th>
                <th scope="col">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => (
                <tr key={run.id}>
                  <td>
                    <button
                      className="run-cell-button"
                      onClick={() => onRun(run)}
                    >
                      <span className="run-name">{run.taskId || run.id}</span>
                      <span className="run-meta">
                        {run.model || "No model call"}
                      </span>
                    </button>
                  </td>
                  <td>
                    <span className="badge neutral">
                      {run.workflow || "loop"}
                    </span>
                  </td>
                  <td>
                    <span className="accuracy-cell">
                      {percentage(run.score)}
                      {run.score !== null && (
                        <span className="mini-progress" aria-hidden="true">
                          <span
                            style={{
                              width: `${Math.min(100, Math.max(0, run.score * 100))}%`,
                            }}
                          />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="numeric">{run.calls}</td>
                  <td
                    className={`numeric ${run.costUsd === null ? "cost-unknown" : ""}`}
                  >
                    {money(run.costUsd)}
                  </td>
                  <td>
                    <Badge status={run.status} />
                  </td>
                  <td>{dateLabel(run.startedAt, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={data.total ? "No matches on this page" : "A clean slate"}
          icon="runs"
        >
          {data.total
            ? "Try another search or workflow, or move to a different page."
            : "Run a benchmark or submit a rehearsal task. Real run statistics will appear here automatically."}
        </Empty>
      )}
      <div className="pagination">
        <span>
          {query || workflow !== "all"
            ? `${filtered.length} matching on this page`
            : data.total
              ? `${page * data.limit + 1}–${Math.min(page * data.limit + rows.length, data.total)} of ${integer(data.total)} runs`
              : "No runs recorded"}
        </span>
        {!isCompact && (
          <div className="pagination-controls">
            <button
              className="icon-button"
              aria-label="Previous run page"
              disabled={page <= 0}
              onClick={() => setPage(page - 1)}
            >
              <span style={{ transform: "rotate(180deg)", display: "flex" }}>
                <Icon name="chevron" size={13} />
              </span>
            </button>
            <span className="pagination-label">
              Page {page + 1} of {pageCount}
            </span>
            <button
              className="icon-button"
              aria-label="Next run page"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage(page + 1)}
            >
              <Icon name="chevron" size={13} />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export function trialSeries(trials: Trial[], metric: "accuracy" | "cost") {
  return [...trials]
    .sort(
      (a, b) =>
        a.iteration - b.iteration ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id - b.id,
    )
    .map((trial) => {
      const value = metric === "accuracy" ? trial.accuracy : trial.costUsd;
      const incomplete = ["error", "timed_out", "running", "unknown"].includes(
        trial.status,
      );
      return {
        trial,
        value:
          incomplete || value === null || !Number.isFinite(value)
            ? null
            : value,
      };
    });
}

function trialLabel(trial: Trial) {
  return trial.phase === "baseline" || trial.status === "baseline"
    ? "Baseline"
    : trial.phase === "holdout" || trial.status === "holdout"
      ? `Hold-out evaluation ${trial.iteration}`
      : `Trial ${trial.iteration}`;
}
function trialColor(trial: Trial) {
  return trial.accepted === true
    ? "#62874d"
    : trial.accepted === false
      ? "#b07b60"
      : trial.status === "baseline"
        ? "#5c7060"
        : "#9c895b";
}

export function TrialLearningCharts({
  trials,
  onTrial,
}: {
  trials: Trial[];
  onTrial: (trial: Trial) => void;
}) {
  return (
    <div className="learning-section">
      <div className="learning-heading">
        <div>
          <h3>Every experiment, in sequence</h3>
          <p>
            Baseline and candidate evaluations stay distinct, even on the same
            day.
          </p>
        </div>
        <span className="badge neutral">{trials.length} records</span>
      </div>
      <div className="learning-charts">
        {(["accuracy", "cost"] as const).map((metric) => {
          const series = trialSeries(trials, metric);
          const known = series.filter(
            (point): point is { trial: Trial; value: number } =>
              point.value !== null,
          );
          const max =
            metric === "accuracy"
              ? 1
              : Math.max(...known.map((point) => point.value), 0.0001) * 1.15;
          const left = 51,
            right = 397,
            top = 22,
            bottom = 145;
          const x = (index: number) =>
            series.length < 2
              ? (left + right) / 2
              : left + (index * (right - left)) / (series.length - 1);
          const y = (value: number) =>
            bottom - Math.min(1, Math.max(0, value / max)) * (bottom - top);
          const label = (value: number) =>
            metric === "accuracy"
              ? `${Math.round(value * 100)}%`
              : money(value, max < 0.01 ? 4 : 2);
          const paths: string[] = [];
          series.forEach((point, index) => {
            if (point.value === null) return;
            if (index === 0 || series[index - 1].value === null)
              paths.push(`M ${x(index)} ${y(point.value)}`);
            else paths[paths.length - 1] += ` L ${x(index)} ${y(point.value)}`;
          });
          return (
            <section className="learning-chart" key={metric}>
              <h4>
                {metric === "accuracy"
                  ? "Evaluation accuracy"
                  : "Cost per evaluation"}
              </h4>
              {known.length ? (
                <svg
                  viewBox="0 0 425 183"
                  role="group"
                  aria-label={`${metric === "accuracy" ? "Accuracy" : "Cost"} by campaign evaluation; activate a point to inspect its trial`}
                >
                  {[0, 0.5, 1].map((tick) => (
                    <g key={tick}>
                      <line
                        x1={left}
                        x2={right}
                        y1={y(tick * max)}
                        y2={y(tick * max)}
                        stroke="#e9eedf"
                        strokeDasharray="3 4"
                      />
                      <text x={left - 9} y={y(tick * max) + 3} textAnchor="end">
                        {label(tick * max)}
                      </text>
                    </g>
                  ))}
                  {paths.map((path, index) => (
                    <path
                      key={index}
                      d={path}
                      stroke="#c9d5bc"
                      strokeWidth="1.5"
                      fill="none"
                    />
                  ))}
                  {series.map((point, index) =>
                    point.value === null ? null : (
                      <g
                        key={point.trial.id}
                        role="button"
                        tabIndex={0}
                        className="trial-chart-point"
                        data-trial-id={point.trial.id}
                        aria-label={`${trialLabel(point.trial)}: ${label(point.value)}, ${point.trial.accepted === true ? "accepted" : point.trial.accepted === false ? "rejected" : point.trial.status}`}
                        onClick={() => onTrial(point.trial)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onTrial(point.trial);
                          }
                        }}
                      >
                        <title>
                          {`${trialLabel(point.trial)} · ${label(point.value)} · ${point.trial.tasks} tasks · ${dateLabel(point.trial.createdAt, true)}`}
                        </title>
                        <circle
                          cx={x(index)}
                          cy={y(point.value)}
                          r="12"
                          fill="transparent"
                        />
                        <circle
                          cx={x(index)}
                          cy={y(point.value)}
                          r={point.trial.status === "baseline" ? 4.7 : 4}
                          fill={trialColor(point.trial)}
                          stroke="#fff"
                          strokeWidth="1.8"
                        />
                      </g>
                    ),
                  )}
                  {series.map((point, index) =>
                    index === 0 ||
                    index === series.length - 1 ||
                    index % Math.ceil(series.length / 5) === 0 ? (
                      <text
                        key={point.trial.id}
                        x={x(index)}
                        y="170"
                        textAnchor="middle"
                      >
                        {point.trial.status === "baseline"
                          ? "Base"
                          : point.trial.phase === "holdout" ||
                              point.trial.status === "holdout"
                            ? `H${point.trial.iteration}`
                            : point.trial.iteration}
                      </text>
                    ) : null,
                  )}
                </svg>
              ) : (
                <div className="learning-empty">
                  {metric === "accuracy"
                    ? "No completed scored evaluations yet."
                    : "No completed evaluations with fully known cost yet."}
                </div>
              )}
              <p className="learning-axis-label">
                Evaluation sequence · activate a point for evidence
              </p>
            </section>
          );
        })}
      </div>
      <div className="learning-legend">
        <span>
          <i style={{ background: "#5c7060" }} />
          Baseline
        </span>
        <span>
          <i style={{ background: "#62874d" }} />
          Accepted
        </span>
        <span>
          <i style={{ background: "#b07b60" }} />
          Rejected
        </span>
        <span>
          <i style={{ background: "#9c895b" }} />
          Other measured record
        </span>
      </div>
      <p className="learning-note">
        Unknown values and incomplete evaluations are gaps, not zeros. Costs are
        per evaluation; compare task counts in the details. Calls and failed
        attempts remain in the workspace totals.
      </p>
    </div>
  );
}

function CampaignLearning({
  campaignId,
  refreshIndex,
  onTrial,
}: {
  campaignId: string;
  refreshIndex: number;
  onTrial: (trial: Trial) => void;
}) {
  const [data, setData] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getJSON<CampaignDetail>(
      `/api/campaigns/${encodeURIComponent(campaignId)}`,
      controller.signal,
    )
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not read campaign learning history.",
          );
      });
    return () => controller.abort();
  }, [campaignId, refreshIndex]);
  return (
    <section className="panel campaign-learning-panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">Learning within this campaign</h2>
          <p className="panel-subtitle">
            A full day of iteration deserves more than one daily point.
          </p>
        </div>
        <Icon name="activity" />
      </div>
      {error && (
        <div className="knowledge-caveat limited" role="alert">
          {error}
          {data ? " Previously loaded evidence remains visible." : ""}
        </div>
      )}
      {data ? (
        <TrialLearningCharts trials={data.trials} onTrial={onTrial} />
      ) : (
        !error && (
          <Empty title="Loading the experiment sequence" icon="clock">
            Reading baseline and tested candidates from the local campaign.
          </Empty>
        )
      )}
    </section>
  );
}

function Feedback({
  failures,
  unknown,
  campaignId,
  refreshIndex,
  onTrial,
}: {
  failures: Failure[];
  unknown: number;
  campaignId: string | null;
  refreshIndex: number;
  onTrial: (trial: Trial) => void;
}) {
  return (
    <>
      {campaignId && (
        <CampaignLearning
          key={campaignId}
          campaignId={campaignId}
          refreshIndex={refreshIndex}
          onTrial={onTrial}
        />
      )}
      <div className="feedback-grid">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">Signals for the next improvement</h2>
              <p className="panel-subtitle">
                Aggregate diagnostics. No task or model bodies.
              </p>
            </div>
            <Icon name="feedback" />
          </div>
          {failures.length ? (
            <div className="feedback-list">
              {failures.map((failure, index) => (
                <article
                  className="feedback-row"
                  key={`${failure.code}-${failure.stage}-${index}`}
                >
                  <Icon name="warning" size={16} />
                  <div>
                    <h3>{failure.code.replaceAll("_", " ")}</h3>
                    <p>
                      {failure.stage
                        ? `Stage: ${failure.stage}`
                        : "Across recorded runs"}
                      <br />
                      Inspect the private development trace before changing a
                      prompt or tool.
                    </p>
                  </div>
                  <span className="feedback-count">
                    {integer(failure.count)}
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <Empty title="No recorded failures" icon="check">
              Diagnostic signals from future runs will appear here. An empty
              list is not an accuracy claim.
            </Empty>
          )}
        </section>
        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Keep the feedback honest</h2>
            <Icon name="shield" />
          </div>
          <div className="principles">
            <div className="principle">
              <h3>
                <Icon name="coin" size={14} />
                Unknown means unknown
              </h3>
              <p>
                {unknown > 0
                  ? `${integer(unknown)} calls lack complete cost accounting. Known subtotals are not the full bill.`
                  : "Cost is calculated from reported usage and explicit prices. Missing usage is never estimated from text length."}
              </p>
            </div>
            <div className="principle">
              <h3>
                <Icon name="target" size={14} />
                Hold-out stays held out
              </h3>
              <p>
                Compare one change on the same development cases, then validate
                the selected candidate on unseen cases.
              </p>
            </div>
            <div className="principle">
              <h3>
                <Icon name="terminal" size={14} />
                You control the experiment
              </h3>
              <p>
                This workspace reads local run statistics. Starting a model run,
                approving a candidate and spending budget stay in the CLI.
              </p>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function DetailDialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const focusable = ref.current?.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, summary, [tabindex="0"]',
      );
      if (!focusable?.length) return;
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`detail-dialog ${wide ? "wide-dialog" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={ref}
      >
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">Evidence detail</p>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close details"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function costNote(totals: Totals): string {
  const notes = [`${money(totals.knownCostUsd)} known subtotal`];
  if (totals.unknownCostCalls)
    notes.push(`${totals.unknownCostCalls} unpriced receipts`);
  if (totals.unobservedAttempts) {
    notes.push(
      `${totals.unobservedAttempts} interrupted measurements; requests unobserved`,
    );
  }
  return notes.join(" · ");
}

export function GradingChecks({ trial }: { trial: Trial }) {
  const checks = Object.entries(trial.failedChecks);
  const failures = checks.filter(
    ([, count]) => count !== undefined && count > 0,
  );
  return (
    <section aria-label="Recorded grading checks" className="grading-checks">
      <h3>Where the evaluation lost points</h3>
      {failures.map(([name, count]) => (
        <div key={name} className="grading-check">
          <span>{name.replaceAll("_", " ")}</span>
          <div className="progress-track" aria-hidden="true">
            <div
              className="progress-fill"
              style={{
                width: `${Math.min(100, (count! / Math.max(1, trial.tasks)) * 100)}%`,
              }}
            />
          </div>
          <strong>
            {count} / {trial.tasks}
          </strong>
        </div>
      ))}
      <p className="dialog-footnote">
        {failures.length
          ? "Failed task counts can overlap across checks."
          : checks.length
            ? "No failures in the recorded checks."
            : "No grading-check counts recorded for this evaluation."}
      </p>
    </section>
  );
}

export function TrialDetail({ trial }: { trial: Trial }) {
  return (
    <>
      <Badge
        status={
          trial.accepted === true
            ? "accepted"
            : trial.accepted === false
              ? "rejected"
              : trial.status
        }
      />
      <p className="dialog-footnote">
        Phase:{" "}
        {trial.phase === "holdout"
          ? "Hold-out evaluation"
          : trial.phase === "baseline"
            ? "Baseline evaluation"
            : trial.phase === "tuning"
              ? "Development candidate"
              : "Not recorded"}
      </p>
      {trial.phase === "holdout" && (
        <p className="dialog-warning">
          A hold-out evaluation is separate from tuning. Its attempt freezes the
          campaign, including a failed or timed-out attempt.
        </p>
      )}
      {trial.uncertainExternalAttempt && (
        <p className="dialog-warning">
          Interrupted attempt: an external request is possible but unobserved.
          This record does not prove that a request occurred or establish its
          billed cost.
        </p>
      )}
      <p className="dialog-description">
        {trial.hypothesis || "No hypothesis recorded."}
      </p>
      <p className="dialog-description">
        {trial.reason || "No decision recorded yet."}
      </p>
      {trial.change && (
        <p className="dialog-warning">
          <strong>One proposed change:</strong> {trial.change.field} ={" "}
          {String(trial.change.value)}
        </p>
      )}
      <dl className="detail-grid">
        <div>
          <dt>Accuracy</dt>
          <dd>{percentage(trial.accuracy)}</dd>
        </div>
        <div>
          <dt>Estimated cost</dt>
          <dd>{money(trial.costUsd)}</dd>
        </div>
        <div>
          <dt>Provider calls</dt>
          <dd>{integer(trial.calls)}</dd>
        </div>
        <div>
          <dt>Tasks</dt>
          <dd>{integer(trial.tasks)}</dd>
        </div>
        <div>
          <dt>Iteration</dt>
          <dd>{trial.iteration}</dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd>{dateLabel(trial.createdAt, true)}</dd>
        </div>
      </dl>
      {trial.costUsd === null && (
        <p className="dialog-warning">
          Total cost is unknown. The known subtotal is{" "}
          {money(trial.knownCostUsd)}; {trial.unknownCostCalls} calls have
          incomplete accounting.
        </p>
      )}
      <GradingChecks trial={trial} />
      <details>
        <summary>Candidate configuration</summary>
        <pre>{JSON.stringify(trial.config, null, 2)}</pre>
      </details>
      <p className="dialog-footnote">
        Acceptance is a recorded development decision, not proof of hold-out
        accuracy.
      </p>
    </>
  );
}

function RunDetail({ run }: { run: Run }) {
  return (
    <>
      <p className="dialog-id">{run.id}</p>
      <Badge status={run.status} />
      <dl className="detail-grid">
        <div>
          <dt>Task score</dt>
          <dd>{percentage(run.score)}</dd>
        </div>
        <div>
          <dt>Estimated cost</dt>
          <dd>{money(run.costUsd)}</dd>
        </div>
        <div>
          <dt>Latency</dt>
          <dd>{duration(run.latencyMs)}</dd>
        </div>
        <div>
          <dt>Input tokens</dt>
          <dd>{integer(run.inputTokens)}</dd>
        </div>
        <div>
          <dt>Output tokens</dt>
          <dd>{integer(run.outputTokens)}</dd>
        </div>
        <div>
          <dt>Provider calls</dt>
          <dd>{run.calls}</dd>
        </div>
        <div>
          <dt>Analyst calls</dt>
          <dd>{run.stages.analyst}</dd>
        </div>
        <div>
          <dt>Responder calls</dt>
          <dd>{run.stages.responder}</dd>
        </div>
        <div>
          <dt>Optimizer analyst calls</dt>
          <dd>{run.stages.optimizerAnalyst}</dd>
        </div>
        <div>
          <dt>Loop / Jev calls</dt>
          <dd>
            {run.stages.loop} / {run.stages.jev}
          </dd>
        </div>
      </dl>
      {run.costUsd === null && (
        <p className="dialog-warning">
          Cost is incomplete. Known subtotal: {money(run.knownCostUsd)}.
          Unpriced or missing-usage calls: {run.unknownCostCalls}.
        </p>
      )}
      <p className="dialog-footnote">
        Model: {run.model || "none"} · workflow: {run.workflow} · mode:{" "}
        {run.mode}
        <br />
        {run.cacheHits} cache replays are included in reported usage. No answer
        bodies are stored in this view.
      </p>
    </>
  );
}

function Dashboard() {
  const [view, setView] = useState<View>("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [runs, setRuns] = useState<RunsResponse>({
    items: [],
    total: 0,
    limit: 10,
    offset: 0,
  });
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [selectedTrial, setSelectedTrial] = useState<Trial | null>(null);
  const [selectedNode, setSelectedNode] = useState<{
    node: StateNode;
    document: StateDocument;
  } | null>(null);
  const [campaignDetail, setCampaignDetail] = useState<CampaignDetail | null>(
    null,
  );
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [campaignLoading, setCampaignLoading] = useState(false);
  const detailController = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    Promise.all([
      getJSON<Overview>("/api/overview", controller.signal),
      getJSON<RunsResponse>(
        `/api/runs?limit=10&offset=${page * 10}`,
        controller.signal,
      ),
      getJSON<CampaignsResponse>("/api/campaigns", controller.signal),
    ])
      .then(([nextOverview, nextRuns, nextCampaigns]) => {
        if (
          !nextOverview.totals ||
          !Array.isArray(nextOverview.trend) ||
          !Array.isArray(nextRuns.items) ||
          !Array.isArray(nextCampaigns.items)
        )
          throw new Error("The local API returned an unexpected response.");
        setOverview(nextOverview);
        setRuns(nextRuns);
        setCampaigns(nextCampaigns.items);
        setError(null);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not read local run statistics.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [page, refreshIndex]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setRefreshIndex((value) => value + 1);
    }, 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => () => detailController.current?.abort(), []);
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const sidebar = document.getElementById("workspace-navigation");
    sidebar?.querySelector<HTMLButtonElement>("button")?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
      if (event.key !== "Tab") return;
      const focusable =
        sidebar?.querySelectorAll<HTMLElement>("button, a[href]");
      if (!focusable?.length) return;
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [menuOpen]);
  const navigate = (next: View) => {
    setView(next);
    setMenuOpen(false);
    if (next !== "runs") setPage(0);
  };
  const campaign = overview?.latestCampaign ?? null;
  const currentTrials =
    overview?.recentTrials.filter(
      (trial) => !campaign || trial.campaignId === campaign.id,
    ) ?? [];
  const latestAccuracy =
    campaign?.championAccuracy ??
    [...(overview?.trend ?? [])]
      .reverse()
      .find((point) => point.accuracy !== null)?.accuracy ??
    null;
  const totals = overview?.totals;
  const openCampaign = (id: string) => {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setCampaignLoading(true);
    setCampaignDetail(null);
    setCampaignError(null);
    getJSON<CampaignDetail>(
      `/api/campaigns/${encodeURIComponent(id)}`,
      controller.signal,
    )
      .then(setCampaignDetail)
      .catch((cause) => {
        if (!controller.signal.aborted)
          setCampaignError(
            cause instanceof Error
              ? cause.message
              : "Could not load this campaign.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setCampaignLoading(false);
      });
  };
  const nav: { id: View; label: string; icon: IconName }[] = [
    { id: "overview", label: "Overview", icon: "grid" },
    { id: "runs", label: "Runs", icon: "runs" },
    { id: "feedback", label: "Feedback", icon: "feedback" },
    { id: "knowledge", label: "Knowledge", icon: "layers" },
  ];
  const pageTitle =
    view === "overview"
      ? "Make every run count."
      : view === "runs"
        ? "Every run. All the evidence."
        : view === "knowledge"
          ? "The same knowledge. A clearer shape."
          : "Learn from what happened.";
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <button
        className={`overlay ${menuOpen ? "open" : ""}`}
        aria-label="Close navigation"
        hidden={!menuOpen}
        onClick={() => setMenuOpen(false)}
      />
      <aside
        className={`sidebar ${menuOpen ? "open" : ""}`}
        id="workspace-navigation"
        aria-label="Workspace navigation"
      >
        <button
          className="icon-button sidebar-close"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        >
          <Icon name="close" />
        </button>
        <a
          href="#overview"
          className="brand"
          onClick={() => navigate("overview")}
        >
          <span className="brand-mark">
            <Icon name="layers" size={20} />
          </span>
          <span className="brand-name">
            hacklab<span className="brand-subtitle">Research workspace</span>
          </span>
        </a>
        <div className="workspace-picker">
          <span className="workspace-icon">
            <Icon name="terminal" size={13} />
          </span>
          <span>Small-model lab</span>
          <Icon name="chevron" size={11} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="main-nav">
          {nav.map((item) => (
            <button
              className={`nav-item ${view === item.id ? "active" : ""}`}
              key={item.id}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => navigate(item.id)}
            >
              <Icon name={item.icon} size={17} />
              {item.label}
              {item.id === "feedback" && !!overview?.failures.length && (
                <span className="nav-count">{overview.failures.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-note">
          <div className="sidebar-note-title">
            <Icon name="spark" size={13} />
            Better, one change at a time.
          </div>
          <p>
            Measure the result.
            <br />
            Keep what earns its place.
          </p>
        </div>
        <div className="local-workspace">
          <div className="workspace-avatar">H</div>
          <div>
            <strong>Local workspace</strong>
            <small>Development · read only</small>
          </div>
          <Icon name="shield" size={14} />
        </div>
      </aside>
      <div className="main-shell" inert={menuOpen}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button menu-toggle"
              aria-label="Open navigation"
              aria-controls="workspace-navigation"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <Icon name="menu" size={18} />
            </button>
            <span>Workspace</span>
            <Icon name="chevron" size={10} />
            <strong>{nav.find((item) => item.id === view)?.label}</strong>
          </div>
          <div className="topbar-right">
            <span className="connection-status">
              <span className={`status-dot ${error ? "offline" : ""}`} />
              {error
                ? "Connection interrupted"
                : busy && !overview
                  ? "Connecting locally"
                  : "Local connection"}
            </span>
            <span className="read-only">Read only</span>
          </div>
        </header>
        <main id="main" className="content">
          <div className="page-header">
            <div>
              <p className="eyebrow">SMALL MODELS. THOUGHTFUL EXPERIMENTS.</p>
              <h1>{pageTitle}</h1>
              <p className="page-description">
                {view === "overview"
                  ? "Your agent’s progress, backed by real runs and honest numbers."
                  : view === "runs"
                    ? "Trace the calls, cost and outcome behind each recorded task."
                    : view === "knowledge"
                      ? "Explore the structure. Open the source. Keep every distinct thought."
                      : "Turn measured failures into the next focused experiment."}
              </p>
            </div>
            <div className="header-actions">
              <button
                className={`button ${busy ? "refreshing" : ""}`}
                disabled={busy}
                onClick={() => setRefreshIndex((value) => value + 1)}
                aria-label="Refresh local statistics"
              >
                <Icon name="refresh" size={13} />
                <span>{busy ? "Refreshing" : "Refresh"}</span>
              </button>
            </div>
          </div>
          {error && (
            <div className="alert" role="alert">
              <Icon name="warning" size={17} />
              <p>
                <strong>Couldn’t refresh the workspace.</strong>
                <br />
                {error}
                {overview
                  ? " Previously loaded statistics remain visible."
                  : " Check that the local dashboard server is running."}
              </p>
              <button
                disabled={busy}
                onClick={() => setRefreshIndex((value) => value + 1)}
              >
                Retry
              </button>
            </div>
          )}
          {view === "knowledge" && (
            <Knowledge
              refreshIndex={refreshIndex}
              onNode={(node, document) => setSelectedNode({ node, document })}
            />
          )}
          {overview && (
            <>
              {view === "overview" && (
                <>
                  <div className="campaign-strip">
                    <span className="campaign-icon">
                      <Icon name="spark" size={15} />
                    </span>
                    <div className="strip-text">
                      <strong>
                        {campaign
                          ? "A measured path to a better agent"
                          : "Ready for the next small improvement"}
                      </strong>
                      <span className="separator">·</span>
                      <span className="strip-secondary">
                        {campaign
                          ? `${campaign.status.replaceAll("_", " ")} campaign · ${campaign.championTasks} champion tasks`
                          : "Start a campaign in the CLI to follow its progress here."}
                      </span>
                    </div>
                    {campaign && (
                      <button onClick={() => openCampaign(campaign.id)}>
                        View campaign <Icon name="arrow" size={12} />
                      </button>
                    )}
                  </div>
                  <div className="metrics-grid">
                    <Metric
                      label={
                        campaign?.championAccuracy !== null && campaign
                          ? "Champion accuracy"
                          : "Latest daily accuracy"
                      }
                      value={percentage(latestAccuracy)}
                      note={
                        latestAccuracy === null
                          ? "Waiting for scored benchmark data"
                          : campaign?.championAccuracy !== null && campaign
                            ? `${campaign.championTasks} tasks in the champion evaluation`
                            : "Only tasks with a recorded score"
                      }
                      icon="target"
                    />
                    <Metric
                      label="Estimated total cost"
                      value={money(totals!.costUsd)}
                      note={
                        totals!.costUsd === null
                          ? costNote(totals!)
                          : "Reported usage × configured prices"
                      }
                      icon="coin"
                      warning={totals!.costUsd === null}
                    />
                    <Metric
                      label="Provider calls"
                      value={integer(totals!.calls)}
                      note={`Across ${integer(totals!.runs)} recorded task runs`}
                      icon="layers"
                    />
                    <Metric
                      label="Input / output tokens"
                      value={
                        <>
                          {compact(totals!.inputTokens)}
                          <span className="unit">
                            {" "}
                            / {compact(totals!.outputTokens)}
                          </span>
                        </>
                      }
                      note="Provider-reported · includes cache replays"
                      icon="tokens"
                    />
                  </div>
                  <div className="middle-grid">
                    <Trends overview={overview} />
                    <CampaignPanel
                      campaign={campaign}
                      trials={currentTrials}
                      onTrial={setSelectedTrial}
                      onCampaign={openCampaign}
                    />
                  </div>
                  <div className="section-heading">
                    <div>
                      <h2>Recent runs</h2>
                      <p>A closer look at the work behind the numbers.</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => navigate("runs")}
                    >
                      View all runs <Icon name="arrow" size={12} />
                    </button>
                  </div>
                  <RunsTable
                    data={runs}
                    page={page}
                    setPage={setPage}
                    onRun={setSelectedRun}
                    compact
                  />
                </>
              )}
              {view === "runs" && (
                <>
                  <div className="section-heading">
                    <div>
                      <h2>
                        Task runs{" "}
                        <span className="badge neutral">
                          {integer(runs.total)}
                        </span>
                      </h2>
                      <p>
                        Scores and costs can be unknown. They are never filled
                        in.
                      </p>
                    </div>
                  </div>
                  <RunsTable
                    data={runs}
                    page={page}
                    setPage={setPage}
                    onRun={setSelectedRun}
                  />
                </>
              )}
              {view === "feedback" && (
                <Feedback
                  failures={overview.failures}
                  unknown={overview.totals.unknownCostCalls}
                  campaignId={campaign?.id ?? null}
                  refreshIndex={refreshIndex}
                  onTrial={setSelectedTrial}
                />
              )}
              <div className="bottom-note">
                <Icon name="shield" size={11} />
                Development statistics only · no model calls from this page ·
                updated {dateLabel(overview.updatedAt, true)}
              </div>
            </>
          )}
          {!overview && !error && view !== "knowledge" && (
            <div aria-label="Loading statistics" role="status">
              <div className="metrics-grid">
                {[1, 2, 3, 4].map((i) => (
                  <div className="metric-card" key={i}>
                    <span className="skeleton short" />
                    <span className="skeleton wide" />
                    <span className="skeleton short" />
                  </div>
                ))}
              </div>
              <div className="panel">
                <Empty title="Connecting to your workspace" icon="activity">
                  Reading local run statistics. Nothing is sent to a model.
                </Empty>
              </div>
            </div>
          )}
          <span className="sr-only" role="status" aria-live="polite">
            {busy
              ? "Refreshing statistics"
              : error
                ? "Refresh failed"
                : "Statistics updated"}
          </span>
        </main>
      </div>
      {selectedRun && (
        <DetailDialog
          title={selectedRun.taskId || "Task run"}
          onClose={() => setSelectedRun(null)}
        >
          <RunDetail run={selectedRun} />
        </DetailDialog>
      )}
      {selectedTrial && (
        <DetailDialog
          title={`Candidate · iteration ${selectedTrial.iteration}`}
          onClose={() => setSelectedTrial(null)}
        >
          <TrialDetail trial={selectedTrial} />
        </DetailDialog>
      )}
      {selectedNode && (
        <DetailDialog
          title="Original thought & source"
          onClose={() => setSelectedNode(null)}
        >
          <KnowledgeNodeDetail
            key={selectedNode.node.id}
            node={selectedNode.node}
            document={selectedNode.document}
          />
        </DetailDialog>
      )}
      {(campaignDetail || campaignLoading || campaignError) && (
        <DetailDialog
          title="Campaign evidence"
          wide
          onClose={() => {
            detailController.current?.abort();
            setCampaignDetail(null);
            setCampaignLoading(false);
            setCampaignError(null);
          }}
        >
          {campaignLoading ? (
            <Empty title="Loading campaign" icon="clock">
              Reading the recorded candidate history.
            </Empty>
          ) : campaignError ? (
            <div className="alert" role="alert">
              {campaignError}
            </div>
          ) : (
            campaignDetail && (
              <>
                <Badge status={campaignDetail.campaign.status} />
                <p className="dialog-id">{campaignDetail.campaign.id}</p>
                <dl className="detail-grid">
                  <div>
                    <dt>Budget</dt>
                    <dd>{money(campaignDetail.campaign.budgetUsd, 2)}</dd>
                  </div>
                  <div>
                    <dt>Spent</dt>
                    <dd>{money(campaignDetail.campaign.spentUsd)}</dd>
                  </div>
                  <div>
                    <dt>Champion accuracy</dt>
                    <dd>
                      {percentage(campaignDetail.campaign.championAccuracy)}
                    </dd>
                  </div>
                </dl>
                <TrialLearningCharts
                  trials={campaignDetail.trials}
                  onTrial={(trial) => {
                    setCampaignDetail(null);
                    setSelectedTrial(trial);
                  }}
                />
                <div className="timeline">
                  {campaignDetail.trials.length ? (
                    campaignDetail.trials.map((trial) => (
                      <div className="timeline-item" key={trial.id}>
                        <span
                          className={`timeline-marker ${trial.accepted ? "accepted" : trial.accepted === false ? "rejected" : ""}`}
                        />
                        <button
                          className="timeline-button"
                          onClick={() => {
                            setCampaignDetail(null);
                            setSelectedTrial(trial);
                          }}
                        >
                          <span className="timeline-title">
                            <span>{trialLabel(trial)}</span>
                            <Badge
                              status={
                                trial.accepted === true
                                  ? "accepted"
                                  : trial.accepted === false
                                    ? "rejected"
                                    : trial.status
                              }
                            />
                          </span>
                          <span className="timeline-reason">
                            {trial.hypothesis || trial.reason}
                          </span>
                          <span className="timeline-meta">
                            {percentage(trial.accuracy)} ·{" "}
                            {money(trial.costUsd)}
                          </span>
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="dialog-description">
                      No candidate trials recorded yet.
                    </p>
                  )}
                </div>
                <details>
                  <summary>Champion configuration</summary>
                  <pre>
                    {JSON.stringify(
                      campaignDetail.campaign.championConfig,
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <p className="dialog-footnote">
                  {campaigns.length} campaigns recorded in this workspace.
                  Campaign execution is controlled from the CLI.
                </p>
              </>
            )
          )}
        </DetailDialog>
      )}
    </div>
  );
}

class DashboardBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="content">
          <div className="panel">
            <Empty title="The workspace couldn’t render" icon="warning">
              The API response may not match this dashboard version. Refresh the
              page after checking the local server.
            </Empty>
            <div style={{ textAlign: "center", paddingBottom: 24 }}>
              <button
                className="button"
                onClick={() => window.location.reload()}
              >
                Reload workspace
              </button>
            </div>
          </div>
        </main>
      );
    return this.props.children;
  }
}

export default function App() {
  return (
    <DashboardBoundary>
      <Dashboard />
    </DashboardBoundary>
  );
}
