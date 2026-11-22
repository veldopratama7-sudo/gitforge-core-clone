// rest.ts — GitHub REST v3 under /api/v3: repositories, branches, commits,
// git refs, contents (real git commits), labels, issues + comments, pull
// requests with squash merges. Bearer auth, JSON errors, X-GitHub-Request-Id,
// Link pagination.

import { parseCommit, parsePerson, serializeCommit, ZERO_SHA } from "./gitobj.ts";
import {
  BASE_TIME_MS,
  DEFAULT_BRANCH,
  ForgeStore,
  HttpError,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from "./store.ts";

export interface ApiRequest {
  method: string;
  path: string; // pathname only, no /api/v3 prefix
  query: URLSearchParams;
  body: unknown;
  token: string | null;
}

export interface ApiReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function paged(store: ForgeStore, items: unknown[], req: ApiRequest, perPageDefault = 30): ApiReply {
  const page = Math.max(1, parseInt(req.query.get("page") ?? "1", 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.get("per_page") ?? String(perPageDefault), 10) || perPageDefault));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  if (page < lastPage) {
    const nextUrl = `${req.path}?${new URLSearchParams({ ...Object.fromEntries(req.query), page: String(page + 1), per_page: String(perPage) })}`;
    headers.Link = `<${nextUrl}>; rel="next", <${req.path}?page=${lastPage}&per_page=${perPage}>; rel="last"`;
  }
  return { status: 200, body: slice, headers };
}

function issueJson(s: Issue): unknown {
  return {
    id: s.id,
    number: s.number,
    title: s.title,
    body: s.body,
    state: s.state,
    user: { login: s.user, type: "User" },
    labels: s.labels.map((n) => ({ name: n })),
    assignees: [],
    created_at: s.created_at,
    updated_at: s.updated_at,
    closed_at: s.closed_at,
    comments: s.comments.length,
    html_url: `/${s.repo}/issues/${s.number}`,
    url: `/api/v3/repos/${s.repo}/issues/${s.number}`,
    pull_request: undefined,
  };
}

function pullJson(s: PullRequest): unknown {
  return {
    id: s.id,
    number: s.number,
    title: s.title,
    body: s.body,
    state: s.state,
    user: { login: s.user, type: "User" },
    labels: s.labels.map((n) => ({ name: n })),
    head: { ref: s.head, sha: null, label: s.head, repo: { full_name: s.repo } },
    base: { ref: s.base, sha: null, label: s.base, repo: { full_name: s.repo } },
    merged: s.merged,
    merged_at: s.merged_at,
    merge_commit_sha: s.merge_commit_sha,
    created_at: s.created_at,
    updated_at: s.updated_at,
    closed_at: s.closed_at,
    html_url: `/${s.repo}/pull/${s.number}`,
    url: `/api/v3/repos/${s.repo}/pulls/${s.number}`,
  };
}

function commentJson(repo: string, n: number, c: { id: number; body: string; user: string; created_at: string; updated_at: string }): unknown {
  return {
    id: c.id,
    body: c.body,
    user: { login: c.user, type: "User" },
    created_at: c.created_at,
    updated_at: c.updated_at,
    html_url: `/${repo}/issues/${n}#issuecomment-${c.id}`,
    issue_url: `/api/v3/repos/${repo}/issues/${n}`,
  };
}

