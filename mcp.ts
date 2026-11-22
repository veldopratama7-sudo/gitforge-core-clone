// mcp.ts — MCP over Streamable HTTP at /mcp: initialize (and the newer
// server/discover), tools/list, tools/call. JSON-RPC 2.0, batched requests
// accepted. The tools share the forge store with every other surface.

import { ForgeStore } from "./store.ts";
import { nodeId } from "./rest.ts";

export interface McpReply {
  status: number;
  body: unknown;
}

const PROTOCOL_VERSION = "2026-07-28";

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOL_DEFS = [
  {
    name: "create_repo",
    description: "Create a new repository",
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: false,
    schema: {
      type: "object",
      properties: { owner: { type: "string", description: "Repository owner" }, name: { type: "string", description: "Repository name" }, description: { type: "string" }, private: { type: "boolean" } },
      required: ["name"],
    },
  },
  {
    name: "get_repo",
    description: "Get a repository",
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    schema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" } },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository",
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: false,
    schema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" }, labels: { type: "array", items: { type: "string" } } },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository",
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    schema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string", enum: ["open", "closed", "all"] } },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_pull_request",
    description: "Create a pull request",
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: false,
    schema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" }, head: { type: "string" }, base: { type: "string" } },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request (squash)",
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: false,
    schema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, number: { type: "number" }, merge_method: { type: "string", enum: ["merge", "squash", "rebase"] } },
      required: ["owner", "repo", "number"],
    },
  },
  {
    name: "list_pull_requests",
    description: "List pull requests in a repository",
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    schema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string", enum: ["open", "closed", "all"] } },
      required: ["owner", "repo"],
    },
  },
  {
    name: "close_issue",
    description: "Close an issue",
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: false,
    schema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, number: { type: "number" } },
      required: ["owner", "repo", "number"],
    },
  },
];

function toolList(): unknown {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.schema,
    annotations: {
      title: t.name,
      readOnlyHint: t.readOnly,
      destructiveHint: t.destructive,
      idempotentHint: t.idempotent,
      openWorldHint: t.openWorld,
    },
  }));
}

export function handleMcp(store: ForgeStore, raw: unknown): McpReply {
  if (Array.isArray(raw)) {
    const results = raw.map((r) => handleRpc(store, r as RpcRequest)).filter((x) => x !== undefined);
    return { status: 200, body: results };
  }
  const reply = handleRpc(store, raw as RpcRequest);
  if (reply === undefined) return { status: 202, body: undefined };
  return { status: 200, body: reply };
}

function handleRpc(store: ForgeStore, req: RpcRequest): unknown {
  const method = String(req.method ?? "");
  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "gitforge", title: "GitHub-compatible git forge", version: "1.0.0" },
          instructions: "A GitHub-compatible forge: repos, issues, pull requests over git, REST v3, GraphQL and these tools.",
        },
      };
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined; // notification: no response
    case "ping":
      return { jsonrpc: "2.0", id: req.id ?? null, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id: req.id ?? null, result: { tools: toolList() } };
    case "server/discover":
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: { tools: toolList(), serverInfo: { name: "gitforge", version: "1.0.0" } },
      };
    case "tools/call": {
      const params = req.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      return callTool(store, req.id ?? null, name, args);
    }
    default:
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

function toolError(id: unknown, message: string): unknown {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: message }], isError: true },
  };
}

function toolText(id: unknown, value: unknown): unknown {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(value) }] },
  };
}

