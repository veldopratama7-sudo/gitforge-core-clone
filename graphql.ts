// graphql.ts — a small GraphQL executor for the forge's schema slice: the
// documents gh and github-mcp-server send (viewer, repository, node, issues /
// pull request connections with cursor pagination), __schema / __type
// introspection rendered from the schema model, and the five mutations.
// Unknown fields resolve to null with an error naming the field (HTTP 200).

import { ForgeStore, HttpError, type Issue, type PullRequest } from "./store.ts";
import { parseCommit } from "./gitobj.ts";
import { fromNodeId, nodeId } from "./rest.ts";

interface GqlRequest {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string | null;
}

export interface GqlReply {
  status: number;
  body: unknown;
}

export function handleGraphQL(store: ForgeStore, raw: unknown): GqlReply {
  if (Array.isArray(raw)) {
    const results = raw.map((r) => runOne(store, r as GqlRequest));
    return { status: 200, body: results };
  }
  return runOne(store, raw as GqlRequest);
}

function runOne(store: ForgeStore, req: GqlRequest): GqlReply {
  try {
    const query = String(req.query ?? "");
    const doc = parseQuery(query);
    const out = execute(store, doc, req.variables ?? {});
    return { status: 200, body: out };
  } catch (err) {
    const message = err instanceof Error ? err.message : "bad request";
    return { status: 200, body: { data: null, errors: [{ message }] } };
  }
}

// ---------------- tokenizer / parser ----------------

