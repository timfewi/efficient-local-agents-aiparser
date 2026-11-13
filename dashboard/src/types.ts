export interface Totals {
  runs: number;
  calls: number;
  costUsd: number | null;
  knownCostUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
  unknownCostCalls: number;
  /** Uncertain measurement records, not observed provider requests. */
  unobservedAttempts: number;
}

export interface Run {
  id: string;
  taskId: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  mode: string;
  workflow: string;
  model: string;
  score: number | null;
  calls: number;
  costUsd: number | null;
  knownCostUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
  unknownCostCalls: number;
  latencyMs: number;
  cacheHits: number;
  stages: {
    analyst: number;
    responder: number;
    optimizerAnalyst: number;
    jev: number;
    loop: number;
  };
}

export interface Campaign {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  budgetUsd: number;
  spentUsd: number;
  spendComplete: boolean;
  maxIterations: number;
  championAccuracy: number | null;
  championCostUsd: number | null;
  championCalls: number;
  championTasks: number;
  championConfig: Record<string, unknown>;
}

export interface Trial {
  id: number;
  campaignId: string;
  iteration: number;
  createdAt: string;
  status: string;
  accepted: boolean | null;
  reason: string;
  hypothesis: string;
  accuracy: number | null;
  costUsd: number | null;
  knownCostUsd: number;
  calls: number;
  tasks: number;
  unknownCostCalls: number;
  config: Record<string, unknown>;
  change: { field: string; value: string | number | boolean } | null;
  phase: "baseline" | "tuning" | "holdout" | "unknown";
  uncertainExternalAttempt: boolean;
  failedChecks: Partial<
    Record<
      | "status"
      | "exact_answer"
      | "answer_set"
      | "actions"
      | "contains"
      | "excludes"
      | "required_documents"
      | "grounded_quotes",
      number
    >
  >;
}

export interface TrendPoint {
  date: string;
  runs: number;
  calls: number;
  costUsd: number | null;
  knownCostUsd: number;
  accuracy: number | null;
}

export interface Failure {
  code: string;
  count: number;
  stage: string | null;
}
export interface Overview {
  updatedAt: string;
  totals: Totals;
  latestCampaign: Campaign | null;
  recentTrials: Trial[];
  trend: TrendPoint[];
  failures: Failure[];
}
export interface RunsResponse {
  items: Run[];
  total: number;
  limit: number;
  offset: number;
}
export interface CampaignsResponse {
  items: Campaign[];
}
export interface CampaignDetail {
  campaign: Campaign;
  trials: Trial[];
}
export interface HttpError {
  error: string;
}

export type StateFileKind = "markdown" | "log" | "text" | "json" | "jsonl";
export interface StateFile {
  id: string;
  name: string;
  kind: StateFileKind;
  bytes: number;
  updatedAt: string;
}
export interface StateInventory {
  files: StateFile[];
  truncated: boolean;
  limits: {
    maxFiles: number;
    maxDepth: number;
    maxReadBytes: number;
    maxNodes: number;
    maxEdges: number;
  };
}
export interface StateNode {
  id: string;
  label: string;
  text: string;
  kind: "heading" | "paragraph" | "log" | "json";
  occurrences: { line: number; timestamp?: string }[];
}
export interface StateDocument {
  id: string;
  title: string;
  kind: StateFileKind;
  nodes: StateNode[];
  edges: { from: string; to: string; type: "contains" | "next" }[];
  metrics: {
    lines: number;
    blocks: number;
    uniqueBlocks: number;
    duplicateBlocks: number;
    redactions: number;
  };
  truncated: boolean;
}
