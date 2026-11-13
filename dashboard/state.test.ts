import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi, TelemetryStore } from "./api";
import { STATE_LIMITS, StateError, StateExplorer } from "./state";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hacklab-state-test-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "experiments");
  const docs = join(directory, "research");
  const outside = join(directory, "outside");
  for (const path of [root, docs, outside]) mkdirSync(path);
  const explorer = new StateExplorer([
    { name: "experiments", path: root },
    { name: "research", path: docs },
  ]);
  const write = (name: string, text: string | Uint8Array) => {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  const document = (name: string) => {
    const entry = explorer
      .inventory()
      .files.find((file) => file.name === `experiments/${name}`);
    if (!entry) throw new Error("missing_synthetic_file");
    return explorer.document(entry.id);
  };
  return { directory, root, docs, outside, explorer, write, document };
}

describe("visual knowledge preserves source content", () => {
  test("exact repeated paragraphs share a node with every original line position", () => {
    const lab = fixture();
    lab.write(
      "notes.txt",
      "Count: 2.\n\nCount: 2.\n\nCount: 3.\n\nCount is not 2.\n",
    );
    const graph = lab.document("notes.txt");
    expect(graph.metrics).toMatchObject({
      blocks: 4,
      uniqueBlocks: 3,
      duplicateBlocks: 1,
    });
    expect(graph.nodes[0]!.text).toBe("Count: 2.");
    expect(graph.nodes[0]!.occurrences).toEqual([{ line: 1 }, { line: 3 }]);
    expect(graph.nodes.map((node) => node.text)).toContain("Count: 3.");
    expect(graph.nodes.map((node) => node.text)).toContain("Count is not 2.");
    expect(graph.truncated).toBe(false);
  });

  test("logs strip timestamps only for equality while retaining all timestamps and original first line", () => {
    const lab = fixture();
    const first = "[2026-11-13T01:00:00Z] Worker completed: count=2.";
    lab.write(
      "worker.log",
      `${first}\n[2026-11-13T01:01:00Z] Worker completed: count=2.\n` +
        "[2026-11-13T01:02:00Z] Worker completed: count=3.\n" +
        "[2026-11-13T01:03:00Z] Worker not completed: count=2.\n",
    );
    const graph = lab.document("worker.log");
    expect(graph.metrics).toMatchObject({
      lines: 4,
      blocks: 4,
      uniqueBlocks: 3,
      duplicateBlocks: 1,
    });
    expect(graph.nodes[0]!.text).toBe(first);
    expect(graph.nodes[0]!.occurrences).toEqual([
      { line: 1, timestamp: "[2026-11-13T01:00:00Z]" },
      { line: 2, timestamp: "[2026-11-13T01:01:00Z]" },
    ]);
    expect(graph.nodes.some((node) => node.text.includes("count=3"))).toBe(
      true,
    );
    expect(
      graph.nodes.some((node) => node.text.includes("not completed")),
    ).toBe(true);
  });

  test("markdown headings retain hierarchy and repeated blocks retain each parent", () => {
    const lab = fixture();
    lab.write(
      "incident.md",
      "# Incident\n\nAgents infected: 2.\n\n## Containment\n\nRevoke tokens.\n\nAgents infected: 2.\n",
    );
    const graph = lab.document("incident.md");
    const title = graph.nodes.find((node) => node.text === "# Incident")!;
    const heading = graph.nodes.find((node) => node.text === "## Containment")!;
    const repeated = graph.nodes.find(
      (node) => node.text === "Agents infected: 2.",
    )!;
    expect(graph.edges).toContainEqual({
      from: title.id,
      to: heading.id,
      type: "contains",
    });
    expect(graph.edges).toContainEqual({
      from: title.id,
      to: repeated.id,
      type: "contains",
    });
    expect(graph.edges).toContainEqual({
      from: heading.id,
      to: repeated.id,
      type: "contains",
    });
    expect(repeated.occurrences).toEqual([{ line: 3 }, { line: 9 }]);
    expect(graph.edges.some((edge) => edge.type === "next")).toBe(true);
  });

  test("fenced code and HTML remain complete inert text, not headings or actions", () => {
    const lab = fixture();
    lab.write(
      "code.md",
      "# Report\n\n```text\n# not a heading\n<script>not executed</script>\n```\n",
    );
    const graph = lab.document("code.md");
    expect(graph.nodes.filter((node) => node.kind === "heading")).toHaveLength(
      1,
    );
    expect(graph.nodes[1]!.text).toBe(
      "```text\n# not a heading\n<script>not executed</script>\n```",
    );
    expect(Object.keys(graph.nodes[1]!)).not.toContain("action");
  });

  test("equal heading titles under different parents never share a result scope", () => {
    const lab = fixture();
    lab.write(
      "runs.md",
      "# Run 1\n## Results\nSuccess\n# Run 2\n## Results\nFailure\n",
    );
    const graph = lab.document("runs.md");
    const headings = graph.nodes.filter((node) => node.kind === "heading");
    expect(headings).toHaveLength(4);
    const [firstRun, firstResults, secondRun, secondResults] = headings;
    expect(firstResults!.text).toBe(secondResults!.text);
    expect(firstResults!.id).not.toBe(secondResults!.id);
    const success = graph.nodes.find((node) => node.text === "Success")!;
    const failure = graph.nodes.find((node) => node.text === "Failure")!;
    const contains = graph.edges.filter((edge) => edge.type === "contains");
    expect(contains).toEqual([
      { from: firstRun!.id, to: firstResults!.id, type: "contains" },
      { from: firstResults!.id, to: success.id, type: "contains" },
      { from: secondRun!.id, to: secondResults!.id, type: "contains" },
      { from: secondResults!.id, to: failure.id, type: "contains" },
    ]);
    expect(graph.metrics).toMatchObject({
      blocks: 6,
      uniqueBlocks: 6,
      duplicateBlocks: 0,
    });
    expect(firstResults!.occurrences).toEqual([{ line: 2 }]);
    expect(secondResults!.occurrences).toEqual([{ line: 5 }]);
  });

  test("JSONL keeps original complete values and changes in numbers stay distinct", () => {
    const lab = fixture();
    const original = '{"status":"ok","count":2}';
    lab.write(
      "state.jsonl",
      `${original}\n${original}\n{"status":"ok","count":3}\n`,
    );
    const graph = lab.document("state.jsonl");
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0]!.text).toBe(original);
    expect(graph.nodes[0]!.label).toContain("status");
    expect(graph.nodes[0]!.occurrences).toHaveLength(2);
    lab.write(
      "state.json",
      '{"result":true,"result":false,"script":"not executed"}',
    );
    const json = lab.document("state.json");
    expect(json.nodes[0]!.text).toContain('"result":true,"result":false');
    expect(json.nodes[0]!.label).toContain("result");
  });

  test("credentials are redacted, and different hidden credential values do not merge", () => {
    const lab = fixture();
    lab.write(
      "values.txt",
      'api_key="synthetic-secret-alpha"\n\napi_key="synthetic-secret-beta"\n\n' +
        "password = synthetic-password\n\ntoken=synthetic-token\n\nhf_abcdefghijklmnop123456\n\nCount: 2.\n",
    );
    const graph = lab.document("values.txt");
    const output = JSON.stringify(graph);
    for (const secret of [
      "synthetic-secret-alpha",
      "synthetic-secret-beta",
      "synthetic-password",
      "synthetic-token",
      "hf_abcdefghijklmnop123456",
    ])
      expect(output).not.toContain(secret);
    expect(graph.nodes[0]!.text).toBe(graph.nodes[1]!.text);
    expect(graph.nodes[0]!.id).not.toBe(graph.nodes[1]!.id);
    expect(graph.metrics.redactions).toBe(5);
    expect(output).toContain("Count: 2.");
  });

  test("authorization headers redact credential tails and preserve neighboring knowledge", () => {
    const lab = fixture();
    const credentials = [
      "eyJzeW50aGV0aWMiOiJvbmx5In0.fakePayload.fakeSignature",
      "c3ludGhldGljLXVzZXI6c3ludGhldGljLXBhc3N3b3Jk",
      "inlineOpaqueJwtValue.fakePayload.fakeSignature",
      "c3ludGhldGljUHJveHlDcmVkZW50aWFsPT0=",
      "quotedSyntheticBearerValue",
      "quotedSyntheticProxyValue",
      "opaqueAuthorizationValue.with.parts",
    ];
    lab.write(
      "authorization.log",
      `Authorization: Bearer ${credentials[0]}\n` +
        `Proxy-Authorization: Basic ${credentials[1]}\n` +
        `request authorization=Bearer ${credentials[2]} status=ok\n` +
        `request Proxy-Authorization=Basic ${credentials[3]} count=2\n` +
        `{"Authorization":"Bearer ${credentials[4]}","count":3,"ok":true}\n` +
        `{"Proxy-Authorization":"Basic ${credentials[5]}","result":"preserved"}\n` +
        `Authorization: ${credentials[6]}\n` +
        "Count is not zero.\n",
    );
    const graph = lab.document("authorization.log");
    const output = JSON.stringify(graph);
    for (const credential of credentials)
      expect(output).not.toContain(credential);
    expect(output).not.toContain("fakeSignature");
    expect(output).not.toContain("fakePayload");
    const text = graph.nodes.map((node) => node.text).join("\n");
    expect(text).toContain("status=ok");
    expect(text).toContain("count=2");
    expect(text).toContain('"count":3,"ok":true');
    expect(text).toContain('"result":"preserved"');
    expect(output).toContain("Count is not zero.");
    expect(graph.metrics.redactions).toBe(credentials.length);
  });

  test("private keys remain redacted across blank blocks and when their end is missing", () => {
    const lab = fixture();
    lab.write(
      "key-notes.txt",
      "Before.\n\n-----BEGIN PRIVATE KEY-----\nSECRET_CHUNK_ONE\n\n" +
        "SECRET_CHUNK_TWO\n-----END PRIVATE KEY-----\n\nAfter.\n\n" +
        "-----BEGIN PRIVATE KEY-----\nSECRET_CHUNK_WITHOUT_END\n",
    );
    const output = JSON.stringify(lab.document("key-notes.txt"));
    expect(output).not.toContain("SECRET_CHUNK");
    expect(output).toContain("Before.");
    expect(output).toContain("After.");
    expect(output).toContain("REDACTED PRIVATE KEY");
  });
});

