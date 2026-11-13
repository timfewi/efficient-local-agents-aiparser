import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  filterRuns,
  money,
  percentage,
  TrendChart,
  trialSeries,
  TrialLearningCharts,
  GradingChecks,
  costNote,
  TrialDetail,
} from "./App";
import type { Run, TrendPoint, Trial } from "./types";

describe("honest telemetry presentation", () => {
  test("unknown cost and unscored tasks remain distinct from measured zero", () => {
    expect(money(null)).toBe("Unknown");
    expect(money(0)).toBe("$0.00");
    expect(money(0.0007)).toBe("$0.0007");
    expect(money(0.000001)).toBe("<$0.0001");
    expect(money(0, 2)).toBe("$0.00");
    expect(money(0.0003, 2)).toBe("<$0.01");
    expect(percentage(null)).toBe("Unscored");
    expect(percentage(0)).toBe("0.0%");
    expect(percentage(1)).toBe("100.0%");
  });

  test("unknown daily costs are gaps instead of zero-valued measurements", () => {
    const points: TrendPoint[] = [
      {
        date: "2026-11-11",
        runs: 1,
        calls: 1,
        costUsd: 0.01,
        knownCostUsd: 0.01,
        accuracy: 1,
      },
      {
        date: "2026-11-12",
        runs: 1,
        calls: 1,
        costUsd: null,
        knownCostUsd: 0,
        accuracy: null,
      },
      {
        date: "2026-11-13",
        runs: 1,
        calls: 1,
        costUsd: 0,
        knownCostUsd: 0,
        accuracy: 0,
      },
    ];
    const markup = renderToStaticMarkup(
      <TrendChart points={points} metric="cost" />,
    );
    expect(markup.match(/<circle /g)?.length).toBe(2);
    expect(markup).toContain("Missing values are gaps");
    expect(markup).toContain("Nov 12: unknown");
    expect(markup).toContain("Nov 13: $0.00");
  });

  test("a fully unpriced series has an explicit empty state", () => {
    const markup = renderToStaticMarkup(
      <TrendChart
        points={[
          {
            date: "2026-11-13",
            runs: 2,
            calls: 4,
            costUsd: null,
            knownCostUsd: 0.02,
            accuracy: null,
          },
        ]}
        metric="cost"
      />,
    );
    expect(markup).toContain("No fully priced days yet");
    expect(markup).not.toContain("chart-svg");
  });

  test("run filters combine workflow and case-insensitive text on loaded rows", () => {
    const base: Run = {
      id: "run-a",
      taskId: "containment",
      startedAt: "2026-11-13T10:00:00Z",
      finishedAt: null,
      status: "ok",
      mode: "benchmark",
      workflow: "loop",
      model: "test-small-model",
      score: null,
      calls: 0,
      costUsd: null,
      knownCostUsd: 0,
      inputTokens: null,
      outputTokens: null,
      unknownCostCalls: 0,
      latencyMs: 0,
      cacheHits: 0,
      stages: {
        analyst: 0,
        responder: 0,
        optimizerAnalyst: 0,
        jev: 0,
        loop: 0,
      },
    };
    const rows = [
      base,
      { ...base, id: "run-b", taskId: "decode", workflow: "pipeline" },
    ];
    expect(
      filterRuns(rows, " CONTAINMENT ", "all").map((run) => run.id),
    ).toEqual(["run-a"]);
    expect(
      filterRuns(rows, "test-small", "pipeline").map((run) => run.id),
    ).toEqual(["run-b"]);
    expect(filterRuns(rows, "containment", "pipeline")).toEqual([]);
  });
});

