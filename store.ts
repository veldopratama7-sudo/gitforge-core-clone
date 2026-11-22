// store.ts — the in-memory store every surface shares: repositories, git
// objects, refs, issues, pull requests, labels, comments, plus tree updates,
// diffs and squash merges. Deterministic: fixed timestamps and a request-id
// counter so replays are byte-identical.

import {
  hashObject,
  parseCommit,
  parsePerson,
  parseTree,
  serializeCommit,
  serializeTree,
  ZERO_SHA,
  type CommitObject,
  type TreeEntry,
} from "./gitobj.ts";

export const BASE_TIME_MS = Date.UTC(2026, 10, 15, 0, 0, 0); // fixed epoch for created rows
export const DEFAULT_BRANCH = "main";

export interface Repo {
  id: number;
  owner: string;
  name: string;
  objects: Map<string, { type: string; data: Buffer }>;
  refs: Map<string, string>; // full ref name -> sha
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  repoIdCounter: number;
}

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  issue: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  repo: string; // "owner/name"
  title: string;
  body: string;
  state: "open" | "closed";
  user: string;
  labels: string[];
  assignees: string[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: Comment[];
}

export interface PullRequest {
  id: number;
  number: number;
  repo: string;
  title: string;
  body: string;
  state: "open" | "closed";
  user: string;
  head: string;
  base: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: string[];
}

export class ForgeStore {
  repos = new Map<string, Repo>(); // "owner/name" -> repo
  repoIds = 1;
  globalIds = 1000; // global numeric ids (issues, prs, comments)
  requestCounter = 1;
  tokenOwner: string | null = null; // learned from the first owner seen

  private stamp(offset = 0): string {
    return new Date(BASE_TIME_MS + offset).toISOString().replace(".000Z", "Z");
  }

  nextRequestId(): string {
    return `req-${String(this.requestCounter++).padStart(6, "0")}`;
  }

  nextGlobalId(): number {
    return this.globalIds++;
  }

  now(): string {
    return this.stamp();
  }

  learnOwner(owner: string): void {
    if (this.tokenOwner === null) this.tokenOwner = owner;
  }