function callTool(store: ForgeStore, id: unknown, name: string, args: Record<string, unknown>): unknown {
  const owner = String(args.owner ?? store.tokenOwner ?? "forge");
  const repoName = String(args.repo ?? args.name ?? "");
  const repoKey = `${owner}/${repoName}`;
  try {
    switch (name) {
      case "create_repo": {
        store.learnOwner(owner);
        const repo = store.createRepo(owner, repoName);
        return toolText(id, { full_name: repoKey, name: repo.name, owner, id: nodeId(`repo:${repoKey}`), url: `/api/v3/repos/${repoKey}` });
      }
      case "get_repo": {
        const repo = store.getRepo(owner, repoName);
        if (!repo) return toolError(id, `Repository not found: ${repoKey}`);
        return toolText(id, { full_name: repoKey, name: repo.name, owner, default_branch: "main", id: nodeId(`repo:${repoKey}`) });
      }
      case "create_issue": {
        const repo = store.requireRepo(owner, repoName);
        const title = String(args.title ?? "");
        if (!title) return toolError(id, "title is required");
        const labels = Array.isArray(args.labels) ? (args.labels as string[]) : [];
        const issue = store.createIssue(repo, title, String(args.body ?? ""), labels, owner);
        return toolText(id, { number: issue.number, id: nodeId(`issue:${repoKey}:${issue.number}`), title: issue.title, state: issue.state, url: `/${repoKey}/issues/${issue.number}` });
      }
      case "list_issues": {
        const repo = store.requireRepo(owner, repoName);
        const state = String(args.state ?? "open");
        let issues = [...repo.issues.values()];
        if (state !== "all") issues = issues.filter((i) => i.state === state);
        issues = issues.sort((a, b) => b.number - a.number);
        return toolText(id, issues.map((i) => ({ number: i.number, title: i.title, state: i.state, labels: i.labels, body: i.body, url: `/${repoKey}/issues/${i.number}` })));
      }
      case "create_pull_request": {
        const repo = store.requireRepo(owner, repoName);
        const title = String(args.title ?? "");
        const head = String(args.head ?? "");
        const base = String(args.base ?? "");
        const headSha = store.resolveRef(repo, head);
        const baseSha = store.resolveRef(repo, base);
        if (!headSha || !baseSha) return toolError(id, `Head ref or base ref could not be resolved`);
        const pr = store.createPull(repo, title, String(args.body ?? ""), head, base, owner);
        return toolText(id, { number: pr.number, id: nodeId(`pull:${repoKey}:${pr.number}`), title: pr.title, state: pr.state, url: `/${repoKey}/pull/${pr.number}` });
      }
      case "list_pull_requests": {
        const repo = store.requireRepo(owner, repoName);
        const state = String(args.state ?? "open");
        let pulls = [...repo.pulls.values()];
        if (state !== "all") pulls = pulls.filter((p) => p.state === state);
        pulls = pulls.sort((a, b) => b.number - a.number);
        return toolText(id, pulls.map((p) => ({ number: p.number, title: p.title, state: p.merged ? "merged" : p.state, head: p.head, base: p.base, url: `/${repoKey}/pull/${p.number}` })));
      }
      case "merge_pull_request": {
        const repo = store.requireRepo(owner, repoName);
        const n = Number(args.number ?? 0);
        const pr = repo.pulls.get(n);
        if (!pr) return toolError(id, `Pull request not found: #${n}`);
        if (pr.state !== "open" || pr.merged) return toolError(id, "Pull Request is not mergeable");
        const headSha = store.resolveRef(repo, pr.head);
        const baseSha = store.resolveRef(repo, pr.base);
        if (!headSha || !baseSha) return toolError(id, "Pull Request is not mergeable");
        const mergeBase = mergeBaseOf(store, repo, baseSha, headSha);
        const baseChanged = store.diffTrees(repo, mergeBase, baseSha).map((d) => d.filename);
        const headChanged = new Set(store.diffTrees(repo, mergeBase, headSha).map((d) => d.filename));
        if (baseChanged.some((f) => headChanged.has(f))) return toolError(id, "Pull Request is not mergeable");
        const headTreeObj = store.getObject(repo, headSha)!;
        const text = headTreeObj.data.toString("utf8");
        const sep = text.indexOf("\n\n");
        void sep;
        const treeLine = text.split("\n").find((l) => l.startsWith("tree "))!;
        const tree = treeLine.slice(5);
        const ts = Math.floor(Date.parse(store.now()) / 1000);
        const lines = [`tree ${tree}`, `parent ${baseSha}`];
        const who = `${owner} <${owner}@forge.local> ${ts} +0000`;
        lines.push(`author ${who}`, `committer ${who}`);
        const commitSha = store.putObject(repo, "commit", Buffer.from(lines.join("\n") + "\n\n" + `${pr.title} (#${n})\n`, "utf8"));
        repo.refs.set(`refs/heads/${pr.base}`, commitSha);
        pr.merged = true;
        pr.merged_at = store.now();
        pr.merge_commit_sha = commitSha;
        pr.state = "closed";
        pr.closed_at = store.now();
        pr.updated_at = store.now();
        return toolText(id, { merged: true, sha: commitSha, number: n });
      }
      case "close_issue": {
        const repo = store.requireRepo(owner, repoName);
        const n = Number(args.number ?? 0);
        const issue = repo.issues.get(n);
        if (!issue) return toolError(id, `Issue not found: #${n}`);
        issue.state = "closed";
        issue.closed_at = store.now();
        issue.updated_at = store.now();
        return toolText(id, { number: n, state: "closed" });
      }
      default:
        return toolError(id, `Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "tool failed";
    return toolError(id, message);
  }
}

function mergeBaseOf(store: ForgeStore, repo: NonNullable<ReturnType<ForgeStore["getRepo"]>>, a: string, b: string): string {
  const ancestorsA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (ancestorsA.has(s)) continue;
    ancestorsA.add(s);
    const obj = store.getObject(repo, s);
    if (obj && obj.type === "commit") {
      const parents = obj.data.toString("utf8").split("\n").filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
      stack.push(...parents);
    }
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const s = queue.shift()!;
    if (seen.has(s)) continue;
    seen.add(s);
    if (ancestorsA.has(s)) return s;
    const obj = store.getObject(repo, s);
    if (obj && obj.type === "commit") {
      const parents = obj.data.toString("utf8").split("\n").filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
      queue.push(...parents);
    }
  }
  return "0000000000000000000000000000000000000000";
}