type Tok =
  | { t: "name"; v: string }
  | { t: "punct"; v: string }
  | { t: "int"; v: number }
  | { t: "float"; v: number }
  | { t: "string"; v: string }
  | { t: "var"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === ",") {
      // commas are insignificant separators in GraphQL
      i++;
      continue;
    }
    if (/[{}()\[\]]|:|=|!|\$|\.|@/.test(c)) {
      if (src.startsWith("...", i)) {
        out.push({ t: "punct", v: "..." });
        i += 3;
        continue;
      }
      out.push({ t: "punct", v: c });
      i++;
      continue;
    }
    if (c === '"' || c === '"') {
      // string (supports escapes, no block strings needed)
      i++;
      let s = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          const n = src[i + 1];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n === '"' ? '"' : n === "\\" ? "\\" : n;
          i += 2;
          continue;
        }
        s += src[i++];
      }
      i++;
      out.push({ t: "string", v: s });
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
      const num = src.slice(i, j);
      out.push(num.includes(".") || num.includes("e") || num.includes("E") ? { t: "float", v: parseFloat(num) } : { t: "int", v: parseInt(num, 10) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j])) j++;
      out.push({ t: "name", v: src.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

interface Selection {
  field?: string;
  alias?: string;
  args: Record<string, Arg>;
  sub: Selection[];
  fragmentSpread?: string;
  inlineFragment?: string;
  directives: string[];
}

type Arg =
  | { kind: "value"; v: unknown }
  | { kind: "var"; name: string };

interface Op {
  type: "query" | "mutation";
  name: string | null;
  varDefs: { name: string; type: string; default?: Arg }[];
  selections: Selection[];
}

interface Frag {
  name: string;
  on: string;
  selections: Selection[];
}

interface Doc {
  ops: Op[];
  frags: Map<string, Frag>;
}

function parseQuery(src: string): Doc {
  const toks = tokenize(src);
  const p = { i: 0 };
  const doc: Doc = { ops: [], frags: new Map() };
  while (p.i < toks.length) {
    const t = toks[p.i];
    if (t.t === "name" && t.v === "query" && toks[p.i + 1]?.t === "name" && (toks[p.i + 2]?.t !== "punct" || (toks[p.i + 2] as { v: string }).v !== "(")) {
      p.i++;
      const op = parseOp(p, toks, "query");
      doc.ops.push(op);
      continue;
    }
    if (t.t === "name" && t.v === "mutation") {
      p.i++;
      const op = parseOp(p, toks, "mutation");
      doc.ops.push(op);
      continue;
    }
    if (t.t === "punct" && t.v === "{") {
      doc.ops.push(parseOpBody(p, toks, "query", null, []));
      continue;
    }
    if (t.t === "name" && (t.v === "query" || t.v === "mutation")) {
      // operation with variable definitions
      p.i++;
      const kind = t.v as "query" | "mutation";
      const name = toks[p.i]?.t === "name" ? (toks[p.i] as { v: string }).v : null;
      if (name) p.i++;
      const varDefs: Op["varDefs"] = [];
      if (toks[p.i]?.t === "punct" && (toks[p.i] as { v: string }).v === "(") {
        p.i++;
        while (!(toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === ")")) {
          expect(p, toks, "$", "punct");
          const vn = (toks[p.i++] as { v: string }).v;
          expect(p, toks, ":", "punct");
          let type = "";
          while (toks[p.i].t === "name" || (toks[p.i].t === "punct" && ["[", "]", "!"].includes((toks[p.i] as { v: string }).v))) {
            const tt = toks[p.i++];
            type += tt.t === "name" ? (tt as { v: string }).v : (tt as { v: string }).v;
          }
          let def: Arg | undefined;
          if (toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === "=") {
            p.i++;
            def = parseValueArg(p, toks);
          }
          varDefs.push({ name: vn, type, default: def });
        }
        p.i++;
      }
      // optional @directives skipped
      while (toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === "@") {
        p.i++;
        p.i++;
        if (toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === "(") skipBalanced(p, toks, "(", ")");
      }
      const selections = parseSelectionSet(p, toks);
      doc.ops.push({ type: kind, name, varDefs, selections });
      continue;
    }
    if (t.t === "name" && t.v === "fragment") {
      p.i++;
      const fname = (toks[p.i++] as { v: string }).v;
      expect(p, toks, "on", "name");
      const on = (toks[p.i++] as { v: string }).v;
      const selections = parseSelectionSet(p, toks);
      doc.frags.set(fname, { name: fname, on, selections });
      continue;
    }
    p.i++;
  }
  return doc;
}

function parseOp(p: { i: number }, toks: Tok[], kind: "query" | "mutation"): Op {
  const name = toks[p.i]?.t === "name" ? (toks[p.i] as { v: string }).v : null;
  if (name) p.i++;
  const varDefs: Op["varDefs"] = [];
  if (toks[p.i]?.t === "punct" && (toks[p.i] as { v: string }).v === "(") {
    p.i++;
    while (!(toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === ")")) {
      expect(p, toks, "$", "punct");
      const vn = (toks[p.i++] as { v: string }).v;
      expect(p, toks, ":", "punct");
      let type = "";
      while (toks[p.i].t === "name" || (toks[p.i].t === "punct" && ["[", "]", "!"].includes((toks[p.i] as { v: string }).v))) {
        const tt = toks[p.i++];
        type += tt.t === "name" ? (tt as { v: string }).v : (tt as { v: string }).v;
      }
      let def: Arg | undefined;
      if (toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === "=") {
        p.i++;
        def = parseValueArg(p, toks);
      }
      varDefs.push({ name: vn, type, default: def });
    }
    p.i++;
  }
  const selections = parseSelectionSet(p, toks);
  return { type: kind, name, varDefs, selections };
}

function parseOpBody(p: { i: number }, toks: Tok[], kind: "query" | "mutation", name: string | null, varDefs: Op["varDefs"]): Op {
  const selections = parseSelectionSet(p, toks);
  return { type: kind, name, varDefs, selections };
}

function expect(p: { i: number }, toks: Tok[], v: string, kind: "name" | "punct"): void {
  const t = toks[p.i];
  if (t && t.t === kind && (t as { v: string }).v === v) {
    p.i++;
    return;
  }
  throw new Error(`expected ${v} at token ${p.i}: ${JSON.stringify(toks.slice(Math.max(0, p.i - 3), p.i + 3))} in ${toks.length}`);
}

function skipBalanced(p: { i: number }, toks: Tok[], open: string, close: string): void {
  let depth = 0;
  while (p.i < toks.length) {
    const t = toks[p.i++];
    if (t.t === "punct" && (t as { v: string }).v === open) depth++;
    else if (t.t === "punct" && (t as { v: string }).v === close) {
      depth--;
      if (depth === 0) return;
    }
  }
}

function parseValueArg(p: { i: number }, toks: Tok[]): Arg {
  const t = toks[p.i];
  if (t.t === "punct" && (t as { v: string }).v === "$") {
    p.i++;
    const n = toks[p.i++];
    return { kind: "var", name: n.t === "name" ? (n as { v: string }).v : "" };
  }
  if (t.t === "var") {
    p.i++;
    return { kind: "var", name: (t as { v: string }).v };
  }
  if (t.t === "int") {
    p.i++;
    return { kind: "value", v: (t as { v: number }).v };
  }
  if (t.t === "float") {
    p.i++;
    return { kind: "value", v: (t as { v: number }).v };
  }
  if (t.t === "string") {
    p.i++;
    return { kind: "value", v: (t as { v: string }).v };
  }
  if (t.t === "name") {
    p.i++;
    const v = (t as { v: string }).v;
    return { kind: "value", v: v === "true" ? true : v === "false" ? false : v === "null" ? null : v };
  }
  if (t.t === "punct" && (t as { v: string }).v === "[") {
    p.i++;
    const arr: unknown[] = [];
    while (!(toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === "]")) {
      const v = parseValueArg(p, toks);
      arr.push(v.kind === "value" ? v.v : `$${v.name}`);
    }
    p.i++;
    return { kind: "value", v: arr };
  }
  if (t.t === "punct" && (t as { v: string }).v === "{") {
    p.i++;
    const obj: Record<string, unknown> = {};
    while (!(toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === "}")) {
      const fname = (toks[p.i++] as { v: string }).v;
      expect(p, toks, ":", "punct");
      const v = parseValueArg(p, toks);
      obj[fname] = v.kind === "value" ? v.v : `$${v.name}`;
    }
    p.i++;
    return { kind: "value", v: obj };
  }
  p.i++;
  return { kind: "value", v: null };
}

function parseSelectionSet(p: { i: number }, toks: Tok[]): Selection[] {
  expect(p, toks, "{", "punct");
  const out: Selection[] = [];
  for (;;) {
    if (toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === "}") {
      p.i++;
      break;
    }
    const t = toks[p.i];
    if (t.t === "punct" && (t as { v: string }).v === "...") {
      p.i++;
      const n = toks[p.i];
      if (n.t === "name" && (n as { v: string }).v === "on") {
        p.i++;
        const type = (toks[p.i++] as { v: string }).v;
        // skip directives
        while (toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === "@") {
          p.i++;
          p.i++;
          if (toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === "(") skipBalanced(p, toks, "(", ")");
        }
        out.push({ args: {}, sub: parseSelectionSet(p, toks), inlineFragment: type, directives: [] });
      } else {
        const fname = (toks[p.i++] as { v: string }).v;
        out.push({ args: {}, sub: [], fragmentSpread: fname, directives: [] });
      }
      continue;
    }
    if (t.t !== "name") {
      p.i++;
      continue;
    }
    const field = (toks[p.i++] as { v: string }).v;
    let alias: string | undefined;
    if (toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === ":") {
      p.i++;
      alias = field;
      void alias;
      // alias:field form — the name we just read was the alias
    }
    const args: Record<string, Arg> = {};
    if (toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === "(") {
      p.i++;
      while (!(toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === ")")) {
        const an = (toks[p.i++] as { v: string }).v;
        expect(p, toks, ":", "punct");
        args[an] = parseValueArg(p, toks);
      }
      p.i++;
    }
    const directives: string[] = [];
    while (toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === "@") {
      p.i++;
      directives.push((toks[p.i++] as { v: string }).v);
      if (toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === "(") skipBalanced(p, toks, "(", ")");
    }
    let sub: Selection[] = [];
    if (toks[p.i].t === "punct" && (toks[p.i] as { v: string }).v === "{") {
      sub = parseSelectionSet(p, toks);
    }
    out.push({ field, alias: undefined, args, sub, directives });
  }
  return out;
}

// ---------------- schema model (for introspection) ----------------

interface FieldType {
  name: string;
  kind: "SCALAR" | "OBJECT" | "INTERFACE" | "UNION" | "ENUM" | "LIST" | "NON_NULL";
  ofType?: FieldType;
  fields?: FieldDef[];
  enumValues?: string[];
}

interface FieldDef {
  name: string;
  type: FieldType;
  args?: Record<string, FieldType>;
}

const SCALARS = ["String", "Int", "Boolean", "ID", "Float"];
const scalarType = (name: string): FieldType => ({ name, kind: "SCALAR" });

function list(t: FieldType): FieldType {
  return { name: "", kind: "LIST", ofType: t };
}
function nn(t: FieldType): FieldType {
  return { name: "", kind: "NON_NULL", ofType: t };
}

const Actor = { name: "Actor", kind: "OBJECT" as const, fields: [
  { name: "login", type: scalarType("String") },
  { name: "url", type: scalarType("URI") },
  { name: "avatarUrl", type: scalarType("URI") },
] };

const LabelT: FieldType = { name: "Label", kind: "OBJECT", fields: [
  { name: "id", type: nn(scalarType("ID")) },
  { name: "name", type: nn(scalarType("String")) },
  { name: "color", type: scalarType("String") },
  { name: "description", type: scalarType("String") },
  { name: "isDefault", type: scalarType("Boolean") },
  { name: "repository", type: { name: "Repository", kind: "OBJECT" } },
] };

const IssueT: FieldType = {
  name: "Issue",
  kind: "OBJECT",
  fields: [
    { name: "id", type: nn(scalarType("ID")) },
    { name: "number", type: nn(scalarType("Int")) },
    { name: "title", type: nn(scalarType("String")) },
    { name: "body", type: scalarType("String") },
    { name: "state", type: { name: "IssueState", kind: "ENUM", enumValues: ["OPEN", "CLOSED"] } },
    { name: "closed", type: nn(scalarType("Boolean")) },
    { name: "createdAt", type: nn(scalarType("DateTime")) },
    { name: "updatedAt", type: nn(scalarType("DateTime")) },
    { name: "closedAt", type: scalarType("DateTime") },
    { name: "author", type: Actor },
    { name: "url", type: nn(scalarType("URI")) },
    { name: "repository", type: { name: "Repository", kind: "OBJECT" } },
    { name: "labels", type: nn(list(nn(LabelT))) },
    { name: "comments", type: nn(list(nn({ name: "IssueComment", kind: "OBJECT", fields: [
      { name: "id", type: nn(scalarType("ID")) },
      { name: "body", type: nn(scalarType("String")) },
      { name: "author", type: Actor },
      { name: "createdAt", type: nn(scalarType("DateTime")) },
    ] }))) },
  ],
};

const PullRequestT: FieldType = {
  name: "PullRequest",
  kind: "OBJECT",
  fields: [
    { name: "id", type: nn(scalarType("ID")) },
    { name: "number", type: nn(scalarType("Int")) },
    { name: "title", type: nn(scalarType("String")) },
    { name: "body", type: scalarType("String") },
    { name: "state", type: { name: "PullRequestState", kind: "ENUM", enumValues: ["OPEN", "CLOSED", "MERGED"] } },
    { name: "closed", type: nn(scalarType("Boolean")) },
    { name: "merged", type: nn(scalarType("Boolean")) },
    { name: "mergedAt", type: scalarType("DateTime") },
    { name: "createdAt", type: nn(scalarType("DateTime")) },
    { name: "updatedAt", type: nn(scalarType("DateTime")) },
    { name: "author", type: Actor },
    { name: "url", type: nn(scalarType("URI")) },
    { name: "repository", type: { name: "Repository", kind: "OBJECT" } },
    { name: "headRefName", type: nn(scalarType("String")) },
    { name: "baseRefName", type: nn(scalarType("String")) },
    { name: "mergeable", type: { name: "MergeableState", kind: "ENUM", enumValues: ["MERGEABLE", "CONFLICTING", "UNKNOWN"] } },
    { name: "files", type: nn(list(nn({ name: "PullRequestChangedFile", kind: "OBJECT", fields: [
      { name: "path", type: nn(scalarType("String")) },
      { name: "additions", type: nn(scalarType("Int")) },
      { name: "deletions", type: nn(scalarType("Int")) },
    ] }))) },
  ],
};

const BranchT: FieldType = {
  name: "Ref",
  kind: "OBJECT",
  fields: [
    { name: "id", type: nn(scalarType("ID")) },
    { name: "name", type: nn(scalarType("String")) },
    { name: "target", type: { name: "Commit", kind: "OBJECT" } },
  ],
};

const CommitT: FieldType = {
  name: "Commit",
  kind: "OBJECT",
  fields: [
    { name: "id", type: nn(scalarType("ID")) },
    { name: "oid", type: nn(scalarType("GitObjectID")) },
    { name: "message", type: nn(scalarType("String")) },
    { name: "author", type: { name: "GitActor", kind: "OBJECT", fields: [
      { name: "name", type: scalarType("String") },
      { name: "email", type: scalarType("String") },
      { name: "date", type: scalarType("DateTime") },
    ] } },
    { name: "committedDate", type: scalarType("DateTime") },
    { name: "pushedDate", type: scalarType("DateTime") },
    { name: "url", type: nn(scalarType("URI")) },
    { name: "parents", type: nn(list(nn({ name: "Commit", kind: "OBJECT" }))) },
  ],
};

const RepositoryT: FieldType = {
  name: "Repository",
  kind: "OBJECT",
  fields: [
    { name: "id", type: nn(scalarType("ID")) },
    { name: "name", type: nn(scalarType("String")) },
    { name: "nameWithOwner", type: nn(scalarType("String")) },
    { name: "description", type: scalarType("String") },
    { name: "url", type: nn(scalarType("URI")) },
    { name: "createdAt", type: nn(scalarType("DateTime")) },
    { name: "updatedAt", type: nn(scalarType("DateTime")) },
    { name: "isPrivate", type: nn(scalarType("Boolean")) },
    { name: "isEmpty", type: scalarType("Boolean") },
    { name: "defaultBranchRef", type: BranchT },
    { name: "ref", type: BranchT, args: { qualifiedName: nn(scalarType("String")) } },
    { name: "viewerPermission", type: { name: "RepositoryPermission", kind: "ENUM", enumValues: ["ADMIN", "WRITE", "READ"] } },
    { name: "issues", type: nn(list(nn(IssueT))), args: { first: scalarType("Int"), after: scalarType("String"), states: list({ name: "IssueState", kind: "ENUM", enumValues: ["OPEN", "CLOSED"] }), labels: list(scalarType("String")) } },
    { name: "pullRequests", type: nn(list(nn(PullRequestT))), args: { first: scalarType("Int"), after: scalarType("String"), states: list({ name: "PullRequestState", kind: "ENUM", enumValues: ["OPEN", "CLOSED", "MERGED"] }) } },
    { name: "object", type: { name: "GitObject", kind: "INTERFACE" }, args: { expression: scalarType("String") } },
  ],
};

const QueryT: FieldType = {
  name: "Query",
  kind: "OBJECT",
  fields: [
    { name: "viewer", type: nn(Actor) },
    { name: "repository", type: RepositoryT, args: { owner: nn(scalarType("String")), name: nn(scalarType("String")) } },
    { name: "node", type: { name: "Node", kind: "INTERFACE" }, args: { id: nn(scalarType("ID")) } },
    { name: "nodes", type: nn(list({ name: "Node", kind: "INTERFACE" })), args: { ids: nn(list(nn(scalarType("ID")))) } },
  ],
};

const MutationT: FieldType = {
  name: "Mutation",
  kind: "OBJECT",
  fields: [
    { name: "createIssue", type: { name: "CreateIssuePayload", kind: "OBJECT", fields: [
      { name: "issue", type: IssueT },
    ] }, args: { input: nn({ name: "CreateIssueInput", kind: "INPUT_OBJECT", fields: [
      { name: "repositoryId", type: nn(scalarType("ID")) },
      { name: "title", type: nn(scalarType("String")) },
      { name: "body", type: scalarType("String") },
      { name: "clientMutationId", type: scalarType("String") },
    ] }) } },
    { name: "closeIssue", type: { name: "CloseIssuePayload", kind: "OBJECT", fields: [
      { name: "issue", type: IssueT },
    ] }, args: { input: nn({ name: "CloseIssueInput", kind: "INPUT_OBJECT", fields: [
      { name: "issueId", type: nn(scalarType("ID")) },
      { name: "clientMutationId", type: scalarType("String") },
    ] }) } },
    { name: "createPullRequest", type: { name: "CreatePullRequestPayload", kind: "OBJECT", fields: [
      { name: "pullRequest", type: PullRequestT },
    ] }, args: { input: nn({ name: "CreatePullRequestInput", kind: "INPUT_OBJECT", fields: [
      { name: "repositoryId", type: nn(scalarType("ID")) },
      { name: "title", type: nn(scalarType("String")) },
      { name: "body", type: scalarType("String") },
      { name: "headRefName", type: nn(scalarType("String")) },
      { name: "baseRefName", type: nn(scalarType("String")) },
      { name: "clientMutationId", type: scalarType("String") },
    ] }) } },
    { name: "mergePullRequest", type: { name: "MergePullRequestPayload", kind: "OBJECT", fields: [
      { name: "pullRequest", type: PullRequestT },
    ] }, args: { input: nn({ name: "MergePullRequestInput", kind: "INPUT_OBJECT", fields: [
      { name: "pullRequestId", type: nn(scalarType("ID")) },
      { name: "mergeMethod", type: { name: "PullRequestMergeMethod", kind: "ENUM", enumValues: ["MERGE", "SQUASH", "REBASE"] } },
      { name: "commitHeadline", type: scalarType("String") },
      { name: "clientMutationId", type: scalarType("String") },
    ] }) } },
    { name: "addComment", type: { name: "AddCommentPayload", kind: "OBJECT", fields: [
      { name: "commentEdge", type: { name: "IssueCommentEdge", kind: "OBJECT", fields: [
        { name: "node", type: { name: "IssueComment", kind: "OBJECT", fields: [
          { name: "id", type: nn(scalarType("ID")) },
          { name: "body", type: nn(scalarType("String")) },
          { name: "createdAt", type: nn(scalarType("DateTime")) },
        ] } },
      ] } },
    ] }, args: { input: nn({ name: "AddCommentInput", kind: "INPUT_OBJECT", fields: [
      { name: "subjectId", type: nn(scalarType("ID")) },
      { name: "body", type: nn(scalarType("String")) },
      { name: "clientMutationId", type: scalarType("String") },
    ] }) } },
  ],
};

const ALL_TYPES: FieldType[] = [
  QueryT,
  MutationT,
  RepositoryT,
  IssueT,
  PullRequestT,
  LabelT,
  CommitT,
  BranchT,
  Actor as FieldType,
  { name: "IssueComment", kind: "OBJECT", fields: (IssueT.fields!.find((f) => f.name === "comments")!.type.ofType!.ofType!.ofType!.fields ?? []) },
  { name: "PullRequestChangedFile", kind: "OBJECT", fields: (PullRequestT.fields!.find((f) => f.name === "files")!.type.ofType!.ofType!.ofType!.fields ?? []) },
  { name: "GitActor", kind: "OBJECT", fields: (CommitT.fields!.find((f) => f.name === "author")!.type.fields ?? []) },
  { name: "CreateIssuePayload", kind: "OBJECT", fields: MutationT.fields![0].type.fields },
  { name: "CloseIssuePayload", kind: "OBJECT", fields: MutationT.fields![1].type.fields },
  { name: "CreatePullRequestPayload", kind: "OBJECT", fields: MutationT.fields![2].type.fields },
  { name: "MergePullRequestPayload", kind: "OBJECT", fields: MutationT.fields![3].type.fields },
  { name: "AddCommentPayload", kind: "OBJECT", fields: MutationT.fields![4].type.fields },
  { name: "IssueCommentEdge", kind: "OBJECT", fields: MutationT.fields![4].type.fields![0].type.fields },
  { name: "CreateIssueInput", kind: "INPUT_OBJECT", fields: MutationT.fields![0].args!.input.ofType!.fields },
  { name: "CloseIssueInput", kind: "INPUT_OBJECT", fields: MutationT.fields![1].args!.input.ofType!.fields },
  { name: "CreatePullRequestInput", kind: "INPUT_OBJECT", fields: MutationT.fields![2].args!.input.ofType!.fields },
  { name: "MergePullRequestInput", kind: "INPUT_OBJECT", fields: MutationT.fields![3].args!.input.ofType!.fields },
  { name: "AddCommentInput", kind: "INPUT_OBJECT", fields: MutationT.fields![4].args!.input.ofType!.fields },
  ...SCALARS.map((n) => scalarType(n)),
  { name: "URI", kind: "SCALAR" },
  { name: "DateTime", kind: "SCALAR" },
  { name: "GitObjectID", kind: "SCALAR" },
  { name: "Node", kind: "INTERFACE", fields: [{ name: "id", type: nn(scalarType("ID")) }] },
  { name: "GitObject", kind: "INTERFACE", fields: [{ name: "id", type: nn(scalarType("ID")) }, { name: "oid", type: nn(scalarType("GitObjectID")) }] },
  { name: "IssueState", kind: "ENUM", enumValues: ["OPEN", "CLOSED"] },
  { name: "PullRequestState", kind: "ENUM", enumValues: ["OPEN", "CLOSED", "MERGED"] },
  { name: "MergeableState", kind: "ENUM", enumValues: ["MERGEABLE", "CONFLICTING", "UNKNOWN"] },
  { name: "PullRequestMergeMethod", kind: "ENUM", enumValues: ["MERGE", "SQUASH", "REBASE"] },
  { name: "RepositoryPermission", kind: "ENUM", enumValues: ["ADMIN", "WRITE", "READ"] },
];

// ---------------- execution ----------------

interface Ctx {
  errors: { message: string; path?: (string | number)[] }[];
  vars: Record<string, unknown>;
  frags: Map<string, Frag>;
}

function execute(store: ForgeStore, doc: Doc, variables: Record<string, unknown>): unknown {
  const op = doc.ops.find((o) => o.type === "mutation") ?? doc.ops[0];
  if (!op) return { data: null };
  const ctx: Ctx = { errors: [], vars: resolveVars(op, variables), frags: doc.frags };
  const flat = flattenSubs(op.selections, ctx, op.type === "mutation" ? "Mutation" : "Query");
  const root = op.type === "mutation" ? resolveMutationRoot(store, ctx, flat) : resolveQueryRoot(store, ctx, flat);
  return { data: root, errors: ctx.errors.length > 0 ? ctx.errors : undefined };
}

/** Resolve fragment spreads and inline fragments into effective selections. */
function flattenSubs(subs: Selection[], ctx: Ctx, typeName: string): Selection[] {
  const out: Selection[] = [];
  for (const sel of subs) {
    if (sel.inlineFragment !== undefined) {
      if (sel.inlineFragment === typeName || typeName === "") {
        out.push(...flattenSubs(sel.sub, ctx, typeName));
      }
      continue;
    }
    if (sel.fragmentSpread !== undefined) {
      const frag = ctx.frags.get(sel.fragmentSpread);
      if (frag && (frag.on === typeName || typeName === "")) {
        out.push(...flattenSubs(frag.selections, ctx, typeName));
      }
      continue;
    }
    out.push({ ...sel, sub: flattenSubs(sel.sub, ctx, childTypeOf(sel.field, typeName)) });
  }
  return out;
}

function childTypeOf(field: string | undefined, parent: string): string {
  void field;
  void parent;
  return ""; // unknown: inline fragments inside children are matched leniently
}

function resolveVars(op: Op, provided: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const vd of op.varDefs) {
    const v = provided[vd.name];
    if (v !== undefined) out[vd.name] = v;
    else if (vd.default) out[vd.name] = argValue(vd.default, {});
  }
  for (const [k, v] of Object.entries(provided)) out[k] = v;
  return out;
}

function argValue(a: Arg, vars: Record<string, unknown>): unknown {
  if (a.kind === "value") return deepResolve(a.v, vars);
  return vars[a.name];
}

function deepResolve(v: unknown, vars: Record<string, unknown>): unknown {
  if (typeof v === "string" && v.startsWith("$")) return vars[v.slice(1)];
  if (Array.isArray(v)) return v.map((x) => deepResolve(x, vars));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = deepResolve(val, vars);
    return o;
  }
  return v;
}