describe("bounded local state access", () => {
  test("inventory excludes credentials, cache databases, ignored directories and symlinks", () => {
    const lab = fixture();
    lab.write("notes.md", "Visible experiment knowledge.");
    for (const name of [
      ".env",
      "credentials.json",
      "secrets.toml",
      "private.key",
      "cache.sqlite",
      "cache.sqlite-wal",
      "browser/session.txt",
      "node_modules/library/readme.md",
      "trace/raw.txt",
    ]) {
      lab.write(name, "not authorised for the explorer");
    }
    writeFileSync(join(lab.outside, "private.txt"), "OUTSIDE_PRIVATE_SENTINEL");
    symlinkSync(join(lab.outside, "private.txt"), join(lab.root, "linked.txt"));
    symlinkSync(lab.outside, join(lab.root, "linked-directory"));
    expect(lab.explorer.inventory().files.map((file) => file.name)).toEqual([
      "experiments/notes.md",
    ]);
  });

  test("known identifiers cannot traverse paths or follow files swapped into symlinks", () => {
    const lab = fixture();
    const path = lab.write("notes.txt", "Allowed text.");
    const id = lab.explorer.inventory().files[0]!.id;
    expect(() => lab.explorer.document("../../outside/private.txt")).toThrow(
      StateError,
    );
    writeFileSync(join(lab.outside, "private.txt"), "OUTSIDE_PRIVATE_SENTINEL");
    renameSync(path, `${path}.original`);
    symlinkSync(join(lab.outside, "private.txt"), path);
    expect(() => lab.explorer.document(id)).toThrow(StateError);
  });

  test("ancestor symlink swaps and whole-root symlinks are refused", () => {
    const lab = fixture();
    lab.write("nested/notes.txt", "Allowed text.");
    const id = lab.explorer.inventory().files[0]!.id;
    writeFileSync(join(lab.outside, "notes.txt"), "OUTSIDE_PRIVATE_SENTINEL");
    renameSync(join(lab.root, "nested"), join(lab.root, "old-nested"));
    symlinkSync(lab.outside, join(lab.root, "nested"));
    expect(() => lab.explorer.document(id)).toThrow(StateError);
    const rootLink = join(lab.directory, "root-link");
    symlinkSync(lab.outside, rootLink);
    expect(
      new StateExplorer([{ name: "linked", path: rootLink }]).inventory().files,
    ).toEqual([]);
    expect(() => new StateExplorer([{ name: "forbidden", path: "/" }])).toThrow(
      StateError,
    );
  });

  test("malformed UTF-8 and binary data are explicit errors, never replacement text", () => {
    const lab = fixture();
    lab.write("invalid.txt", new Uint8Array([0xff, 0xfe, 0x61]));
    lab.write("binary.txt", new Uint8Array([0x61, 0, 0x62]));
    expect(() => lab.document("invalid.txt")).toThrow(
      "state_document_not_text",
    );
    expect(() => lab.document("binary.txt")).toThrow("state_document_not_text");
  });

  test("read and UTF-8 boundary truncation are explicit", () => {
    const lab = fixture();
    lab.write("large.txt", "a".repeat(STATE_LIMITS.maxReadBytes - 1) + "€tail");
    const graph = lab.document("large.txt");
    expect(graph.truncated).toBe(true);
    expect(graph.nodes[0]!.text).toBe(
      "a".repeat(STATE_LIMITS.maxReadBytes - 1),
    );
    expect(JSON.stringify(graph)).not.toContain("tail");
  });

  test("node limits never miscount omitted unique content as duplicates", () => {
    const lab = fixture();
    lab.write(
      "many.txt",
      Array.from(
        { length: STATE_LIMITS.maxNodes + 1 },
        (_, index) => `Block ${index}.`,
      ).join("\n\n") + "\n\nBlock 0.",
    );
    const graph = lab.document("many.txt");
    expect(graph.nodes).toHaveLength(STATE_LIMITS.maxNodes);
    expect(graph.metrics).toMatchObject({
      blocks: 502,
      uniqueBlocks: 501,
      duplicateBlocks: 1,
    });
    expect(graph.nodes[0]!.occurrences).toHaveLength(2);
    expect(graph.truncated).toBe(true);
  });

  test("edge bounds are explicit while all retained occurrences remain available", () => {
    const lab = fixture();
    const messages = [];
    for (let first = 0; first < 50; first++)
      for (let second = 0; second < 50; second++) {
        messages.push(`Block ${first}.`, `Block ${second}.`);
      }
    lab.write("edges.txt", messages.join("\n\n"));
    const graph = lab.document("edges.txt");
    expect(graph.edges).toHaveLength(STATE_LIMITS.maxEdges);
    expect(
      graph.nodes.reduce((sum, node) => sum + node.occurrences.length, 0),
    ).toBe(messages.length);
    expect(graph.truncated).toBe(true);
  });

  test("inventory stops at 200 files and depth four, with explicit partial coverage", () => {
    const lab = fixture();
    for (let index = 0; index < STATE_LIMITS.maxFiles + 1; index++)
      lab.write(`file-${index}.txt`, "text");
    const inventory = lab.explorer.inventory();
    expect(inventory.files).toHaveLength(200);
    expect(inventory.truncated).toBe(true);
    const deep = fixture();
    deep.write("a/b/c/d/visible.txt", "visible");
    deep.write("a/b/c/d/e/hidden.txt", "beyond the bound");
    const depth = deep.explorer.inventory();
    expect(depth.files.map((file) => file.name)).toEqual([
      "experiments/a/b/c/d/visible.txt",
    ]);
    expect(depth.truncated).toBe(true);
  });

  test("HTTP accepts only previously inventoried opaque IDs and writes no cache or database", async () => {
    const lab = fixture();
    lab.write("notes.md", "# Safe report\n\nFull original block.\n");
    const store = new TelemetryStore(join(lab.directory, "missing.sqlite"));
    const api = createApi(store, lab.explorer);
    try {
      const request = (path: string) =>
        api(new Request(`http://127.0.0.1:3000${path}`))!;
      const inventory = await request("/api/state").json();
      const id = inventory.files[0].id;
      expect(id).toMatch(/^[a-f0-9]{32}$/);
      const graph = await request(`/api/state/document?id=${id}`).json();
      expect(graph.nodes[1].text).toBe("Full original block.");
      expect(request("/api/state/document?id=../../private.txt").status).toBe(
        400,
      );
      expect(request(`/api/state/document?id=${"f".repeat(32)}`).status).toBe(
        404,
      );
      expect(
        request(`/api/state/document?id=${id}&path=/private.txt`).status,
      ).toBe(400);
      expect(request(`/api/state?root=${lab.outside}`).status).toBe(400);
      expect(readdirSync(lab.directory).sort()).toEqual([
        "experiments",
        "outside",
        "research",
      ]);
    } finally {
      store.close();
    }
  });
});
