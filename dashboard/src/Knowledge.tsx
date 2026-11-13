import { useEffect, useMemo, useState } from "react";
import type {
  StateDocument,
  StateFile,
  StateFileKind,
  StateInventory,
  StateNode,
} from "./types";

function Glyph({
  kind,
  size = 16,
}: {
  kind: "file" | "tree" | "search" | "arrow" | "warning";
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "file" ? (
        <>
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <path d="M14 3v6h6M8 13h8m-8 4h6" />
        </>
      ) : kind === "tree" ? (
        <>
          <rect x="9" y="3" width="6" height="5" rx="1" />
          <path d="M12 8v4M5 16v-4h14v4" />
          <rect x="2" y="16" width="6" height="5" rx="1" />
          <rect x="16" y="16" width="6" height="5" rx="1" />
        </>
      ) : kind === "search" ? (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 5 5" />
        </>
      ) : kind === "arrow" ? (
        <path d="M5 12h14m-5-5 5 5-5 5" />
      ) : (
        <>
          <path d="m12 3 10 18H2zM12 9v5m0 3h.01" />
        </>
      )}
    </svg>
  );
}

export function filterFiles(files: StateFile[], query: string, kind: string) {
  return files.filter(
    (file) =>
      (kind === "all" || file.kind === kind) &&
      file.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
}
function fileSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}
function formatName(kind: StateFileKind) {
  return {
    markdown: "MD",
    text: "TXT",
    log: "LOG",
    json: "JSON",
    jsonl: "JSONL",
  }[kind];
}

async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal,
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "This file is no longer available in the allowed state roots."
        : `The local state API returned HTTP ${response.status}.`,
    );
  return response.json() as Promise<T>;
}

/** Canonical nodes remain ordered by their first source occurrence. */
export function layoutNodes(
  document: StateDocument,
): { node: StateNode; depth: number; top: number }[] {
  const firstLines = new Map(
    document.nodes.map((node) => {
      let first = Infinity;
      for (const occurrence of node.occurrences)
        first = Math.min(first, occurrence.line);
      return [node.id, first] as const;
    }),
  );
  const nodes = [...document.nodes].sort(
    (a, b) => firstLines.get(a.id)! - firstLines.get(b.id)!,
  );
  const parents = new Map<string, string>();
  document.edges
    .filter((edge) => edge.type === "contains")
    .forEach((edge) => {
      if (!parents.has(edge.to)) parents.set(edge.to, edge.from);
    });
  return nodes.map((node, index) => {
    let depth = 0,
      id = node.id;
    const seen = new Set([id]);
    while (parents.has(id)) {
      const parent = parents.get(id)!;
      if (seen.has(parent)) break;
      seen.add(parent);
      depth++;
      id = parent;
    }
    return { node, depth, top: index * 112 + 22 };
  });
}

