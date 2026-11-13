/** Lossless block compaction within explicit limits; reads only operator-selected roots. */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, relative, resolve } from "node:path";

export const STATE_LIMITS = Object.freeze({
  maxFiles: 200,
  maxDepth: 4,
  maxReadBytes: 256 * 1024,
  maxNodes: 500,
  maxEdges: 2000,
});
const MAX_ENTRIES = 2000;
const OMIT_DIRECTORIES = new Set([
  "node_modules",
  "browser",
  "browsers",
  "cache",
  "trace",
  "traces",
  "sessions",
  "credentials",
  "secrets",
]);
const OMIT_EXTENSIONS = new Set([
  ".db",
  ".sqlite",
  ".sqlite3",
  ".wal",
  ".shm",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".der",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".xz",
  ".tar",
  ".7z",
  ".bin",
  ".wasm",
  ".so",
  ".pyc",
  ".exe",
  ".qcow2",
  ".img",
  ".mp4",
]);
const OMIT_NAME =
  /^(?:credentials?|secrets?|passwords?|tokens?|service[-_]account)(?:\.(?:json|txt|toml|ya?ml))?$|^(?:id_rsa|id_ed25519)$|\.(?:db|sqlite3?)(?:-wal|-shm)$/i;
const TIMESTAMP =
  /^(\[?(?:\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?)\]?)([ \t]+)(.*)$/;

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
  limits: typeof STATE_LIMITS;
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
export class StateError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
interface Root {
  name: string;
  path: string;
}
interface KnownFile {
  file: StateFile;
  root: string;
  path: string;
  device: number;
  inode: number;
}

function within(root: string, file: string): boolean {
  const rest = relative(root, file);
  return (
    rest !== "" && rest !== ".." && !rest.startsWith("../") && !isAbsolute(rest)
  );
}
function allowedRoot(path: string): boolean {
  return (
    path !== "/" &&
    path !== "/root" &&
    path !== "/home" &&
    path !== "/Users" &&
    path !== resolve(homedir()) &&
    !/^\/(?:home|Users)\/[^/]+$/.test(path)
  );
}
function kind(name: string): StateFileKind {
  const extension = extname(name).toLowerCase();
  return extension === ".md" || extension === ".markdown"
    ? "markdown"
    : extension === ".log" || extension === ".out"
      ? "log"
      : extension === ".json"
        ? "json"
        : extension === ".jsonl" || extension === ".ndjson"
          ? "jsonl"
          : "text";
}