function selectArgs(sel: Selection, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, a] of Object.entries(sel.args)) out[k] = argValue(a, ctx.vars);
  return out;
}

function resolveQueryRoot(store: ForgeStore, ctx: Ctx, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const name = sel.alias ?? sel.field ?? "";
    switch (sel.field) {
      case "viewer": {
        out[name] = projectActor({ login: store.tokenOwner ?? "forge", url: `/${store.tokenOwner ?? "forge"}` }, sel, ctx);
        break;
      }
      case "repository": {
        const args = selectArgs(sel, ctx);
        const repo = store.getRepo(String(args.owner), String(args.name));
        if (!repo) {
          ctx.errors.push({ message: `Could not resolve to a Repository with the name '${args.owner}/${args.name}'.`, path: [name] });
          out[name] = null;
          break;
        }
        out[name] = projectRepository(store, ctx, repo, sel.sub);
        break;
      }
      case "node": {
        const args = selectArgs(sel, ctx);
        out[name] = projectNode(store, ctx, String(args.id ?? ""), sel.sub);
        break;
      }
      case "nodes": {
        const args = selectArgs(sel, ctx);
        const ids = (args.ids as string[]) ?? [];
        out[name] = ids.map((id) => projectNode(store, ctx, id, sel.sub));
        break;
      }
      case "__schema": {
        out[name] = projectSchema(sel.sub, ctx);
        break;
      }
      case "__type": {
        const targs = selectArgs(sel, ctx);
        const t = findType(String(targs.name ?? ""));
        out[name] = t ? renderFullType(t, sel.sub) : null;
        break;
      }
      case "__typename": {
        out[name] = "Query";
        break;
      }
      default: {
        ctx.errors.push({ message: `Cannot query field '${sel.field}' on type 'Query'.`, path: [name] });
        out[name] = null;
      }
    }
  }
  return out;
}