export function KnowledgeGraph({
  document,
  onNode,
}: {
  document: StateDocument;
  onNode: (node: StateNode) => void;
}) {
  const layout = useMemo(() => layoutNodes(document), [document]);
  const byId = new Map(layout.map((item) => [item.node.id, item]));
  const height = Math.max(250, layout.length * 112 + 20);
  if (!layout.length)
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <Glyph kind="file" size={20} />
        </div>
        <h3>No content blocks to map</h3>
        <p>This file is empty or contains no readable blocks.</p>
      </div>
    );
  return (
    <div
      className="knowledge-canvas"
      aria-label="Source-ordered knowledge graph"
    >
      <div className="knowledge-graph" style={{ height }}>
        <svg
          className="knowledge-edges"
          width="100%"
          height={height}
          aria-hidden="true"
        >
          <line
            x1="25"
            y1="37"
            x2="25"
            y2={height - 60}
            stroke="#e3e9db"
            strokeWidth="1.5"
          />
          {layout.map(({ node, depth, top }) => (
            <g key={`trunk-${node.id}`}>
              <circle
                cx="25"
                cy={top + 39}
                r={node.kind === "heading" ? 4 : 2.5}
                fill={node.kind === "heading" ? "#849e6c" : "#c2cfb5"}
              />
              <path
                d={`M 25 ${top + 39} H ${53 + Math.min(depth, 3) * 22}`}
                stroke="#d8e2cd"
                fill="none"
              />
            </g>
          ))}
          {document.edges
            .filter((edge) => edge.type === "contains")
            .map((edge, index) => {
              const from = byId.get(edge.from),
                to = byId.get(edge.to);
              if (!from || !to || from.node.id === to.node.id) return null;
              const x = 40 + Math.min(from.depth, 3) * 22;
              return (
                <path
                  key={`${edge.from}-${edge.to}-${index}`}
                  d={`M ${x + 14} ${from.top + 69} H ${x} V ${to.top + 39} H ${53 + Math.min(to.depth, 3) * 22}`}
                  stroke="#b5c9a2"
                  strokeWidth="1.2"
                  fill="none"
                  opacity=".7"
                />
              );
            })}
        </svg>
        {layout.map(({ node, depth, top }) => (
          <button
            key={node.id}
            className={`knowledge-node ${node.kind === "heading" ? "heading-node" : ""}`}
            style={{ top, left: 53 + Math.min(depth, 3) * 22, right: 22 }}
            onClick={() => onNode(node)}
            aria-label={`Open ${node.kind}: ${node.label}. ${node.occurrences.length} source occurrences.`}
          >
            <span className="knowledge-node-top">
              <span className="knowledge-kind">
                {node.kind === "heading"
                  ? "Section"
                  : node.kind === "log"
                    ? "Log entry"
                    : node.kind === "json"
                      ? "Structured state"
                      : "Thought / paragraph"}
              </span>
              {node.occurrences.length > 1 && (
                <span className="repeat-badge">
                  ×{node.occurrences.length} exact matches
                </span>
              )}
              <span className="node-chevron">
                <Glyph kind="arrow" size={12} />
              </span>
            </span>
            <span className="knowledge-node-label">
              {node.label || "Untitled block"}
            </span>
            <span className="knowledge-node-meta">
              <span>
                Line {node.occurrences[0]?.line ?? "unknown"}
                {node.occurrences.length > 1
                  ? ` + ${node.occurrences.length - 1} more`
                  : ""}
              </span>
              {node.occurrences[0]?.timestamp && (
                <span className="timestamp-badge">
                  {node.occurrences[0].timestamp}
                </span>
              )}
              {depth > 0 && <span className="node-depth">Depth {depth}</span>}
            </span>
          </button>
        ))}
      </div>
      <p className="graph-end">
        End of{" "}
        {document.truncated ? "the visible excerpt" : "the recorded content"} ·{" "}
        {document.nodes.length} shown / {document.metrics.uniqueBlocks} distinct
        blocks read
      </p>
    </div>
  );
}