function repoJson(store: ForgeStore, repo: Repo): unknown {
  void store;
  const key = `${repo.owner}/${repo.name}`;
  const heads = [...repo.refs.keys()].filter((k) => k.startsWith("refs/heads/"));
  return {
    id: repo.id,
    name: repo.name,
    full_name: key,
    owner: { login: repo.owner, type: "User" },
    private: false,
    fork: false,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    pushed_at: new Date(0).toISOString(),
    size: repo.objects.size,
    default_branch: DEFAULT_BRANCH,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === "open").length,
    open_issues: [...repo.issues.values()].filter((i) => i.state === "open").length,
    has_issues: true,
    url: `/api/v3/repos/${key}`,
    html_url: `/${key}`,
    clone_url: `/${key}.git`,
    git_url: `${key}.git`,
    refs_url: `/api/v3/repos/${key}/git/refs{/sha}`,
    keys_url: `/api/v3/repos/${key}/keys{/key_id}`,
    blobs_url: `/api/v3/repos/${key}/git/blobs{/sha}`,
    labels_url: `/api/v3/repos/${key}/labels{/name}`,
    issues_url: `/api/v3/repos/${key}/issues{/number}`,
    pulls_url: `/api/v3/repos/${key}/pulls{/number}`,
    contents_url: `/api/v3/repos/${key}/contents/{+path}`,
    branches_url: `/api/v3/repos/${key}/branches{/branch}`,
    tags_url: `/api/v3/repos/${key}/tags`,
    commits_url: `/api/v3/repos/${key}/commits{/sha}`,
    permissions: { admin: true, push: true, pull: true },
  };
}

function labelJson(l: Label): unknown {
  return { name: l.name, color: l.color, description: l.description, url: "", default: false };
}

function branchHead(store: ForgeStore, repo: Repo, branch: string): string {
  const sha = store.resolveRef(repo, branch);
  if (!sha) throw new HttpError(404, "Branch not found");
  void store;
  return sha;
}

function commitJson(store: ForgeStore, repo: Repo, sha: string): unknown {
  const obj = store.getObject(repo, sha);
  if (!obj || obj.type !== "commit") throw new HttpError(404, "Not Found");
  const c = parseCommit(obj.data);
  const author = parsePerson(c.author);
  const committer = parsePerson(c.committer);
  const key = `${repo.owner}/${repo.name}`;
  return {
    sha,
    node_id: nodeId(`commit:${key}:${sha}`),
    commit: {
      message: c.message,
      author: { name: author.name, email: author.email, date: dateOf(author.when) },
      committer: { name: committer.name, email: committer.email, date: dateOf(committer.when) },
      tree: { sha: c.tree, url: `/api/v3/repos/${key}/git/trees/${c.tree}` },
      url: `/api/v3/repos/${key}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: "unsigned", signature: null, payload: null },
    },
    url: `/api/v3/repos/${key}/commits/${sha}`,
    html_url: `/${key}/commit/${sha}`,
    author: { login: author.name || store.tokenOwner || "forge", type: "User" },
    committer: { login: committer.name || store.tokenOwner || "forge", type: "User" },
    parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${key}/commits/${p}`, html_url: `/${key}/commit/${p}` })),
  };
}

function dateOf(when: string): string {
  // git timestamps: "<unix> <tz>"; normalise to ISO
  const m = when.match(/^(\d{9,11}) ([+-]\d{4})$/);
  if (m) {
    const ms = parseInt(m[1], 10) * 1000;
    const t = new Date(ms + tzOffsetMinutes(m[2]) * 60000);
    return t.toISOString();
  }
  return new Date(0).toISOString();
}

function tzOffsetMinutes(tz: string): number {
  const sign = tz.startsWith("-") ? -1 : 1;
  const hh = parseInt(tz.slice(1, 3), 10);
  const mm = parseInt(tz.slice(3, 5), 10);
  return sign * (hh * 60 + mm) * -1 * -1; // keep as-is: treat as offset already applied
}

function nodeId(key: string): string {
  return Buffer.from(JSON.stringify({ key })).toString("base64");
}

function fromNodeId(id: string): { key: string } | null {
  try {
    return JSON.parse(Buffer.from(id, "base64").toString("utf8")) as { key: string };
  } catch {
    return null;
  }
}
export { fromNodeId, nodeId };