function projectActor(actor: { login: string; url: string }, sel: Selection, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (sel.sub.length === 0) return out;
  for (const s of sel.sub) {
    const name = s.alias ?? s.field ?? "";
    if (s.field === "login") out[name] = actor.login;
    else if (s.field === "url" || s.field === "avatarUrl") out[name] = actor.url;
    else if (s.field === "__typename") out[name] = "User";
    else {
      ctx.errors.push({ message: `Cannot query field '${s.field}' on type 'Actor'.`, path: [name] });
      out[name] = null;
    }
  }
  return out;
}

function cursorOf(n: number): string {
  return Buffer.from(`cursor:${n}`).toString("base64");
}

function pageConnection<T>(items: T[], args: Record<string, unknown>, render: (item: T) => unknown): unknown {
  const first = typeof args.first === "number" ? args.first : (typeof args.last === "number" ? args.last : 30);
  let startIdx = 0;
  if (typeof args.after === "string" && args.after.length > 0) {
    const decoded = Buffer.from(args.after, "base64").toString("utf8");
    const n = parseInt(decoded.replace("cursor:", ""), 10);
    if (!Number.isNaN(n)) startIdx = n + 1;
  }
  const slice = items.slice(startIdx, startIdx + first);
  return {
    pageInfo: {
      hasNextPage: startIdx + first < items.length,
      hasPreviousPage: startIdx > 0,
      endCursor: slice.length > 0 ? cursorOf(startIdx + slice.length - 1) : null,
      startCursor: slice.length > 0 ? cursorOf(startIdx) : null,
    },
    edges: slice.map((item, i) => ({ cursor: cursorOf(startIdx + i), node: render(item) })),
    nodes: slice.map(render),
    totalCount: items.length,
  };
}