export function KnowledgeNodeDetail({
  node,
  document,
}: {
  node: StateNode;
  document: StateDocument;
}) {
  const [page, setPage] = useState(0);
  const count = 40;
  const occurrences = node.occurrences.slice(page * count, (page + 1) * count);
  return (
    <div className="knowledge-detail">
      <p className="dialog-id">
        {document.title} · {node.kind}
      </p>
      <div className="knowledge-detail-note">
        <Glyph kind="file" size={13} />
        First original block; all source occurrences below. Sensitive values are
        redacted by the server. No model summary.
      </div>
      <pre className="knowledge-source">{node.text}</pre>
      <div className="source-occurrences">
        <h3>
          Source occurrences <span>{node.occurrences.length}</span>
        </h3>
        <p>
          Exact duplicates share one card. Every retained position stays
          inspectable.
        </p>
        <ol start={page * count + 1}>
          {occurrences.map((occurrence, index) => (
            <li key={`${occurrence.line}-${index}`}>
              <strong>Line {occurrence.line}</strong>
              <span>{occurrence.timestamp ?? "No timestamp in source"}</span>
            </li>
          ))}
        </ol>
        {node.occurrences.length > count && (
          <div className="pagination">
            <span>
              {page * count + 1}–
              {Math.min((page + 1) * count, node.occurrences.length)} of{" "}
              {node.occurrences.length}
            </span>
            <div className="pagination-controls">
              <button
                className="button"
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous
              </button>
              <button
                className="button"
                disabled={(page + 1) * count >= node.occurrences.length}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
      {document.truncated && (
        <p className="dialog-warning">
          This document is an explicitly limited excerpt. Content beyond its
          read or node limit is not represented.
        </p>
      )}
    </div>
  );
}

export default function Knowledge({
  refreshIndex,
  onNode,
}: {
  refreshIndex: number;
  onNode: (node: StateNode, document: StateDocument) => void;
}) {
  const [inventory, setInventory] = useState<StateInventory | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [document, setDocument] = useState<StateDocument | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    read<StateInventory>("/api/state", controller.signal)
      .then((data) => {
        if (!Array.isArray(data.files) || !data.limits)
          throw new Error("The state API returned an unexpected inventory.");
        setInventory(data);
        setError(null);
        setSelected((previous) =>
          previous && data.files.some((file) => file.id === previous)
            ? previous
            : (data.files[0]?.id ?? null),
        );
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not read the state inventory.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshIndex, retry]);
  useEffect(() => {
    if (!selected) {
      setDocument(null);
      return;
    }
    const controller = new AbortController();
    setDocument((previous) => (previous?.id === selected ? previous : null));
    setDocumentError(null);
    read<StateDocument>(
      `/api/state/document?id=${encodeURIComponent(selected)}`,
      controller.signal,
    )
      .then((data) => {
        if (
          !Array.isArray(data.nodes) ||
          !Array.isArray(data.edges) ||
          !data.metrics
        )
          throw new Error("The state API returned an unexpected document.");
        setDocument(data);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setDocumentError(
            cause instanceof Error
              ? cause.message
              : "Could not read this document.",
          );
      });
    return () => controller.abort();
  }, [selected, refreshIndex, retry]);
  const files = filterFiles(inventory?.files ?? [], query, kind);
  return (
    <>
      <div className="knowledge-principles">
        <span>
          <Glyph kind="tree" size={13} />
          Structure, without losing the thought
        </span>
        <span>Exact matches grouped</span>
        <span>Original text one click away</span>
      </div>
      {error && (
        <div className="alert" role="alert">
          <Glyph kind="warning" />
          <p>{error}</p>
          <button onClick={() => setRetry((value) => value + 1)}>Retry</button>
        </div>
      )}
      {inventory?.truncated && (
        <div className="alert" role="status">
          <Glyph kind="warning" />
          <p>
            The file inventory reached its limit: up to{" "}
            {inventory.limits.maxFiles} files within {inventory.limits.maxDepth}{" "}
            directory levels. Other files are not shown.
          </p>
        </div>
      )}
      <div className="knowledge-workspace">
        <section className="panel knowledge-files" aria-label="Knowledge files">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">Knowledge files</h2>
              <p className="panel-subtitle">
                Allowed research & experiment roots
              </p>
            </div>
            <span className="badge neutral">
              {inventory?.files.length ?? "…"}
            </span>
          </div>
          <div className="knowledge-file-filters">
            <label className="search-field">
              <Glyph kind="search" size={13} />
              <span className="sr-only">Search knowledge filenames</span>
              <input
                placeholder="Find a file…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <select
              className="quiet-select"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              aria-label="Knowledge file format"
            >
              <option value="all">All formats</option>
              <option value="markdown">Markdown</option>
              <option value="text">Text</option>
              <option value="log">Logs</option>
              <option value="json">JSON</option>
              <option value="jsonl">JSONL</option>
            </select>
          </div>
          <div className="knowledge-file-list" aria-busy={loading}>
            {loading ? (
              <div className="empty-state">
                <p>Reading allowed files…</p>
              </div>
            ) : files.length ? (
              files.map((file) => (
                <button
                  key={file.id}
                  className={`knowledge-file ${selected === file.id ? "selected" : ""}`}
                  onClick={() => setSelected(file.id)}
                  aria-pressed={selected === file.id}
                >
                  <span className={`file-format ${file.kind}`}>
                    {formatName(file.kind)}
                  </span>
                  <span className="knowledge-file-info">
                    <strong>{file.name.split("/").pop()}</strong>
                    <span>
                      {file.name.split("/").slice(0, -1).join("/") ||
                        "Research"}
                    </span>
                    <small>{fileSize(file.bytes)}</small>
                  </span>
                </button>
              ))
            ) : (
              <div className="empty-state">
                <h3>
                  {inventory?.files.length
                    ? "No matching files"
                    : "Nothing mapped yet"}
                </h3>
                <p>
                  {inventory?.files.length
                    ? "Try another filename or format."
                    : "Research documents and optimization state will appear here when they exist."}
                </p>
              </div>
            )}
          </div>
          <div className="knowledge-files-note">
            <Glyph kind="file" size={12} />
            Local files only. No model calls.
          </div>
        </section>
        <section
          className="panel knowledge-document"
          aria-label="Selected knowledge document"
        >
          {document ? (
            <>
              {documentError && (
                <div className="knowledge-caveat limited" role="alert">
                  <Glyph kind="warning" size={13} />
                  <span>
                    Could not refresh this map. Previously read content remains
                    visible. {documentError}
                  </span>
                </div>
              )}
              <div className="knowledge-document-header">
                <div>
                  <p className="eyebrow">
                    {formatName(document.kind)} · CONTENT MAP
                  </p>
                  <h2>{document.title.split("/").pop()}</h2>
                  <p>
                    {document.metrics.lines} lines read ·{" "}
                    {document.metrics.uniqueBlocks} distinct blocks ·{" "}
                    {document.metrics.duplicateBlocks} repeated blocks grouped
                  </p>
                </div>
                <span className="knowledge-view-badge">
                  <Glyph kind="tree" size={13} />
                  Source flow
                </span>
              </div>
              {(document.truncated || document.metrics.redactions > 0) && (
                <div
                  className={`knowledge-caveat ${document.truncated ? "limited" : ""}`}
                  role="status"
                >
                  <Glyph kind="warning" size={13} />
                  <span>
                    {document.truncated
                      ? `Limited excerpt: up to ${inventory?.limits.maxReadBytes ?? "the configured number of"} bytes, ${inventory?.limits.maxNodes ?? "the configured number of"} nodes and ${inventory?.limits.maxEdges ?? "the configured number of"} edges. Omitted content is not represented. `
                      : ""}
                    {document.metrics.redactions > 0
                      ? `${document.metrics.redactions} sensitive values redacted. `
                      : ""}
                    The graphic is not a summary; open a node to inspect its
                    source.
                  </span>
                </div>
              )}
              <div className="knowledge-legend">
                <span>
                  <i className="legend-section" />
                  Section hierarchy
                </span>
                <span>
                  <i className="legend-next" />
                  First-occurrence source order
                </span>
                <span>Repeated entries retain all timestamps in details</span>
              </div>
              <KnowledgeGraph
                document={document}
                onNode={(node) => onNode(node, document)}
              />
            </>
          ) : documentError ? (
            <div className="empty-state">
              <div className="empty-icon">
                <Glyph kind="warning" size={20} />
              </div>
              <h3>Couldn’t open this file</h3>
              <p>{documentError}</p>
              <button
                className="button"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry
              </button>
            </div>
          ) : selected ? (
            <div className="empty-state" role="status">
              <div className="empty-icon">
                <Glyph kind="tree" size={20} />
              </div>
              <h3>Drawing the content map</h3>
              <p>
                Grouping exact repetitions and retaining the source positions.
              </p>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">
                <Glyph kind="tree" size={22} />
              </div>
              <h3>A clearer view of the same knowledge</h3>
              <p>
                Select a file to see its structure. Paragraphs and log entries
                stay intact behind each node.
              </p>
            </div>
          )}
        </section>
      </div>
      <p className="knowledge-footnote">
        Deterministic display only · no fuzzy merging, rewritten claims or
        inferred relationships · contains edges follow source sections; repeated
        cards appear at their first occurrence
      </p>
    </>
  );
}