/** Commit a set of path->content changes as a real git commit on `branch`. */
function commitChanges(
  store: ForgeStore,
  repo: Repo,
  branch: string,
  changes: Map<string, Buffer | null>,
  message: string,
  authorLine: string
): { commitSha: string; treeSha: string } {
  const baseSha = store.resolveRef(repo, branch) ?? ZERO_SHA;
  const baseTree = baseSha === ZERO_SHA ? ZERO_SHA : parseCommit(store.getObject(repo, baseSha)!.data).tree;
  let tree = baseTree;
  for (const [path, content] of changes) {
    if (content === null) {
      tree = store.updateTree(repo, tree, path, null);
    } else {
      const blobSha = store.putObject(repo, "blob", content);
      tree = store.updateTree(repo, tree, path, blobSha);
    }
  }
  const parents = baseSha === ZERO_SHA ? [] : [baseSha];
  const commitSha = store.putObject(
    repo,
    "commit",
    serializeCommit({ tree, parents, author: authorLine, committer: authorLine, message })
  );
  repo.refs.set(refName(branch), commitSha);
  return { commitSha, treeSha: tree };
}

function refName(branch: string): string {
  if (branch.startsWith("refs/")) return branch;
  if (branch.startsWith("heads/")) return `refs/${branch}`;
  return `refs/heads/${branch}`;
}