function projectRepository(store: ForgeStore, ctx: Ctx, repo: ReturnType<ForgeStore["getRepo"]>, selections: Selection[]): Record<string, unknown> {
  if (!repo) return null as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const key = `${repo.owner}/${repo.name}`;
  for (const sel of selections) {
    const name = sel.alias ?? sel.field ?? "";
    const args = selectArgs(sel, ctx);
    switch (sel.field) {
      case "id":
        out[name] = nodeId(`repo:${key}`);
        break;
      case "name":
        out[name] = repo.name;
        break;
      case "nameWithOwner":
        out[name] = key;
        break;
      case "description":
        out[name] = null;
        break;
      case "url":
        out[name] = `/${key}`;
        break;
      case "createdAt":
      case "updatedAt":
        out[name] = store.now();
        break;
      case "isPrivate":
        out[name] = false;
        break;
      case "isEmpty":
        out[name] = [...repo.refs.values()].length === 0;
        break;
      case "isFork":
      case "isArchived":
        out[name] = false;
        break;
      case "viewerPermission":
        out[name] = "ADMIN";
        break;
      case "defaultBranchRef": {
        const branchName = (store.headTarget(repo) ?? `refs/heads/${DEFAULT_BRANCH_NAME}`).replace("refs/heads/", "");
        const sha = store.resolveRef(repo, "HEAD");
        out[name] = sha ? projectRef(store, ctx, repo, branchName, sha, sel.sub) : null;
        break;
      }
      case "ref": {
        const q = String(args.qualifiedName ?? "");
        const short = q.replace(/^refs\//, "").replace(/^heads\//, "");
        const sha = store.resolveRef(repo, short);
        out[name] = sha ? projectRef(store, ctx, repo, short, sha, sel.sub) : null;
        break;
      }
      case "refs": {
        const branches = [...repo.refs.keys()].filter((k) => k.startsWith("refs/heads/")).sort();
        out[name] = pageConnection(branches, args, (b) => {
          const short = b.replace("refs/heads/", "");
          return projectRef(store, ctx, repo, short, repo.refs.get(b)!, (sel.sub.find((s) => s.field === "nodes" || s.field === "edges")?.sub ?? []));
        });
        break;
      }
      case "issues": {
        let issues = [...repo.issues.values()];
        if (Array.isArray(args.states) && args.states.length > 0) {
          issues = issues.filter((i) => (args.states as string[]).includes(i.state.toUpperCase()));
        }
        if (Array.isArray(args.labels) && args.labels.length > 0) {
          const set = new Set(args.labels as string[]);
          issues = issues.filter((i) => i.labels.some((l) => set.has(l)));
        }
        issues = issues.sort((a, b) => b.number - a.number);
        out[name] = pageConnection(issues, args, (i) => projectIssue(store, ctx, repo, i, flatSub(sel.sub)));
        break;
      }
      case "pullRequests": {
        let pulls = [...repo.pulls.values()];
        if (Array.isArray(args.states) && args.states.length > 0) {
          pulls = pulls.filter((p) => (args.states as string[]).includes(p.merged ? "MERGED" : p.state.toUpperCase()));
        }
        pulls = pulls.sort((a, b) => b.number - a.number);
        out[name] = pageConnection(pulls, args, (p) => projectPull(store, ctx, repo, p, flatSub(sel.sub)));
        break;
      }
      case "object": {
        const expr = String(args.expression ?? "HEAD");
        const sha = store.resolveRef(repo, expr);
        out[name] = sha ? projectCommit(store, ctx, repo, sha, sel.sub) : null;
        break;
      }
      case "__typename":
        out[name] = "Repository";
        break;
      default:
        ctx.errors.push({ message: `Cannot query field '${sel.field}' on type 'Repository'.`, path: [name] });
        out[name] = null;
    }
  }
  return out;
}

const DEFAULT_BRANCH_NAME = "main";

function flatSub(subs: Selection[]): Selection[] {
  // connections rendered flat: merge nodes/edges sub-selections into one list
  const out: Selection[] = [];
  for (const s of subs) {
    if (s.field === "nodes" || s.field === "edges") out.push(...s.sub);
  }
  return out.length > 0 ? out : subs;
}

function projectRef(store: ForgeStore, ctx: Ctx, repo: NonNullable<ReturnType<ForgeStore["getRepo"]>>, branch: string, sha: string, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const name = sel.alias ?? sel.field ?? "";
    if (sel.field === "id") out[name] = nodeId(`ref:${repo.owner}/${repo.name}:${branch}`);
    else if (sel.field === "name") out[name] = branch;
    else if (sel.field === "target") out[name] = projectCommit(store, ctx, repo, sha, sel.sub);
    else if (sel.field === "__typename") out[name] = "Ref";
    else {
      ctx.errors.push({ message: `Cannot query field '${sel.field}' on type 'Ref'.`, path: [name] });
      out[name] = null;
    }
  }
  return out;
}

