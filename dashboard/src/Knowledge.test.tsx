import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  filterFiles,
  KnowledgeGraph,
  KnowledgeNodeDetail,
  layoutNodes,
} from "./Knowledge";
import type { StateDocument, StateNode } from "./types";

const nodes: StateNode[] = [
  {
    id: "heading",
    kind: "heading",
    label: "Containment decision",
    text: "# Containment decision",
    occurrences: [{ line: 1 }],
  },
  {
    id: "allow",
    kind: "paragraph",
    label: "Allow agent 17",
    text: "Allow agent 17. Budget: 0.02 USD.",
    occurrences: [{ line: 3 }, { line: 11 }],
  },
  {
    id: "deny",
    kind: "paragraph",
    label: "Do not allow agent 17",
    text: "Do not allow agent 17. Budget: 0.03 USD. <script>unsafe()</script>",
    occurrences: [{ line: 7 }],
  },
];
const document: StateDocument = {
  id: "safe-file-id",
  title: "research/decisions.md",
  kind: "markdown",
  nodes,
  edges: [
    { from: "heading", to: "allow", type: "contains" },
    { from: "heading", to: "deny", type: "contains" },
    { from: "allow", to: "deny", type: "next" },
  ],
  metrics: {
    lines: 11,
    blocks: 4,
    uniqueBlocks: 3,
    duplicateBlocks: 1,
    redactions: 0,
  },
  truncated: false,
};

describe("faithful knowledge presentation", () => {
  test("the graphic keeps negations distinct and shows repeated source occurrences", () => {
    const markup = renderToStaticMarkup(
      <KnowledgeGraph document={document} onNode={() => {}} />,
    );
    expect(markup).toContain("Allow agent 17");
    expect(markup).toContain("Do not allow agent 17");
    expect(markup).toContain("×2 exact matches");
    expect(markup.match(/class="knowledge-node /g)?.length).toBe(3);
  });

  test("details retain distinct values, original content and every source position, as escaped text", () => {
    const allowed = renderToStaticMarkup(
      <KnowledgeNodeDetail node={nodes[1]} document={document} />,
    );
    const denied = renderToStaticMarkup(
      <KnowledgeNodeDetail node={nodes[2]} document={document} />,
    );
    expect(allowed).toContain("Budget: 0.02 USD.");
    expect(allowed).toContain("Line 3");
    expect(allowed).toContain("Line 11");
    expect(denied).toContain("Do not allow agent 17. Budget: 0.03 USD.");
    expect(denied).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
    expect(denied).not.toContain("<script>");
  });

  test("layout follows source position and section hierarchy, without a model summary", () => {
    const layout = layoutNodes({
      ...document,
      nodes: [nodes[2], nodes[0], nodes[1]],
    });
    expect(layout.map((item) => item.node.id)).toEqual([
      "heading",
      "allow",
      "deny",
    ]);
    expect(layout.map((item) => item.depth)).toEqual([0, 1, 1]);
    expect(layout[1].node.text).toBe(nodes[1].text);
  });

  test("a large exact-repeat group retains every occurrence without spreading them into function arguments", () => {
    const occurrences = Array.from({ length: 140_000 }, (_, i) => ({
      line: 140_000 - i,
    }));
    const repeated = { ...nodes[1], occurrences };
    const layout = layoutNodes({
      ...document,
      nodes: [{ ...nodes[2], occurrences: [{ line: 150_000 }] }, repeated],
    });
    expect(layout[0].node.id).toBe(repeated.id);
    expect(layout[0].node.occurrences.length).toBe(140_000);
    expect(layout[0].node.occurrences.at(-1)?.line).toBe(1);
  });

  test("truncated source is visibly identified in original-content details", () => {
    const markup = renderToStaticMarkup(
      <KnowledgeNodeDetail
        node={nodes[0]}
        document={{ ...document, truncated: true }}
      />,
    );
    expect(markup).toContain("explicitly limited excerpt");
    expect(markup).toContain("not represented");
  });

  test("filename and format filters combine without searching or rewriting document bodies", () => {
    const files = [
      {
        id: "a",
        name: "research/decision.md",
        kind: "markdown" as const,
        bytes: 50,
        updatedAt: "2026-11-13T10:00:00Z",
      },
      {
        id: "b",
        name: "experiments/decision.log",
        kind: "log" as const,
        bytes: 50,
        updatedAt: "2026-11-13T10:00:00Z",
      },
    ];
    expect(
      filterFiles(files, " DECISION ", "log").map((file) => file.id),
    ).toEqual(["b"]);
    expect(filterFiles(files, "research", "log")).toEqual([]);
  });
});