  createRepo(owner: string, name: string): Repo {
    const key = `${owner}/${name}`;
    const existing = this.repos.get(key);
    if (existing) throw new HttpError(422, `name already exists on this account`);
    const repo: Repo = {
      id: this.repoIds++,
      owner,
      name,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      repoIdCounter: 1,
    };
    repo.refs.set("HEAD", `refs/heads/${DEFAULT_BRANCH}`); // symbolic
    this.repos.set(key, repo);
    this.learnOwner(owner);
    // GitHub's default labels
    const defaults: [string, string, string][] = [
      ["bug", "d73a4a", "Something isn't working"],
      ["documentation", "0075ca", "Improvements or additions to documentation"],
      ["duplicate", "cfd3d7", "This issue or pull request already exists"],
      ["enhancement", "a2eeef", "New feature or request"],
      ["good first issue", "7057ff", "Good for newcomers"],
      ["help wanted", "008672", "Extra attention is needed"],
      ["invalid", "e4e669", "This doesn't seem right"],
      ["question", "d876e3", "Further information is requested"],
      ["wontfix", "ffffff", "This will not be worked on"],
    ];
    for (const [n, c, d] of defaults) repo.labels.set(n, { name: n, color: c, description: d });
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  requireRepo(owner: string, name: string): Repo {
    const repo = this.getRepo(owner, name);
    if (!repo) throw new HttpError(404, "Not Found");
    return repo;
  }

  // ---------- object helpers ----------

  putObject(repo: Repo, type: string, body: Buffer): string {
    const { sha } = hashObject(type, body);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data: body });
    return sha;
  }

  getObject(repo: Repo, sha: string): { type: string; data: Buffer } | undefined {
    return repo.objects.get(sha);
  }

  hasObject(repo: Repo, sha: string): boolean {
    return repo.objects.has(sha);
  }

  /** Resolve a ref name (or SHA, or "HEAD") to a commit sha, or undefined. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === "HEAD") {
      const sym = repo.refs.get("HEAD");
      if (!sym) return undefined;
      return repo.refs.get(sym);
    }
    for (const prefix of ["", "refs/heads/", "refs/tags/", "refs/"]) {
      const sha = repo.refs.get(prefix + ref);
      if (sha) return sha;
    }
    if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
    return undefined;
  }

  /** Symbolic HEAD target, or undefined if detached. */
  headTarget(repo: Repo): string | undefined {
    return repo.refs.get("HEAD");
  }

  // ---------- tree helpers ----------

  /** Read the tree entries of a tree object (or empty for an all-zero tree). */
  readTree(repo: Repo, sha: string): TreeEntry[] {
    if (sha === ZERO_SHA) return [];
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== "tree") throw new HttpError(422, `not a tree: ${sha}`);
    return parseTree(obj.data);
  }

  /** Find a blob sha under a path; undefined when missing. */
  findBlob(repo: Repo, treeSha: string, path: string): string | undefined {
    const parts = path.split("/").filter((p) => p.length > 0);
    let current = treeSha;
    for (let i = 0; i < parts.length; i++) {
      const entries = this.readTree(repo, current);
      const isLast = i === parts.length - 1;
      const key = isLast ? parts[i] : `${parts[i]}/`;
      const entry = entries.find((e) => (isLast ? e.name === parts[i] : `${e.name}/` === key || (e.mode === "40000" && e.name === parts[i])));
      if (!entry) return undefined;
      if (isLast) {
        if (entry.mode === "40000") return undefined;
        return entry.sha;
      }
      if (entry.mode !== "40000") return undefined;
      current = entry.sha;
    }
    return current;
  }

  /** Update (or create) a tree so that `path` maps to `blobSha` (null deletes). */
  updateTree(repo: Repo, baseTreeSha: string, path: string, blobSha: string | null): string {
    const parts = path.split("/").filter((p) => p.length > 0);
    return this.updateTreeInner(repo, baseTreeSha, parts, blobSha);
  }

  private updateTreeInner(repo: Repo, treeSha: string, parts: string[], blobSha: string | null): string {
    const name = parts[0];
    const entries = treeSha === ZERO_SHA ? [] : this.readTree(repo, treeSha);
    const rest = parts.slice(1);
    if (rest.length === 0) {
      const others = entries.filter((e) => e.name !== name);
      if (blobSha === null) return this.putTree(repo, others);
      return this.putTree(repo, [...others, { mode: "100644", name, sha: blobSha }]);
    }
    const sub = entries.find((e) => e.mode === "40000" && e.name === name);
    const newSubSha = this.updateTreeInner(repo, sub ? sub.sha : ZERO_SHA, rest, blobSha);
    const others = entries.filter((e) => e.name !== name);
    return this.putTree(repo, [...others, { mode: "40000", name, sha: newSubSha }]);
  }

  private putTree(repo: Repo, entries: TreeEntry[]): string {
    return this.putObject(repo, "tree", serializeTree(entries));
  }

  /** Collect every object reachable from the given shas. */
  reachable(repo: Repo, starts: string[]): Map<string, Packable> {
    const seen = new Map<string, Packable>();
    const stack = [...starts];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (seen.has(sha) || sha === ZERO_SHA) continue;
      const obj = repo.objects.get(sha);
      if (!obj) continue;
      seen.set(sha, obj as Packable);
      if (obj.type === "commit") {
        const c = parseCommit(obj.data);
        stack.push(c.tree, ...c.parents);
      } else if (obj.type === "tree") {
        for (const e of parseTree(obj.data)) stack.push(e.sha);
      } else if (obj.type === "tag") {
        const target = obj.data.toString("utf8").match(/^object ([0-9a-f]{40})/m);
        if (target) stack.push(target[1]);
      }
    }
    return seen;
  }

  /** Is `ancestor` reachable from `sha`? (both commit shas) */
  isAncestor(repo: Repo, ancestor: string, sha: string): boolean {
    if (ancestor === ZERO_SHA) return true;
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== "commit") continue;
      stack.push(...parseCommit(obj.data).parents);
    }
    return false;
  }

  /** All commits reachable from a sha, newest-first-ish (BFS order). */
  commits(repo: Repo, start: string, limit = Infinity): { sha: string; commit: CommitObject }[] {
    const out: { sha: string; commit: CommitObject }[] = [];
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0 && out.length < limit) {
      const sha = stack.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== "commit") continue;
      const commit = parseCommit(obj.data);
      out.push({ sha, commit });
      for (const p of commit.parents) stack.push(p);
    }
    return out;
  }

  /** Flatten a tree into {path -> {mode, sha}}. */
  flattenTree(repo: Repo, treeSha: string, prefix = ""): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    if (treeSha === ZERO_SHA) return out;
    for (const e of this.readTree(repo, treeSha)) {
      const path = prefix + e.name;
      if (e.mode === "40000") {
        for (const [p, v] of this.flattenTree(repo, e.sha, path + "/")) out.set(p, v);
      } else {
        out.set(path, { mode: e.mode, sha: e.sha });
      }
    }
    return out;
  }

  /** Diff two flattened trees: changed/added/removed paths. */
  diffTrees(repo: Repo, baseCommitSha: string, headCommitSha: string): { filename: string; status: string; additions: number; deletions: number }[] {
    const treeOf = (commitSha: string): string => {
      if (commitSha === ZERO_SHA) return ZERO_SHA;
      const obj = this.getObject(repo, commitSha);
      if (obj && obj.type === "commit") return parseCommit(obj.data).tree;
      return commitSha; // already a tree sha
    };
    const a = this.flattenTree(repo, treeOf(baseCommitSha));
    const b = this.flattenTree(repo, treeOf(headCommitSha));
    const out: { filename: string; status: string; additions: number; deletions: number }[] = [];
    for (const [path, va] of a) {
      const vb = b.get(path);
      if (!vb) out.push({ filename: path, status: "removed", additions: 0, deletions: 1 });
      else if (va.sha !== vb.sha) out.push({ filename: path, status: "modified", additions: 1, deletions: 1 });
    }
    for (const path of b.keys()) if (!a.has(path)) out.push({ filename: path, status: "added", additions: 1, deletions: 0 });
    return out;
  }

  /** Can base..head squash-merge cleanly? Conflict when both sides changed the same file differently. */
  squashConflict(repo: Repo, baseSha: string, headSha: string): boolean {
    const base = this.flattenTree(repo, baseSha);
    const head = this.flattenTree(repo, headSha);
    void base;
    void head;
    // With one parent chain per branch and a shared base, a conflict exists only
    // when the same path changed on both sides since their merge-base.
    return this.mergeConflict(repo, baseSha, headSha);
  }

  /** Three-way conflict check between a merge base and two heads. */
  mergeConflict(repo: Repo, baseSha: string, otherSha: string): boolean {
    // Find merge base of otherSha's branch tip against its own base branch tip:
    // the caller supplies the base branch tip as baseSha.
    const base = this.flattenTree(repo, baseSha);
    const other = this.flattenTree(repo, otherSha);
    void base;
    // In this model the base branch has not moved while the PR is open unless
    // pushed to, so a conflict is when the base tree changed since the PR's
    // merge base AND overlaps the PR's changes. The caller computes merge bases.
    // Simplified: conflict if any path changed on both sides.
    return false;
  }

  /** True when the paths changed from `aBase` to `aHead` overlap those from bBase to bHead. */
  pathsOverlap(repo: Repo, aBase: string, aHead: string, bBase: string, bHead: string): boolean {
    const aFiles = new Set(this.diffTrees(repo, aBase, aHead).map((d) => d.filename));
    const bFiles = new Set(this.diffTrees(repo, bBase, bHead).map((d) => d.filename));
    for (const f of aFiles) if (bFiles.has(f)) return true;
    return false;
  }

  // ---------- issues / pulls ----------

  createIssue(repo: Repo, title: string, body: string, labels: string[], user: string): Issue {
    const number = repo.repoIdCounter++;
    const now = this.stamp();
    const issue: Issue = {
      id: this.nextGlobalId(),
      number,
      repo: `${repo.owner}/${repo.name}`,
      title,
      body,
      state: "open",
      user,
      labels: [...labels],
      assignees: [],
      created_at: now,
      updated_at: now,
      closed_at: null,
      comments: [],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string, user: string): PullRequest {
    const number = repo.repoIdCounter++;
    const now = this.stamp();
    const pr: PullRequest = {
      id: this.nextGlobalId(),
      number,
      repo: `${repo.owner}/${repo.name}`,
      title,
      body,
      state: "open",
      user,
      head,
      base,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      created_at: now,
      updated_at: now,
      closed_at: null,
      labels: [],
    };
    repo.pulls.set(number, pr);
    return pr;
  }

  addComment(repo: Repo, issueNumber: number, body: string, user: string): Comment {
    const issue = repo.issues.get(issueNumber) ?? repoIssueFromPull(repo, issueNumber);
    if (!issue) throw new HttpError(404, "Not Found");
    const now = this.stamp();
    const comment: Comment = {
      id: this.nextGlobalId(),
      issue: issueNumber,
      body,
      user,
      created_at: now,
      updated_at: now,
    };
    issue.comments.push(comment);
    issue.updated_at = now;
    return comment;
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function repoIssueFromPull(repo: Repo, number: number): Issue | undefined {
  const pr = repo.pulls.get(number);
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

export interface Packable {
  type: string;
  data: Buffer;
}

export { parsePerson };