function projectCommit(store: ForgeStore, ctx: Ctx, repo: NonNullable<ReturnType<ForgeStore["getRepo"]>>, sha: string, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const obj = store.getObject(repo, sha);
  for (const sel of selections) {
    const name = sel.alias ?? sel.field ?? "";
    if (sel.field === "id") out[name] = nodeId(`commit:${repo.owner}/${repo.name}:${sha}`);
    else if (sel.field === "oid") out[name] = sha;
    else if (sel.field === "abbreviatedOid") out[name] = sha.slice(0, 7);
    else if (sel.field === "message") out[name] = obj && obj.type === "commit" ? messageOf(obj.data) : "";
    else if (sel.field === "committedDate" || sel.field === "pushedDate") out[name] = store.now();
    else if (sel.field === "author" || sel.field === "committer") {
      out[name] = { name: (store.tokenOwner ?? "forge"), email: `${store.tokenOwner ?? "forge"}@forge.local`, date: store.now(), __typename: "GitActor" };
    } else if (sel.field === "parents") {
      const parents = obj && obj.type === "commit" ? parentsOf(obj.data) : [];
      out[name] = pageConnection(parents, selectArgs(sel, ctx), (p) => projectCommit(store, ctx, repo, p, flatSub(sel.sub)));
    } else if (sel.field === "__typename") out[name] = "Commit";
    else {
      ctx.errors.push({ message: `Cannot query field '${sel.field}' on type 'Commit'.`, path: [name] });
      out[name] = null;
    }
  }
  return out;
}

function messageOf(commitBody: Buffer): string {
  const text = commitBody.toString("utf8");
  const sep = text.indexOf("\n\n");
  return sep === -1 ? "" : text.slice(sep + 2);
}

function parentsOf(commitBody: Buffer): string[] {
  const text = commitBody.toString("utf8");
  const sep = text.indexOf("\n\n");
  return text.slice(0, sep).split("\n").filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
}

function issueGqlId(issue: Issue): string {
  return nodeId(`issue:${issue.repo}:${issue.number}`);
}

function pullGqlId(pr: PullRequest): string {
  return nodeId(`pull:${pr.repo}:${pr.number}`);
}

function projectIssue(store: ForgeStore, ctx: Ctx, repo: NonNullable<ReturnType<ForgeStore["getRepo"]>>, issue: Issue, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const name = sel.alias ?? sel.field ?? "";
    switch (sel.field) {
      case "id":
        out[name] = issueGqlId(issue);
        break;
      case "number":
        out[name] = issue.number;
        break;
      case "title":
        out[name] = issue.title;
        break;
      case "body":
        out[name] = issue.body;
        break;
      case "state":
        out[name] = issue.state.toUpperCase();
        break;
      case "closed":
        out[name] = issue.state === "closed";
        break;
      case "isClosed":
        out[name] = issue.state === "closed";
        break;
      case "createdAt":
        out[name] = issue.created_at;
        break;
      case "updatedAt":
        out[name] = issue.updated_at;
        break;
      case "closedAt":
        out[name] = issue.closed_at;
        break;
      case "author":
        out[name] = projectActor({ login: issue.user, url: `/${issue.user}` }, sel, ctx);
        break;
      case "url":
        out[name] = `/${issue.repo}/issues/${issue.number}`;
        break;
      case "repository":
        out[name] = projectRepository(store, ctx, repo, sel.sub);
        break;
      case "labels":
        out[name] = pageConnection(issue.labels.map((n) => ({ name: n })), selectArgs(sel, ctx), (l) => ({ id: nodeId(`label:${issue.repo}:${l.name}`), name: l.name, color: repo.labels.get(l.name)?.color ?? "ededed", description: repo.labels.get(l.name)?.description ?? null }));
        break;
      case "comments":
        out[name] = pageConnection(issue.comments, selectArgs(sel, ctx), (c) => ({
          id: nodeId(`comment:${issue.repo}:${issue.number}:${c.id}`),
          body: c.body,
          author: { login: c.user, __typename: "User" },
          createdAt: c.created_at,
        }));
        break;
      case "__typename":
        out[name] = "Issue";
        break;
      default:
        ctx.errors.push({ message: `Cannot query field '${sel.field}' on type 'Issue'.`, path: [name] });
        out[name] = null;
    }
  }
  return out;
}

function projectPull(store: ForgeStore, ctx: Ctx, repo: NonNullable<ReturnType<ForgeStore["getRepo"]>>, pr: PullRequest, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const name = sel.alias ?? sel.field ?? "";
    switch (sel.field) {
      case "id":
        out[name] = pullGqlId(pr);
        break;
      case "number":
        out[name] = pr.number;
        break;
      case "title":
        out[name] = pr.title;
        break;
      case "body":
        out[name] = pr.body;
        break;
      case "state":
        out[name] = pr.merged ? "MERGED" : pr.state.toUpperCase();
        break;
      case "closed":
      case "isClosed":
        out[name] = pr.state === "closed";
        break;
      case "merged":
      case "isMerged":
        out[name] = pr.merged;
        break;
      case "mergedAt":
        out[name] = pr.merged_at;
        break;
      case "createdAt":
        out[name] = pr.created_at;
        break;
      case "updatedAt":
        out[name] = pr.updated_at;
        break;
      case "author":
        out[name] = projectActor({ login: pr.user, url: `/${pr.user}` }, sel, ctx);
        break;
      case "url":
        out[name] = `/${pr.repo}/pull/${pr.number}`;
        break;
      case "repository":
        out[name] = projectRepository(store, ctx, repo, sel.sub);
        break;
      case "headRefName":
        out[name] = pr.head;
        break;
      case "baseRefName":
        out[name] = pr.base;
        break;
      case "mergeable":
        out[name] = "MERGEABLE";
        break;
      case "files": {
        const headSha = store.resolveRef(repo, pr.head);
        const baseSha = store.resolveRef(repo, pr.base);
        const files = headSha && baseSha ? store.diffTrees(repo, baseSha, headSha) : [];
        out[name] = pageConnection(files, selectArgs(sel, ctx), (f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions }));
        break;
      }
      case "commits": {
        const headSha = store.resolveRef(repo, pr.head);
        const commits = headSha ? store.commits(repo, headSha) : [];
        out[name] = pageConnection(commits, selectArgs(sel, ctx), (c) => ({ commit: projectCommit(store, ctx, repo, c.sha, flatSub(sel.sub)) }));
        break;
      }
      case "__typename":
        out[name] = "PullRequest";
        break;
      default:
        ctx.errors.push({ message: `Cannot query field '${sel.field}' on type 'PullRequest'.`, path: [name] });
        out[name] = null;
    }
  }
  return out;
}