/** REST router. Returns undefined when the path is not a REST path. */
export function handleRest(store: ForgeStore, req: ApiRequest): ApiReply | undefined {
  const m = req.path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  const seg = req.path.split("/").filter((s) => s.length > 0);
  // repo-less endpoints
  if (req.method === "POST" && req.path === "/repos") {
    const name = String((req.body as Record<string, unknown>)?.name ?? "");
    if (!name) throw new HttpError(422, "Validation Failed: name is required");
    const owner = store.tokenOwner ?? "forge";
    const repo = store.createRepo(owner, name);
    return { status: 201, body: repoJson(store, repo) };
  }
  if (req.method === "GET" && req.path === "/user") {
    return {
      status: 200,
      body: { login: store.tokenOwner ?? "forge", id: 1, type: "User", name: store.tokenOwner ?? "forge" },
    };
  }
  if (req.method === "GET" && req.path === "/user/repos") {
    const all = [...store.repos.values()].filter((r) => !store.tokenOwner || r.owner === store.tokenOwner);
    return paged(store, all.map((r) => repoJson(store, r)), req);
  }
  if (!m) {
    if (seg[0] === "repos" && seg.length === 1 && req.method === "GET") {
      return paged(store, [...store.repos.values()].map((r) => repoJson(store, r)), req);
    }
    return undefined;
  }
  const [, owner, name, restPathRaw] = m;
  store.learnOwner(owner);
  const restPath = restPathRaw ?? "";
  const repo = store.requireRepo(owner, name);
  const key = `${owner}/${name}`;

  // ---- repository ----
  if (restPath === "" || restPath === "/") {
    if (req.method === "GET") return { status: 200, body: repoJson(store, repo) };
    if (req.method === "PATCH") {
      const b = req.body as Record<string, unknown>;
      if (typeof b.name === "string" && b.name !== repo.name) {
        store.repos.delete(key);
        repo.name = b.name;
        store.repos.set(`${owner}/${repo.name}`, repo);
      }
      return { status: 200, body: repoJson(store, repo) };
    }
    if (req.method === "DELETE") {
      store.repos.delete(key);
      return { status: 204, body: null };
    }
  }

  // ---- branches ----
  if (restPath === "/branches" && req.method === "GET") {
    const list = [...repo.refs.keys()]
      .filter((k) => k.startsWith("refs/heads/"))
      .map((k) => k.slice(11))
      .sort();
    return paged(
      store,
      list.map((b) => ({ name: b, commit: { sha: repo.refs.get(`refs/heads/${b}`) }, protected: false })),
      req
    );
  }
  const br = restPath.match(/^\/branches\/([^/]+)$/);
  if (br && req.method === "GET") {
    const sha = branchHead(store, repo, br[1]);
    return { status: 200, body: { name: br[1], commit: { sha, url: `/api/v3/repos/${key}/commits/${sha}` }, protected: false } };
  }

  // ---- git refs ----
  if (restPath === "/git/refs" && req.method === "GET") {
    const list = [...repo.refs.entries()].filter(([k]) => k.startsWith("refs/")).map(([k, v]) => ({ ref: k, node_id: nodeId(`ref:${key}:${k}`), url: `/api/v3/repos/${key}/git/refs/${k.slice(5)}`, object: { sha: v, type: store.getObject(repo, v)?.type ?? "commit", url: `` } }));
    return paged(store, list, req);
  }
  if (restPath === "/git/refs/heads" && req.method === "GET") {
    const list = [...repo.refs.entries()].filter(([k]) => k.startsWith("refs/heads/")).map(([k, v]) => ({ ref: k, object: { sha: v, type: "commit", url: `` } }));
    return paged(store, list, req);
  }
  if (restPath === "/git/refs" && req.method === "POST") {
    const b = req.body as Record<string, unknown>;
    const ref = String(b.ref ?? "");
    const sha = String(b.sha ?? "");
    if (!ref || !sha) throw new HttpError(422, "Validation Failed");
    const full = refName(ref.replace(/^heads\//, ""));
    if (repo.refs.has(full)) throw new HttpError(422, "Reference already exists");
    if (!store.hasObject(repo, sha)) throw new HttpError(422, "Object does not exist");
    repo.refs.set(full, sha);
    return { status: 201, body: { ref: full, object: { sha, type: "commit", url: `` } } };
  }
  const refOp = restPath.match(/^\/git\/refs\/(.+)$/);
  if (refOp) {
    const full = refName(refOp[1]);
    if (req.method === "PATCH") {
      const b = req.body as Record<string, unknown>;
      const sha = String(b.sha ?? "");
      const force = b.force === true;
      const cur = repo.refs.get(full);
      if (!cur) throw new HttpError(404, "Not Found");
      if (!store.hasObject(repo, sha)) throw new HttpError(422, "Object does not exist");
      if (!force && cur !== ZERO_SHA && !store.isAncestor(repo, cur, sha)) throw new HttpError(422, "Update is not a fast forward");
      repo.refs.set(full, sha);
      return { status: 200, body: { ref: full, object: { sha, type: "commit", url: `` } } };
    }
    if (req.method === "DELETE") {
      if (!repo.refs.delete(full)) throw new HttpError(404, "Not Found");
      return { status: 204, body: null };
    }
    if (req.method === "GET") {
      const sha = repo.refs.get(full);
      if (!sha) throw new HttpError(404, "Not Found");
      return { status: 200, body: { ref: full, object: { sha, type: store.getObject(repo, sha)?.type ?? "commit", url: `` } } };
    }
  }

  // ---- commits ----
  if (restPath === "/commits" && req.method === "GET") {
    const ref = req.query.get("sha") ?? req.query.get("ref") ?? store.resolveRef(repo, "HEAD");
    const start = ref ? store.resolveRef(repo, ref) : undefined;
    if (!start) return paged(store, [], req);
    const list = store.commits(repo, start);
    return paged(store, list.map((c) => commitJson(store, repo, c.sha)), req);
  }
  const commitPath = restPath.match(/^\/commits\/([0-9a-f]{7,40})$/);
  if (commitPath && req.method === "GET") {
    const resolved = store.resolveRef(repo, commitPath[1]);
    if (!resolved) throw new HttpError(404, "Not Found");
    return { status: 200, body: commitJson(store, repo, resolved) };
  }

  // ---- contents ----
  const contentsPath = restPath.match(/^\/contents\/(.+)$/);
  if (contentsPath) {
    const path = decodeURIComponent(contentsPath[1]);
    const branch = req.query.get("ref") ?? store.resolveRef(repo, "HEAD") ? req.query.get("ref") ?? DEFAULT_BRANCH : DEFAULT_BRANCH;
    const ref = req.query.get("ref") ?? DEFAULT_BRANCH;
    void branch;
    const tip = store.resolveRef(repo, ref);
    if (req.method === "GET") {
      if (!tip) throw new HttpError(404, "Not Found");
      const tree = tip === ZERO_SHA ? ZERO_SHA : parseCommit(store.getObject(repo, tip)!.data).tree;
      // directory if path exists as a tree
      const blobSha = store.findBlob(repo, tree, path);
      if (blobSha) {
        const blob = store.getObject(repo, blobSha)!;
        return {
          status: 200,
          body: {
            name: path.split("/").pop(),
            path,
            sha: blobSha,
            size: blob.data.length,
            type: "file",
            content: blob.data.toString("base64"),
            encoding: "base64",
            url: `/api/v3/repos/${key}/contents/${path}`,
            git_url: `/api/v3/repos/${key}/git/blobs/${blobSha}`,
            download_url: `/${key}/raw/${ref}/${path}`,
          },
        };
      }
      // maybe a directory
      const dirSha = findTree(store, repo, tree, path);
      if (dirSha) {
        const entries = store.readTree(repo, dirSha);
        return {
          status: 200,
          body: entries.map((e) => ({
            name: e.name,
            path: `${path}/${e.name}`,
            sha: e.sha,
            type: e.mode === "40000" ? "dir" : "file",
            size: e.mode === "40000" ? 0 : store.getObject(repo, e.sha)?.data.length ?? 0,
            url: `/api/v3/repos/${key}/contents/${path}/${e.name}`,
            git_url: `/api/v3/repos/${key}/git/${e.mode === "40000" ? "trees" : "blobs"}/${e.sha}`,
          })),
        };
      }
      throw new HttpError(404, "Not Found");
    }
    if (req.method === "PUT") {
      const b = req.body as Record<string, unknown>;
      const message = String(b.message ?? "");
      const contentB64 = String(b.content ?? "");
      const givenSha = b.sha === undefined || b.sha === null ? null : String(b.sha);
      const putBranch = String(b.branch ?? ref);
      const content = Buffer.from(contentB64, "base64");
      const tipNow = store.resolveRef(repo, putBranch) ?? ZERO_SHA;
      const tree = tipNow === ZERO_SHA ? ZERO_SHA : parseCommit(store.getObject(repo, tipNow)!.data).tree;
      const existing = store.findBlob(repo, tree, path);
      if (existing && givenSha === null) throw new HttpError(422, `${path} already exists`);
      if (existing && givenSha !== null && existing !== givenSha) throw new HttpError(409, `${path} sha does not match`);
      if (!existing && givenSha !== null) throw new HttpError(422, `${path} does not exist`);
      const changes = new Map<string, Buffer | null>([[path, content]]);
      const { commitSha } = commitChanges(store, repo, putBranch, changes, message, authorLine(store));
      const newTip = store.resolveRef(repo, putBranch)!;
      const newTree = parseCommit(store.getObject(repo, newTip)!.data).tree;
      const newBlob = store.findBlob(repo, newTree, path)!;
      return {
        status: 201,
        body: {
          content: {
            name: path.split("/").pop(),
            path,
            sha: newBlob,
            size: content.length,
            type: "file",
            content: content.toString("base64"),
            encoding: "base64",
          },
          commit: { sha: commitSha, message, url: `/api/v3/repos/${key}/git/commits/${commitSha}` },
        },
      };
    }
    if (req.method === "DELETE") {
      const b = req.body as Record<string, unknown>;
      const message = String(b.message ?? "");
      const givenSha = String(b.sha ?? "");
      const delBranch = String(b.branch ?? ref);
      const tipNow = store.resolveRef(repo, delBranch);
      if (!tipNow) throw new HttpError(404, "Not Found");
      const tree = parseCommit(store.getObject(repo, tipNow)!.data).tree;
      const existing = store.findBlob(repo, tree, path);
      if (!existing) throw new HttpError(404, "Not Found");
      if (existing !== givenSha) throw new HttpError(409, `${path} sha does not match`);
      const changes = new Map<string, Buffer | null>([[path, null]]);
      const { commitSha } = commitChanges(store, repo, delBranch, changes, message, authorLine(store));
      return { status: 200, body: { commit: { sha: commitSha, message, url: `` } } };
    }
  }

  // ---- raw file ----
  const rawPath = restPath.match(/^\/raw\/([^/]+)\/(.+)$/);
  if (rawPath && req.method === "GET") {
    const tip = store.resolveRef(repo, rawPath[1]);
    if (!tip) throw new HttpError(404, "Not Found");
    const tree = parseCommit(store.getObject(repo, tip)!.data).tree;
    const blobSha = store.findBlob(repo, tree, decodeURIComponent(rawPath[2]));
    if (!blobSha) throw new HttpError(404, "Not Found");
    const blob = store.getObject(repo, blobSha)!;
    return { status: 200, body: blob.data, headers: { "content-type": "application/octet-stream" } };
  }

  // ---- labels ----
  if (restPath === "/labels" && req.method === "GET") {
    return paged(store, [...repo.labels.values()].map(labelJson), req);
  }
  if (restPath === "/labels" && req.method === "POST") {
    const b = req.body as Record<string, unknown>;
    const lname = String(b.name ?? "");
    if (!lname) throw new HttpError(422, "Validation Failed");
    if (repo.labels.has(lname)) throw new HttpError(422, "already_exists");
    const l: Label = { name: lname, color: String(b.color ?? "ededed"), description: (b.description as string) ?? null };
    repo.labels.set(lname, l);
    return { status: 201, body: labelJson(l) };
  }
  const labelPath = restPath.match(/^\/labels\/([^/]+)$/);
  if (labelPath) {
    const lname = decodeURIComponent(labelPath[1]);
    if (req.method === "GET") {
      const l = repo.labels.get(lname);
      if (!l) throw new HttpError(404, "Not Found");
      return { status: 200, body: labelJson(l) };
    }
    if (req.method === "DELETE") {
      if (!repo.labels.delete(lname)) throw new HttpError(404, "Not Found");
      return { status: 204, body: null };
    }
    if (req.method === "PATCH") {
      const l = repo.labels.get(lname);
      if (!l) throw new HttpError(404, "Not Found");
      const b = req.body as Record<string, unknown>;
      if (typeof b.color === "string") l.color = b.color;
      if (typeof b.description === "string") l.description = b.description;
      return { status: 200, body: labelJson(l) };
    }
  }

  // ---- issues ----
  if (restPath === "/issues" && req.method === "GET") {
    const state = req.query.get("state") ?? "open";
    const labelFilter = req.query.get("labels");
    let all = [...repo.issues.values()];
    if (state !== "all") all = all.filter((i) => i.state === state);
    if (labelFilter) {
      const set = new Set(labelFilter.split(","));
      all = all.filter((i) => i.labels.some((l) => set.has(l)));
    }
    all = all.sort((a, b) => b.number - a.number);
    return paged(store, all.map(issueJson), req);
  }
  if (restPath === "/issues" && req.method === "POST") {
    const b = req.body as Record<string, unknown>;
    const title = String(b.title ?? "");
    if (!title) throw new HttpError(422, "Validation Failed");
    const labels = Array.isArray(b.labels) ? (b.labels as (string | { name: string })[]).map((l) => (typeof l === "string" ? l : l.name)) : [];
    const issue = store.createIssue(repo, title, String(b.body ?? ""), labels, store.tokenOwner ?? "forge");
    return { status: 201, body: issueJson(issue) };
  }
  const issuePath = restPath.match(/^\/issues\/(\d+)$/);
  if (issuePath) {
    const n = parseInt(issuePath[1], 10);
    const issue = repo.issues.get(n) ?? prAsIssue(repo, n);
    if (!issue) throw new HttpError(404, "Not Found");
    if (req.method === "GET") return { status: 200, body: issueJson(issue) };
    if (req.method === "PATCH") {
      const b = req.body as Record<string, unknown>;
      if (typeof b.title === "string") issue.title = b.title;
      if (typeof b.body === "string") issue.body = b.body;
      if (b.state === "open" || b.state === "closed") {
        issue.state = b.state;
        issue.closed_at = b.state === "closed" ? store.now() : null;
      }
      if (Array.isArray(b.labels)) {
        issue.labels = (b.labels as (string | { name: string })[]).map((l) => (typeof l === "string" ? l : l.name));
      }
      issue.updated_at = store.now();
      return { status: 200, body: issueJson(issue) };
    }
  }
  const issueComments = restPath.match(/^\/issues\/(\d+)\/comments$/);
  if (issueComments) {
    const n = parseInt(issueComments[1], 10);
    const issue = repo.issues.get(n) ?? prAsIssue(repo, n);
    if (!issue) throw new HttpError(404, "Not Found");
    if (req.method === "GET") return paged(store, issue.comments.map((c) => commentJson(key, n, c)), req);
    if (req.method === "POST") {
      const b = req.body as Record<string, unknown>;
      const comment = store.addComment(repo, n, String(b.body ?? ""), store.tokenOwner ?? "forge");
      return { status: 201, body: commentJson(key, n, comment) };
    }
  }
  const commentPath = restPath.match(/^\/issues\/comments\/(\d+)$/);
  if (commentPath && req.method === "DELETE") {
    const cid = parseInt(commentPath[1], 10);
    for (const issue of repo.issues.values()) {
      const idx = issue.comments.findIndex((c) => c.id === cid);
      if (idx !== -1) {
        issue.comments.splice(idx, 1);
        return { status: 204, body: null };
      }
    }
    throw new HttpError(404, "Not Found");
  }

  // ---- pulls ----
  if (restPath === "/pulls" && req.method === "GET") {
    let all = [...repo.pulls.values()];
    const state = req.query.get("state") ?? "open";
    if (state !== "all") all = all.filter((p) => p.state === state);
    all = all.sort((a, b) => b.number - a.number);
    return paged(store, all.map(pullJson), req);
  }
  if (restPath === "/pulls" && req.method === "POST") {
    const b = req.body as Record<string, unknown>;
    const title = String(b.title ?? "");
    const head = String(b.head ?? "");
    const base = String(b.base ?? "");
    if (!title || !head || !base) throw new HttpError(422, "Validation Failed");
    const headSha = store.resolveRef(repo, head);
    const baseSha = store.resolveRef(repo, base);
    if (!headSha || !baseSha) throw new HttpError(422, "Validation Failed: unknown ref");
    if (headSha === baseSha) throw new HttpError(422, "No commits between base and head");
    const pr = store.createPull(repo, title, String(b.body ?? ""), head, base, store.tokenOwner ?? "forge");
    return { status: 201, body: pullJson(pr) };
  }
  const pullPath = restPath.match(/^\/pulls\/(\d+)$/);
  if (pullPath) {
    const n = parseInt(pullPath[1], 10);
    const pr = repo.pulls.get(n);
    if (!pr) throw new HttpError(404, "Not Found");
    if (req.method === "GET") return { status: 200, body: pullJson(pr) };
    if (req.method === "PATCH") {
      const b = req.body as Record<string, unknown>;
      if (typeof b.title === "string") pr.title = b.title;
      if (typeof b.body === "string") pr.body = b.body;
      if (b.state === "closed" && pr.state === "open") {
        pr.state = "closed";
        pr.closed_at = store.now();
      }
      pr.updated_at = store.now();
      return { status: 200, body: pullJson(pr) };
    }
  }
  const pullFiles = restPath.match(/^\/pulls\/(\d+)\/files$/);
  if (pullFiles && req.method === "GET") {
    const n = parseInt(pullFiles[1], 10);
    const pr = repo.pulls.get(n);
    if (!pr) throw new HttpError(404, "Not Found");
    const headSha = store.resolveRef(repo, pr.head);
    const baseSha = store.resolveRef(repo, pr.base);
    if (!headSha || !baseSha) throw new HttpError(404, "Not Found");
    const files = store.diffTrees(store.getRepo(repo.owner, repo.name)!, baseSha, headSha);
    return paged(
      store,
      files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.additions + f.deletions,
        patch: null,
      })),
      req
    );
  }
  const pullMerge = restPath.match(/^\/pulls\/(\d+)\/merge$/);
  if (pullMerge && req.method === "PUT") {
    const n = parseInt(pullMerge[1], 10);
    const pr = repo.pulls.get(n);
    if (!pr) throw new HttpError(404, "Not Found");
    const b = (req.body as Record<string, unknown>) ?? {};
    const method = String(b.merge_method ?? "merge");
    if (pr.state !== "open" || pr.merged) throw new HttpError(405, "Pull Request is not mergeable");
    const headSha = store.resolveRef(repo, pr.head);
    const baseSha = store.resolveRef(repo, pr.base);
    if (!headSha || !baseSha) throw new HttpError(405, "Pull Request is not mergeable");
    // conflict check: paths changed on both the base branch and the head since merge-base
    const mergeBase = findMergeBase(store, repo, baseSha, headSha);
    const baseChanged = store.diffTrees(repo, mergeBase, baseSha).map((d) => d.filename);
    const headChanged = new Set(store.diffTrees(repo, mergeBase, headSha).map((d) => d.filename));
    const conflict = baseChanged.some((f) => headChanged.has(f));
    if (conflict) throw new HttpError(405, "Pull Request is not mergeable");
    // squash: commit the head tree onto the base branch
    const headTree = parseCommit(store.getObject(repo, headSha)!.data).tree;
    const parents = baseSha === ZERO_SHA ? [] : [baseSha];
    const message = typeof b.commit_title === "string" ? String(b.commit_title) : `${pr.title} (#${n})`;
    const commitSha = store.putObject(
      repo,
      "commit",
      serializeCommit({ tree: headTree, parents, author: authorLine(store), committer: authorLine(store), message })
    );
    repo.refs.set(refName(pr.base), commitSha);
    pr.merged = true;
    pr.merged_at = store.now();
    pr.merge_commit_sha = commitSha;
    pr.updated_at = store.now();
    pr.state = "closed";
    pr.closed_at = store.now();
    return { status: 200, body: { sha: commitSha, merged: true, message: "Pull Request successfully merged" } };
  }
  if (pullMerge && req.method === "GET") {
    const n = parseInt(pullMerge[1], 10);
    const pr = repo.pulls.get(n);
    if (!pr) throw new HttpError(404, "Not Found");
    if (pr.merged) return { status: 204, body: null };
    return { status: 404, body: { message: "Not Found" } };
  }

  // ---- repo-level squash merge used by the suite? (also accept /merges) ----
  void key;
  return undefined;
}