/** Redaction changes only recognised credential values, never ordinary numbers or negations. */
function redact(
  text: string,
  privateKeyOpen = false,
): { text: string; count: number; privateKeyOpen: boolean } {
  let count = 0;
  const pieces: string[] = [];
  let cursor = 0;
  for (;;) {
    if (privateKeyOpen) {
      const end = /-----END (?:[A-Z ]+ )?PRIVATE KEY-----/.exec(
        text.slice(cursor),
      );
      pieces.push("[REDACTED PRIVATE KEY]");
      count++;
      if (!end) break;
      cursor += end.index + end[0].length;
      privateKeyOpen = false;
    }
    const begin = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.exec(
      text.slice(cursor),
    );
    if (!begin) {
      pieces.push(text.slice(cursor));
      break;
    }
    pieces.push(text.slice(cursor, cursor + begin.index));
    cursor += begin.index;
    privateKeyOpen = true;
  }
  text = pieces.join("");
  const replace = (
    pattern: RegExp,
    replacement: string | ((...matches: string[]) => string),
  ) => {
    text = text.replace(pattern, (...matches) => {
      count++;
      return typeof replacement === "string"
        ? replacement
        : replacement(...matches);
    });
  };
  // An HTTP authorization header's complete value belongs to that header,
  // including schemes with spaced or comma-separated parameters.
  replace(
    /(^[ \t]*(?:proxy-)?authorization[ \t]*:[ \t]*)[^\r\n]+/gim,
    (_all, field) => `${field}[REDACTED]`,
  );
  // Inline log fields and quoted JSON values must retain neighboring facts.
  // Consume the scheme together with token68 credentials, before the generic
  // single-value rule can remove only "Bearer" or "Basic" and expose the tail.
  replace(
    /((?:["']?)(?:proxy-)?authorization(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:(?:basic|bearer|negotiate|ntlm)[ \t]+)?[A-Za-z0-9._~+\/-]+=*)/gi,
    (_all, field) => `${field}[REDACTED]`,
  );
  replace(
    /((?:["']?)(?:api[-_ ]?key|(?:access[-_ ]?|refresh[-_ ]?)?token|password|passwd|credentials?|secret|private[-_ ]?key)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
    (_all, field) => `${field}[REDACTED]`,
  );
  replace(
    /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
    "[REDACTED]",
  );
  replace(/\bBearer[ \t]+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]");
  return { text, count, privateKeyOpen };
}

interface Block {
  text: string;
  line: number;
  kind: StateNode["kind"];
  level?: number;
  timestamp?: string;
  key?: string;
}
function blocks(
  text: string,
  type: StateFileKind,
): { lines: number; items: Block[] } {
  if (!text) return { lines: 0, items: [] };
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const items: Block[] = [];
  const lineMode =
    type === "log" ||
    type === "jsonl" ||
    (type === "text" && lines.some((line) => TIMESTAMP.test(line)));
  if (lineMode) {
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      const timestamp = TIMESTAMP.exec(line);
      items.push({
        text: line,
        line: index + 1,
        kind: type === "jsonl" ? "json" : "log",
        ...(timestamp ? { timestamp: timestamp[1], key: timestamp[3] } : {}),
      });
    });
    return { lines: lines.length, items };
  }
  if (type === "json")
    return { lines: lines.length, items: [{ text, line: 1, kind: "json" }] };
  let start = 0;
  let paragraph: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (paragraph.length)
      items.push({
        text: paragraph.join("\n"),
        line: start + 1,
        kind: "paragraph",
      });
    paragraph = [];
  };
  lines.forEach((line, index) => {
    const marker =
      type === "markdown" ? /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] : undefined;
    if (fence !== null) {
      paragraph.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
        flush();
      }
      return;
    }
    if (marker) {
      flush();
      start = index;
      paragraph.push(line);
      fence = marker;
      return;
    }
    const heading =
      type === "markdown" ? /^ {0,3}(#{1,6})[ \t]+(.+)$/.exec(line) : null;
    if (heading) {
      flush();
      items.push({
        text: line,
        line: index + 1,
        kind: "heading",
        level: heading[1]!.length,
      });
    } else if (!line.trim()) flush();
    else {
      if (!paragraph.length) start = index;
      paragraph.push(line);
    }
  });
  flush();
  return { lines: lines.length, items };
}

function nodeLabel(text: string, type: StateNode["kind"]): string {
  if (type === "json") {
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return (
          Object.keys(value).slice(0, 6).join(" · ").slice(0, 90) ||
          "JSON object"
        );
      }
      if (Array.isArray(value)) return `JSON array · ${value.length} items`;
    } catch {
      /* Malformed JSON remains readable text, never executable input. */
    }
  }
  return (
    text
      .split("\n", 1)[0]!
      .replace(/^\s*#{1,6}\s+/, "")
      .trim()
      .slice(0, 90) || "Text block"
  );
}

function graph(
  file: StateFile,
  text: string,
  truncated: boolean,
): StateDocument {
  const parsed = blocks(text, file.kind);
  const nodes: StateNode[] = [];
  const edges: StateDocument["edges"] = [];
  const known = new Map<string, StateNode | null>();
  const edgeKeys = new Set<string>();
  const headings: { level: number; id: string | null }[] = [];
  let previous: string | null = null;
  let redactions = 0;
  let privateKeyOpen = false;
  const edge = (
    from: string | null | undefined,
    to: string | null,
    type: "contains" | "next",
  ) => {
    if (!from || !to) return;
    const key = `${from}:${to}:${type}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    if (edges.length >= STATE_LIMITS.maxEdges) {
      truncated = true;
      return;
    }
    edges.push({ from, to, type });
  };
  for (const block of parsed.items) {
    // Deduplicate the original content, before redaction. Different secret values never merge.
    // Headings own a source scope. Merging equal titles would connect each
    // parent's heading to the other parent's children and invent knowledge.
    const scope = block.kind === "heading" ? block.line : "";
    const key = `${block.kind}\0${scope}\0${privateKeyOpen}\0${block.key ?? block.text}`;
    const clean = redact(block.text, privateKeyOpen);
    privateKeyOpen = clean.privateKeyOpen;
    redactions += clean.count;
    let node = known.get(key);
    if (!known.has(key)) {
      node =
        nodes.length < STATE_LIMITS.maxNodes
          ? {
              id: `n${nodes.length + 1}`,
              label: nodeLabel(clean.text, block.kind),
              text: clean.text,
              kind: block.kind,
              occurrences: [],
            }
          : null;
      known.set(key, node);
      if (node) nodes.push(node);
      else truncated = true;
    }
    const id = node?.id ?? null;
    if (node)
      node.occurrences.push({
        line: block.line,
        ...(block.timestamp ? { timestamp: block.timestamp } : {}),
      });
    if (block.level !== undefined) {
      while (headings.length && headings.at(-1)!.level >= block.level)
        headings.pop();
      edge(headings.at(-1)?.id, id, "contains");
      headings.push({ level: block.level, id });
    } else edge(headings.at(-1)?.id, id, "contains");
    edge(previous, id, "next");
    previous = id;
  }
  return {
    id: file.id,
    title: file.name,
    kind: file.kind,
    nodes,
    edges,
    metrics: {
      lines: parsed.lines,
      blocks: parsed.items.length,
      uniqueBlocks: known.size,
      duplicateBlocks: parsed.items.length - known.size,
      redactions,
    },
    truncated,
  };
}

function decode(bytes: Uint8Array, truncated: boolean): string {
  for (let trim = 0; trim <= (truncated ? 3 : 0); trim++) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytes.length - trim),
      );
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
        throw new StateError("state_document_not_text", 415);
      return text;
    } catch (error) {
      if (error instanceof StateError) throw error;
    }
  }
  throw new StateError("state_document_not_text", 415);
}

export class StateExplorer {
  private readonly roots: Root[];
  private readonly salt = randomBytes(16);
  private known = new Map<string, KnownFile>();
  constructor(
    roots: Root[] = [
      {
        name: "experiments",
        path:
          process.env.HACKLAB_STATE_ROOT ??
          `${import.meta.dir}/../.state/optimization`,
      },
      {
        name: "research",
        path:
          process.env.HACKLAB_DOCS_ROOT ??
          `${import.meta.dir}/../docs/research`,
      },
    ],
  ) {
    this.roots = roots.map((root) => ({
      name: root.name,
      path: resolve(root.path),
    }));
    if (this.roots.some((root) => !allowedRoot(root.path)))
      throw new StateError("state_root_not_allowed", 400);
  }

  inventory(): StateInventory {
    const files: StateFile[] = [];
    const known = new Map<string, KnownFile>();
    let truncated = false;
    let entries = 0;
    const visit = (root: Root, directory: string, depth: number) => {
      let handle: ReturnType<typeof opendirSync>;
      try {
        handle = opendirSync(directory);
      } catch {
        truncated = true;
        return;
      }
      try {
        for (;;) {
          if (files.length >= STATE_LIMITS.maxFiles || entries >= MAX_ENTRIES) {
            truncated = true;
            break;
          }
          const entry = handle.readSync();
          if (!entry) break;
          entries++;
          const name = entry.name;
          if (
            name.startsWith(".") ||
            OMIT_NAME.test(name) ||
            entry.isSymbolicLink()
          )
            continue;
          const path = resolve(directory, name);
          if (!within(root.path, path)) continue;
          if (entry.isDirectory()) {
            if (OMIT_DIRECTORIES.has(name.toLowerCase())) continue;
            if (depth >= STATE_LIMITS.maxDepth) {
              truncated = true;
              continue;
            }
            // Reject ancestors that became symlinks after enumeration.
            try {
              if (realpathSync(path) !== path) continue;
            } catch {
              continue;
            }
            visit(root, path, depth + 1);
            continue;
          }
          if (
            !entry.isFile() ||
            OMIT_EXTENSIONS.has(extname(name).toLowerCase())
          )
            continue;
          try {
            if (realpathSync(path) !== path) continue;
            const stat = lstatSync(path);
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            const relativeName = `${root.name}/${relative(root.path, path)}`;
            const id = createHash("sha256")
              .update(this.salt)
              .update(relativeName)
              .digest("hex")
              .slice(0, 32);
            const file: StateFile = {
              id,
              name: redact(relativeName).text,
              kind: kind(name),
              bytes: stat.size,
              updatedAt: stat.mtime.toISOString(),
            };
            files.push(file);
            known.set(id, {
              file,
              root: root.path,
              path,
              device: stat.dev,
              inode: stat.ino,
            });
          } catch {
            truncated = true;
          }
        }
      } finally {
        handle.closeSync();
      }
    };
    for (const root of this.roots) {
      try {
        const stat = lstatSync(root.path);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          realpathSync(root.path) !== root.path
        )
          continue;
      } catch {
        continue;
      }
      visit(root, root.path, 0);
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    this.known = known;
    return { files, truncated, limits: STATE_LIMITS };
  }

  document(id: string): StateDocument {
    const known = this.known.get(id);
    if (!known) throw new StateError("state_document_not_found", 404);
    let descriptor: number | null = null;
    try {
      if (
        realpathSync(known.path) !== known.path ||
        !within(known.root, known.path)
      ) {
        throw new StateError("state_document_not_found", 404);
      }
      descriptor = openSync(
        known.path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = fstatSync(descriptor);
      if (
        !stat.isFile() ||
        stat.dev !== known.device ||
        stat.ino !== known.inode
      ) {
        throw new StateError("state_document_changed", 409);
      }
      const buffer = Buffer.alloc(STATE_LIMITS.maxReadBytes);
      let read = 0;
      while (read < buffer.byteLength) {
        const count = readSync(
          descriptor,
          buffer,
          read,
          buffer.byteLength - read,
          read,
        );
        if (!count) break;
        read += count;
      }
      const after = fstatSync(descriptor);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        throw new StateError("state_document_changed", 409);
      }
      const truncated = stat.size > read;
      const bytes = buffer.subarray(0, read);
      return graph(known.file, decode(bytes, truncated), truncated);
    } catch (error) {
      if (error instanceof StateError) throw error;
      throw new StateError("state_document_unavailable", 404);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }
}