function projectNode(store: ForgeStore, ctx: Ctx, id: string, selections: Selection[]): Record<string, unknown> | null {
  const parsed = fromNodeId(id);
  if (!parsed) {
    ctx.errors.push({ message: `Could not resolve to a node with the global id of '${id}'` });
    return null;
  }
  const parts = parsed.key.split(":");
  const kind = parts[0];
  if (kind === "repo") {
    const repo = store.getRepo(parts[1], parts[2]);
    if (!repo) return null;
    return projectRepository(store, ctx, repo, selections);
  }
  if (kind === "issue") {
    const repo = store.getRepo(...(parts[1].split("/") as [string, string]));
    if (!repo) return null;
    const issue = repo.issues.get(parseInt(parts[2], 10));
    if (!issue) return null;
    return projectIssue(store, ctx, repo, issue, selections);
  }
  if (kind === "pull") {
    const repo = store.getRepo(...(parts[1].split("/") as [string, string]));
    if (!repo) return null;
    const pr = repo.pulls.get(parseInt(parts[2], 10));
    if (!pr) return null;
    return projectPull(store, ctx, repo, pr, selections);
  }
  if (kind === "comment") {
    const repo = store.getRepo(...(parts[1].split("/") as [string, string]));
    if (!repo) return null;
    const issue = repo.issues.get(parseInt(parts[2], 10));
    const c = issue?.comments.find((x) => x.id === parseInt(parts[3], 10));
    if (!c) return null;
    return { id: id, body: c.body, createdAt: c.created_at, __typename: "IssueComment" };
  }
  ctx.errors.push({ message: `Could not resolve to a node with the global id of '${id}'` });
  return null;
}

// ---------------- introspection ----------------

function projectSchema(selections: Selection[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const name = sel.alias ?? sel.field ?? "";
    switch (sel.field) {
      case "queryType":
        out[name] = renderTypeRef(QueryT, sel.sub);
        break;
      case "mutationType":
        out[name] = renderTypeRef(MutationT, sel.sub);
        break;
      case "types":
        out[name] = ALL_TYPES.map((t) => renderFullType(t, sel.sub));
        break;
      case "directives":
        out[name] = [
          { name: "include", locations: ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"], args: [{ name: "if", type: { kind: "NON_NULL", name: "", ofType: { kind: "SCALAR", name: "Boolean", ofType: null } }, defaultValue: null }] },
          { name: "skip", locations: ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"], args: [{ name: "if", type: { kind: "NON_NULL", name: "", ofType: { kind: "SCALAR", name: "Boolean", ofType: null } }, defaultValue: null }] },
        ];
        break;
      case "description":
        out[name] = null;
        break;
      default:
        ctx.errors.push({ message: `Cannot query field '${sel.field}' on type '__Schema'.`, path: [name] });
        out[name] = null;
    }
  }
  return out;
}

function findType(name: string): FieldType | undefined {
  return ALL_TYPES.find((t) => t.name === name);
}

function renderTypeRef(t: FieldType, sub: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sub) {
    const name = sel.alias ?? sel.field ?? "";
    if (sel.field === "name") out[name] = t.name;
    else if (sel.field === "kind") out[name] = t.kind;
    else if (sel.field === "ofType") out[name] = t.ofType ? renderTypeRef(t.ofType, sel.sub) : null;
    else if (sel.field === "fields") {
      out[name] = (t.fields ?? []).map((f) => renderField(f, sel.sub));
    } else out[name] = null;
  }
  return out;
}

function renderField(f: FieldDef, sub: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sub) {
    const name = sel.alias ?? sel.field ?? "";
    if (sel.field === "name") out[name] = f.name;
    else if (sel.field === "type") out[name] = renderTypeFull(f.type, sel.sub);
    else if (sel.field === "args") out[name] = Object.entries(f.args ?? {}).map(([an, at]) => ({ name: an, type: renderTypeFull(at, flatSub(sel.sub)), defaultValue: null }));
    else if (sel.field === "description") out[name] = null;
    else out[name] = null;
  }
  return out;
}

function renderTypeFull(t: FieldType, sub: Selection[]): Record<string, unknown> {
  return renderFullType(t, sub);
}

function renderFullType(t: FieldType, sub: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sub) {
    const name = sel.alias ?? sel.field ?? "";
    switch (sel.field) {
      case "kind":
        out[name] = t.kind;
        break;
      case "name":
        out[name] = t.name || null;
        break;
      case "ofType":
        out[name] = t.ofType ? renderFullType(t.ofType, sel.sub) : null;
        break;
      case "fields":
        out[name] = (t.fields ?? []).map((f) => renderField(f, flatSub(sel.sub)));
        break;
      case "inputFields":
        out[name] = (t.fields ?? []).map((f) => ({ name: f.name, type: renderTypeFull(f.type, flatSub(sel.sub)), defaultValue: null }));
        break;
      case "enumValues":
        out[name] = (t.enumValues ?? []).map((e) => ({ name: e, description: null }));
        break;
      case "interfaces":
        out[name] = [];
        break;
      case "possibleTypes":
        out[name] = t.kind === "INTERFACE" ? ALL_TYPES.filter((x) => x.kind === "OBJECT" && (t.name === "Node" ? ["Repository", "Issue", "PullRequest"].includes(x.name) : ["Commit", "Blob", "Tree", "Tag"].includes(x.name))).map((x) => renderTypeRef(x, flatSub(sel.sub))) : [];
        break;
      case "description":
        out[name] = null;
        break;
      case "specifiedByURL":
        out[name] = null;
        break;
      default:
        ctx0.errors.push({ message: `Cannot query field '${sel.field}' on type '__Type'.`, path: [name] });
        out[name] = null;
    }
  }
  return out;
}

const ctx0: Ctx = { errors: [], vars: {}, frags: new Map() };

// ---------------- mutations ----------------