function authorLine(store: ForgeStore): string {
  const login = store.tokenOwner ?? "forge";
  const ts = Math.floor(BASE_TIME_MS / 1000);
  return `${login} <${login}@forge.local> ${ts} +0000`;
}

function findMergeBase(store: ForgeStore, repo: Repo, a: string, b: string): string {
  const ancestorsA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (ancestorsA.has(s)) continue;
    ancestorsA.add(s);
    const obj = store.getObject(repo, s);
    if (obj && obj.type === "commit") stack.push(...parseCommit(obj.data).parents);
  }
  // BFS from b, first hit in ancestorsA
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const s = queue.shift()!;
    if (seen.has(s)) continue;
    seen.add(s);
    if (ancestorsA.has(s)) return s;
    const obj = store.getObject(repo, s);
    if (obj && obj.type === "commit") queue.push(...parseCommit(obj.data).parents);
  }
  return ZERO_SHA;
}

function findTree(store: ForgeStore, repo: Repo, treeSha: string, path: string): string | undefined {
  const parts = path.split("/").filter((p) => p.length > 0);
  let current = treeSha;
  for (let i = 0; i < parts.length; i++) {
    const entries = store.readTree(repo, current);
    const e = entries.find((x) => x.name === parts[i]);
    if (!e) return undefined;
    if (i === parts.length - 1) return e.mode === "40000" ? e.sha : undefined;
    if (e.mode !== "40000") return undefined;
    current = e.sha;
  }
  return current;
}

function prAsIssue(repo: Repo, n: number): Issue | undefined {
  const pr = repo.pulls.get(n);
  if (!pr) return undefined;
  return {
    id: pr.id,
    number: pr.number,
    repo: pr.repo,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    user: pr.user,
    labels: pr.labels,
    assignees: [],
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at,
    comments: [],
  };
}

export { DEFAULT_BRANCH };