describe("learning within a single hackathon day", () => {
  const baseline: Trial = {
    id: 1,
    campaignId: "test-campaign",
    iteration: 0,
    createdAt: "2026-11-14T10:00:00Z",
    status: "baseline",
    accepted: null,
    reason: "baseline",
    hypothesis: "baseline",
    accuracy: 0.75,
    costUsd: 0.02,
    knownCostUsd: 0.02,
    calls: 4,
    tasks: 4,
    unknownCostCalls: 0,
    config: {},
    change: null,
    phase: "baseline",
    uncertainExternalAttempt: false,
    failedChecks: { exact_answer: 1 },
  };
  const trials: Trial[] = [
    baseline,
    {
      ...baseline,
      id: 2,
      iteration: 1,
      createdAt: "2026-11-14T10:01:00Z",
      status: "accepted",
      phase: "tuning",
      accepted: true,
      accuracy: 1,
      costUsd: 0.01,
      knownCostUsd: 0.01,
    },
    {
      ...baseline,
      id: 3,
      iteration: 2,
      createdAt: "2026-11-14T10:02:00Z",
      status: "rejected",
      phase: "tuning",
      accepted: false,
      accuracy: 0.5,
      costUsd: null,
      knownCostUsd: 0.005,
      unknownCostCalls: 1,
    },
  ];

  test("unobserved measurements do not become free requests or fabricated call counts", () => {
    expect(
      costNote({
        runs: 1,
        calls: 0,
        costUsd: null,
        knownCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        unknownCostCalls: 0,
        unobservedAttempts: 1,
      }),
    ).toContain("1 interrupted measurements; requests unobserved");
  });

  test("grading failures are graphical counts without inventing distinct failed-task totals", () => {
    const markup = renderToStaticMarkup(
      <GradingChecks
        trial={{
          ...baseline,
          failedChecks: { exact_answer: 2, actions: 1, status: 0 },
        }}
      />,
    );
    expect(markup).toContain("exact answer");
    expect(markup).toContain("2 / 4");
    expect(markup).toContain("width:50%");
    expect(markup).toContain("can overlap");
  });

  test("same-day baseline and all tested candidates remain separate points", () => {
    const series = trialSeries(trials, "accuracy");
    expect(series.map((point) => point.trial.id)).toEqual([1, 2, 3]);
    expect(series.map((point) => point.value)).toEqual([0.75, 1, 0.5]);
    const markup = renderToStaticMarkup(
      <TrialLearningCharts trials={trials} onTrial={() => {}} />,
    );
    expect(markup).toContain("Baseline: 75%, baseline");
    expect(markup).toContain("Trial 1: 100%, accepted");
    expect(markup).toContain("Trial 2: 50%, rejected");
    expect(markup.match(/data-trial-id="3"/g)?.length).toBe(1);
  });

  test("unknown costs and incomplete evaluations remain gaps, not zero scores", () => {
    expect(trialSeries(trials, "cost").map((point) => point.value)).toEqual([
      0.02,
      0.01,
      null,
    ]);
    const failed: Trial = {
      ...baseline,
      id: 4,
      iteration: 3,
      status: "error",
      accuracy: 0,
      costUsd: 0.1,
    };
    expect(
      trialSeries([...trials, failed], "accuracy").at(-1)?.value,
    ).toBeNull();
    expect(trialSeries([...trials, failed], "cost").at(-1)?.value).toBeNull();
  });

  test("interrupted hold-out details explain the freeze without claiming a provider request or bill", () => {
    const markup = renderToStaticMarkup(
      <TrialDetail
        trial={{
          ...baseline,
          phase: "holdout",
          status: "timed_out",
          uncertainExternalAttempt: true,
          costUsd: null,
          accuracy: null,
        }}
      />,
    );
    expect(markup).toContain("Hold-out evaluation");
    expect(markup).toContain("Its attempt freezes the campaign");
    expect(markup).toContain(
      "does not prove that a request occurred or establish its billed cost",
    );
    const observed = renderToStaticMarkup(<TrialDetail trial={baseline} />);
    expect(observed).not.toContain(
      "external request is possible but unobserved",
    );
  });
});