function resolveMutationRoot(store: ForgeStore, ctx: Ctx, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const name = sel.alias ?? sel.field ?? "";
    const args = selectArgs(sel, ctx);
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (sel.field) {
      case "createIssue": {
        const repo = repoById(store, String(input.repositoryId ?? ""));
        if (!repo) {
          ctx.errors.push({ message: `Could not resolve to a node with the global id of '${input.repositoryId}'` });
          out[name] = null;
          break;
        }
        const issue = store.createIssue(repo, String(input.title ?? ""), String(input.body ?? ""), [], store.tokenOwner ?? "forge");
        out[name] = { issue: projectIssue(store, ctx, repo, issue, payloadSub(sel, "issue")), clientMutationId: input.clientMutationId ?? null };
        break;
      }
      case "closeIssue": {
        const node = findIssueNode(store, String(input.issueId ?? ""));
        if (!node) {
          ctx.errors.push({ message: `Could not resolve to a node with the global id of '${input.issueId}'` });
          out[name] = null;
          break;
        }
        node.issue.state = "closed";
        node.issue.closed_at = store.now();
        node.issue.updated_at = store.now();
        out[name] = { issue: projectIssue(store, ctx, node.repo, node.issue, payloadSub(sel, "issue")), clientMutationId: input.clientMutationId ?? null };
        break;
      }
      case "reopenIssue": {
        const node = findIssueNode(store, String(input.issueId ?? ""));
        if (!node) {
          out[name] = null;
          break;
        }
        node.issue.state = "open";
        node.issue.closed_at = null;
        node.issue.updated_at = store.now();
        out[name] = { issue: projectIssue(store, ctx, node.repo, node.issue, payloadSub(sel, "issue")), clientMutationId: input.clientMutationId ?? null };
        break;
      }
      case "createPullRequest": {
        const repo = repoById(store, String(input.repositoryId ?? ""));
        if (!repo) {
          ctx.errors.push({ message: `Could not resolve to a node with the global id of '${input.repositoryId}'` });
          out[name] = null;
          break;
        }
        const head = String(input.headRefName ?? "");
        const base = String(input.baseRefName ?? "");
        const headSha = store.resolveRef(repo, head);
        const baseSha = store.resolveRef(repo, base);
        if (!headSha || !baseSha) {
          ctx.errors.push({ message: `Head ref or base ref could not be resolved.` });
          out[name] = null;
          break;
        }
        const pr = store.createPull(repo, String(input.title ?? ""), String(input.body ?? ""), head, base, store.tokenOwner ?? "forge");
        out[name] = { pullRequest: projectPull(store, ctx, repo, pr, payloadSub(sel, "pullRequest")), clientMutationId: input.clientMutationId ?? null };
        break;
      }
      case "mergePullRequest": {
        const parsed = fromNodeId(String(input.pullRequestId ?? ""));
        if (!parsed || !parsed.key.startsWith("pull:")) {
          ctx.errors.push({ message: `Could not resolve to a node with the global id of '${input.pullRequestId}'` });
          out[name] = null;
          break;
        }
        const [, repoKey, numStr] = parsed.key.split(":");
        const [owner, rname] = repoKey.split("/");
        const repo = store.getRepo(owner, rname);
        if (!repo) {
          out[name] = null;
          break;
        }
        const pr = repo.pulls.get(parseInt(numStr, 10));
        if (!pr || pr.merged || pr.state !== "open") {
          ctx.errors.push({ message: "Pull Request is not mergeable" });
          out[name] = null;
          break;
        }
        const headSha = store.resolveRef(repo, pr.head);
        const baseSha = store.resolveRef(repo, pr.base);
        if (!headSha || !baseSha) {
          ctx.errors.push({ message: "Pull Request is not mergeable" });
          out[name] = null;
          break;
        }
        const mergeBase = findMergeBase(store, repo, baseSha, headSha);
        const baseChanged = store.diffTrees(repo, mergeBase, baseSha).map((d) => d.filename);
        const headChanged = new Set(store.diffTrees(repo, mergeBase, headSha).map((d) => d.filename));
        if (baseChanged.some((f) => headChanged.has(f))) {
          ctx.errors.push({ message: "Pull Request is not mergeable" });
          out[name] = null;
          break;
        }
        const headTree = store.getObject(repo, headSha)!;
        const tree = parseCommit(headTree.data).tree;
        const commitSha = store.putObject(
          repo,
          "commit",
          commitBody(tree, [baseSha], String(input.commitHeadline ?? `${pr.title} (#${pr.number})`), store.tokenOwner ?? "forge")
        );
        repo.refs.set(`refs/heads/${pr.base}`, commitSha);
        pr.merged = true;
        pr.merged_at = store.now();
        pr.merge_commit_sha = commitSha;
        pr.state = "closed";
        pr.closed_at = store.now();
        pr.updated_at = store.now();
        out[name] = { pullRequest: projectPull(store, ctx, repo, pr, payloadSub(sel, "pullRequest")), clientMutationId: input.clientMutationId ?? null };
        break;
      }
      case "addComment": {
        const parsed = fromNodeId(String(input.subjectId ?? ""));
        if (!parsed || !(parsed.key.startsWith("issue:") || parsed.key.startsWith("pull:"))) {
          ctx.errors.push({ message: `Could not resolve to a node with the global id of '${input.subjectId}'` });
          out[name] = null;
          break;
        }
        const [, repoKey, numStr] = parsed.key.split(":");
        const [owner, rname] = repoKey.split("/");
        const repo = store.getRepo(owner, rname);
        if (!repo) {
          out[name] = null;
          break;
        }
        const n = parseInt(numStr, 10);
        const comment = store.addComment(repo, n, String(input.body ?? ""), store.tokenOwner ?? "forge");
        out[name] = {
          commentEdge: {
            node: { id: nodeId(`comment:${repoKey}:${n}:${comment.id}`), body: comment.body, createdAt: comment.created_at, __typename: "IssueComment" },
          },
          clientMutationId: input.clientMutationId ?? null,
        };
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field '${sel.field}' on type 'Mutation'.`, path: [name] });
        out[name] = null;
    }
  }
  return out;
}

function commitBody(tree: string, parents: string[], message: string, login: string): Buffer {
  const ts = Math.floor(BASE_TS / 1000);
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${login} <${login}@forge.local> ${ts} +0000`);
  lines.push(`committer ${login} <${login}@forge.local> ${ts} +0000`);
  return Buffer.from(lines.join("\n") + "\n\n" + message, "utf8");
}

const BASE_TS = Date.UTC(2026, 10, 15, 0, 0, 0);

/** The sub-selections of a payload field, e.g. issue{...} inside createIssue{...}. */
function payloadSub(sel: Selection, field: string): Selection[] {
  const inner = sel.sub.find((s) => s.field === field);
  return inner ? inner.sub : [];
}

function repoById(store: ForgeStore, id: string): ReturnType<ForgeStore["getRepo"]> {
  const parsed = fromNodeId(id);
  if (!parsed || !parsed.key.startsWith("repo:")) return undefined;
  const [owner, name] = parsed.key.slice(5).split("/");
  return store.getRepo(owner, name);
}

function findIssueNode(store: ForgeStore, id: string): { repo: NonNullable<ReturnType<ForgeStore["getRepo"]>>; issue: Issue } | undefined {
  const parsed = fromNodeId(id);
  if (!parsed || !parsed.key.startsWith("issue:")) return undefined;
  const [, repoKey, numStr] = parsed.key.split(":");
  const [owner, rname] = repoKey.split("/");
  const repo = store.getRepo(owner, rname);
  if (!repo) return undefined;
  const issue = repo.issues.get(parseInt(numStr, 10));
  if (!issue) return undefined;
  return { repo, issue };
}

function findMergeBase(store: ForgeStore, repo: NonNullable<ReturnType<ForgeStore["getRepo"]>>, a: string, b: string): string {
  const ancestorsA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (ancestorsA.has(s)) continue;
    ancestorsA.add(s);
    const obj = store.getObject(repo, s);
    if (obj && obj.type === "commit") stack.push(...parentsOf(obj.data));
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const s = queue.shift()!;
    if (seen.has(s)) continue;
    seen.add(s);
    if (ancestorsA.has(s)) return s;
    const obj = store.getObject(repo, s);
    if (obj && obj.type === "commit") queue.push(...parentsOf(obj.data));
  }
  return ZERO_SHA_GQL;
}

const ZERO_SHA_GQL = "0000000000000000000000000000000000000000";

export { DEFAULT_BRANCH_NAME };
void HttpError;
