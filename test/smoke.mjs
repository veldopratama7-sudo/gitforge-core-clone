// test/smoke.mjs — exercise REST v3, GraphQL, MCP and auth against a live
// local server. Run: node --experimental-strip-types test/smoke.mjs
import assert from "node:assert";
import { startServer } from "../app.ts";

const TOKEN = "test-token";
const server = startServer(TOKEN);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
let passed = 0;
let failed = 0;

async function api(method, path, body, { auth = TOKEN, raw = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(auth !== null ? { authorization: auth === TOKEN ? `Bearer ${TOKEN}` : `Bearer ${auth}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers, text };
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

// ---------- auth ----------
await check("healthz no auth", async () => {
  const r = await api("GET", "/healthz");
  assert.equal(r.status, 200);
});
await check("wrong token -> 401", async () => {
  const r = await api("GET", "/api/v3/user", undefined, { auth: "wrong-token" });
  assert.equal(r.status, 401);
});
await check("no token -> 401", async () => {
  const r = await api("GET", "/api/v3/user", undefined, { auth: null });
  assert.equal(r.status, 401);
});
await check("request id header", async () => {
  const r = await api("GET", "/api/v3/user");
  assert.ok(r.headers.get("x-github-request-id"));
});

// ---------- repos ----------
await check("create repo", async () => {
  const r = await api("POST", "/api/v3/repos", { name: "alpha" });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, "alpha");
  assert.equal(r.body.default_branch, "main");
});
await check("duplicate repo -> 422", async () => {
  const r = await api("POST", "/api/v3/repos", { name: "alpha" });
  assert.equal(r.status, 422);
});
await check("get repo 404", async () => {
  const r = await api("GET", "/api/v3/repos/nobody/nothing");
  assert.equal(r.status, 404);
});

// ---------- contents ----------
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
await check("create file", async () => {
  const r = await api("PUT", "/api/v3/repos/forge/alpha/contents/README.md", { message: "add readme", content: b64("# Alpha\nhello\n"), branch: "main" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.commit.message, "add readme");
});
await check("get file", async () => {
  const r = await api("GET", "/api/v3/repos/forge/alpha/contents/README.md");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(Buffer.from(r.body.content, "base64").toString(), "# Alpha\nhello\n");
});
await check("create nested file", async () => {
  const r = await api("PUT", "/api/v3/repos/forge/alpha/contents/src/lib/hello.py", { message: "add py", content: b64("print('hi')\n"), branch: "main" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});
await check("get dir listing", async () => {
  const r = await api("GET", "/api/v3/repos/forge/alpha/contents/src/lib");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body) && r.body[0].name === "hello.py");
});
await check("update file with wrong sha -> 409", async () => {
  const r = await api("PUT", "/api/v3/repos/forge/alpha/contents/README.md", { message: "x", content: b64("x"), branch: "main", sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
  assert.equal(r.status, 409);
});
let readmeSha;
await check("update file ok", async () => {
  const get = await api("GET", "/api/v3/repos/forge/alpha/contents/README.md");
  readmeSha = get.body.sha;
  const r = await api("PUT", "/api/v3/repos/forge/alpha/contents/README.md", { message: "update readme", content: b64("# Alpha\nv2\n"), branch: "main", sha: readmeSha });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});
await check("delete file wrong sha -> 409", async () => {
  const r = await api("DELETE", "/api/v3/repos/forge/alpha/contents/README.md", { message: "d", sha: "bad", branch: "main" });
  assert.equal(r.status, 409);
});
await check("commits list", async () => {
  const r = await api("GET", "/api/v3/repos/forge/alpha/commits");
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 3);
  assert.ok(r.body[0].commit.message.includes("update readme"));
});
await check("single commit", async () => {
  const list = await api("GET", "/api/v3/repos/forge/alpha/commits");
  const r = await api("GET", `/api/v3/repos/forge/alpha/commits/${list.body[0].sha}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.commit.tree.sha);
});

// ---------- branches/refs ----------
await check("create branch", async () => {
  const head = await api("GET", "/api/v3/repos/forge/alpha/commits");
  const r = await api("POST", "/api/v3/repos/forge/alpha/git/refs", { ref: "refs/heads/feature", sha: head.body[0].sha });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});
await check("list branches", async () => {
  const r = await api("GET", "/api/v3/repos/forge/alpha/branches");
  assert.equal(r.status, 200);
  assert.ok(r.body.some((b) => b.name === "feature"));
});
await check("branch get", async () => {
  const r = await api("GET", "/api/v3/repos/forge/alpha/branches/feature");
  assert.equal(r.status, 200);
  assert.ok(r.body.commit.sha);
});

// ---------- labels/issues/comments ----------
await check("list default labels", async () => {
  const r = await api("GET", "/api/v3/repos/forge/alpha/labels");
  assert.equal(r.status, 200);
  assert.ok(r.body.some((l) => l.name === "bug"));
});
await check("create label", async () => {
  const r = await api("POST", "/api/v3/repos/forge/alpha/labels", { name: "urgent", color: "ff0000" });
  assert.equal(r.status, 201);
});
await check("create issue", async () => {
  const r = await api("POST", "/api/v3/repos/forge/alpha/issues", { title: "It broke", body: "badly", labels: ["bug"] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.state, "open");
});
await check("issue with label filter", async () => {
  const r = await api("GET", "/api/v3/repos/forge/alpha/issues?labels=bug");
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
});
await check("comment on issue", async () => {
  const r = await api("POST", "/api/v3/repos/forge/alpha/issues/1/comments", { body: "me too" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});
await check("list comments", async () => {
  const r = await api("GET", "/api/v3/repos/forge/alpha/issues/1/comments");
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
});
await check("close issue", async () => {
  const r = await api("PATCH", "/api/v3/repos/forge/alpha/issues/1", { state: "closed" });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, "closed");
});
await check("closed filter", async () => {
  const r = await api("GET", "/api/v3/repos/forge/alpha/issues?state=closed");
  assert.equal(r.body.length, 1);
});

// ---------- pulls + squash merge ----------
let prNumber;
await check("create pull", async () => {
  const feature = await api("GET", "/api/v3/repos/forge/alpha/branches/feature");
  await api("PUT", "/api/v3/repos/forge/alpha/contents/newfile.txt", { message: "on feature", content: b64("new\n"), branch: "feature" });
  const r = await api("POST", "/api/v3/repos/forge/alpha/pulls", { title: "Add newfile", head: "feature", base: "main" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  prNumber = r.body.number;
  void feature;
});
await check("pull files", async () => {
  const r = await api("GET", `/api/v3/repos/forge/alpha/pulls/${prNumber}/files`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.some((f) => f.filename === "newfile.txt"));
});
await check("squash merge", async () => {
  const r = await api("PUT", `/api/v3/repos/forge/alpha/pulls/${prNumber}/merge`, { merge_method: "squash" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.merged, true);
});
await check("merge state readable", async () => {
  const r = await api("GET", `/api/v3/repos/forge/alpha/pulls/${prNumber}/merge`);
  assert.equal(r.status, 204);
});
await check("file visible on main after merge", async () => {
  const r = await api("GET", "/api/v3/repos/forge/alpha/contents/newfile.txt?ref=main");
  assert.equal(r.status, 200, JSON.stringify(r.body));
});
await check("second merge of merged pr -> 405", async () => {
  const r = await api("PUT", `/api/v3/repos/forge/alpha/pulls/${prNumber}/merge`, { merge_method: "squash" });
  assert.equal(r.status, 405);
});
await check("create issue 2", async () => { await api("POST", "/api/v3/repos/forge/alpha/issues", { title: "i2" }); });
await check("create issue 3", async () => { await api("POST", "/api/v3/repos/forge/alpha/issues", { title: "i3" }); });
await check("pagination link", async () => {
  const r = await api("GET", "/api/v3/repos/forge/alpha/issues?state=all&per_page=1&page=1");
  assert.ok(r.headers.get("link")?.includes('rel="next"'), JSON.stringify(r.headers.get("link")));
});

// ---------- GraphQL ----------
async function gql(query, variables = {}) {
  const r = await api("POST", "/api/graphql", { query, variables });
  return r.body;
}
await check("viewer", async () => {
  const r = await gql(`{ viewer { login } }`);
  assert.deepEqual(r.data.viewer.login, "forge");
});
await check("repository issues", async () => {
  const r = await gql(`query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ nameWithOwner issues(first:10){ totalCount nodes{ number title state } } } }`, { owner: "forge", name: "alpha" });
  assert.equal(r.data.repository.nameWithOwner, "forge/alpha");
  assert.ok(r.data.repository.issues.nodes.length >= 1);
});
await check("issues cursor pagination", async () => {
  for (let i = 0; i < 3; i++) await api("POST", "/api/v3/repos/forge/alpha/issues", { title: `p${i}` });
  const page1 = await gql(`query{ repository(owner:"forge",name:"alpha"){ issues(first:2){ nodes{ number } pageInfo{ hasNextPage endCursor } } } }`);
  assert.equal(page1.data.repository.issues.nodes.length, 2);
  assert.equal(page1.data.repository.issues.pageInfo.hasNextPage, true);
  const page2 = await gql(`query($c:String){ repository(owner:"forge",name:"alpha"){ issues(first:2,after:$c){ nodes{ number } } } }`, { c: page1.data.repository.issues.pageInfo.endCursor });
  assert.ok(page2.data.repository.issues.nodes.length >= 1);
});
await check("node lookup", async () => {
  const r = await gql(`query{ repository(owner:"forge",name:"alpha"){ issues(first:1){ nodes{ id } } } }`);
  const id = r.data.repository.issues.nodes[0].id;
  const n = await gql(`query($id:ID!){ node(id:$id){ ... on Issue { number title } } }`, { id });
  assert.ok(n.data.node.number >= 1);
});
await check("mutation createIssue + addComment + closeIssue", async () => {
  const repoId = await gql(`query{ repository(owner:"forge",name:"alpha"){ id } }`);
  const created = await gql(`mutation($input:CreateIssueInput!){ createIssue(input:$input){ issue{ number id } } }`, { input: { repositoryId: repoId.data.repository.id, title: "gql issue", body: "via graphql" } });
  assert.ok(created.data.createIssue.issue.number >= 1);
  const c = await gql(`mutation($input:AddCommentInput!){ addComment(input:$input){ commentEdge{ node{ body } } } }`, { input: { subjectId: created.data.createIssue.issue.id, body: "a comment" } });
  assert.equal(c.data.addComment.commentEdge.node.body, "a comment");
  const closed = await gql(`mutation($input:CloseIssueInput!){ closeIssue(input:$input){ issue{ state } } }`, { input: { issueId: created.data.createIssue.issue.id } });
  assert.equal(closed.data.closeIssue.issue.state, "CLOSED");
});
await check("mutation createPullRequest + mergePullRequest", async () => {
  await api("PUT", "/api/v3/repos/forge/alpha/contents/gql.txt", { message: "gql branch", content: b64("g\n"), branch: "gqlbranch" });
  const repoId = await gql(`query{ repository(owner:"forge",name:"alpha"){ id } }`);
  const pr = await gql(`mutation($input:CreatePullRequestInput!){ createPullRequest(input:$input){ pullRequest{ number id state } } }`, { input: { repositoryId: repoId.data.repository.id, title: "gql pr", headRefName: "gqlbranch", baseRefName: "main" } });
  assert.ok(pr.data.createPullRequest.pullRequest.number >= 1);
  const merged = await gql(`mutation($input:MergePullRequestInput!){ mergePullRequest(input:$input){ pullRequest{ merged state } } }`, { input: { pullRequestId: pr.data.createPullRequest.pullRequest.id, mergeMethod: "SQUASH" } });
  assert.equal(merged.data.mergePullRequest.pullRequest.merged, true);
});
await check("unknown field -> 200 with errors", async () => {
  const r = await gql(`{ viewer { nope } }`);
  assert.ok(r.errors?.some((e) => e.message.includes("nope")));
  assert.equal(r.data.viewer.nope, undefined);
});
await check("introspection __type", async () => {
  const r = await gql(`query{ __type(name:"Repository"){ name fields{ name } } }`);
  assert.equal(r.data.__type.name, "Repository");
  assert.ok(r.data.__type.fields.some((f) => f.name === "issues"));
});
await check("introspection __schema", async () => {
  const r = await gql(`query{ __schema{ queryType{ name } mutationType{ name } } }`);
  assert.equal(r.data.__schema.queryType.name, "Query");
  assert.equal(r.data.__schema.mutationType.name, "Mutation");
});

// ---------- MCP ----------
async function rpc(method, params = {}, id = 1) {
  const r = await api("POST", "/mcp", { jsonrpc: "2.0", id, method, params });
  return r;
}
await check("mcp initialize", async () => {
  const r = await rpc("initialize", { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(r.status, 200);
  assert.ok(["2026-07-28", "2025-06-18", "2024-11-05"].includes(r.body.result.protocolVersion));
  assert.equal(r.body.result.serverInfo.name, "gitforge");
});
await check("mcp notification -> 202", async () => {
  const r = await api("POST", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(r.status, 202);
});
await check("mcp tools/list", async () => {
  const r = await rpc("tools/list");
  const names = r.body.result.tools.map((t) => t.name);
  for (const n of ["create_repo", "get_repo", "create_issue", "list_issues", "create_pull_request", "merge_pull_request"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  assert.ok(r.body.result.tools.every((t) => typeof t.annotations?.readOnlyHint === "boolean"));
});
await check("mcp tools/call create_repo + create_issue", async () => {
  const c = await rpc("tools/call", { name: "create_repo", arguments: { owner: "forge", name: "mcprepo" } });
  assert.ok(c.body.result.content[0].text.includes("mcprepo"));
  const i = await rpc("tools/call", { name: "create_issue", arguments: { owner: "forge", repo: "mcprepo", title: "from mcp", body: "b" } });
  assert.ok(i.body.result.content[0].text.includes('"number":1'));
});
await check("mcp unknown method -> -32601", async () => {
  const r = await rpc("bogus/method");
  assert.equal(r.body.error.code, -32601);
});

console.log(`\nsmoke: ${passed} passed, ${failed} failed`);
server.close();
process.exit(failed === 0 ? 0 : 1);
