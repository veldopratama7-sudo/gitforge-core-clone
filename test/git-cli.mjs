// test/git-cli.mjs — drive the forge with a real git client over smart HTTP.
import assert from "node:assert";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = "test-token";
// The server must run in a SEPARATE process: git() uses execSync, which blocks
// this process's event loop and would deadlock an in-process HTTP server.
const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, ["--experimental-strip-types", join(here, "server-child.mjs"), TOKEN], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env },
});
let base = "";
for await (const line of child.stdout) {
  const m = line.toString().match(/PORTURL=(\S+)/);
  if (m) {
    base = m[1];
    break;
  }
}
if (!base) {
  console.error("server child failed to start");
  process.exit(1);
}
const port = new URL(base).port;
const auth = `http://x:${TOKEN}@127.0.0.1:${port}`;

const work = mkdtempSync(join(tmpdir(), "gitforge-"));
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${String(err.message ?? err).slice(0, 300)}`);
  }
}
function git(args, opts = {}) {
  return execSync(`git ${args}`, { cwd: opts.cwd ?? work, encoding: "utf8", stdio: opts.stdio ?? ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false" } });
}
async function createRepo(name) {
  const res = await fetch(`${base}/api/v3/repos`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ name }) });
  assert.equal(res.status, 201);
}

await check("clone empty repo", async () => {
  await createRepo("empty1");
  git(`-c protocol.version=2 clone ${auth}/forge/empty1 empty1`);
  assert.ok(readFileSync(join(work, "empty1", ".git", "HEAD"), "utf8").includes("refs/heads/main"));
});

await check("push to main (v2 client)", async () => {
  git(`-C empty1 config user.email a@b.c`);
  git(`-C empty1 config user.name tester`);
  writeFileSync(join(work, "empty1", "a.txt"), "alpha\n");
  git(`-C empty1 add a.txt`);
  git(`-C empty1 commit -m "first commit"`);
  git(`-C empty1 push -u origin main`);
  const r = await fetch(`${base}/api/v3/repos/forge/empty1/commits`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const list = await r.json();
  assert.equal(list.length, 1);
  assert.ok(list[0].commit.message.includes("first commit"));
});

await check("clone with history", async () => {
  git(`clone ${auth}/forge/empty1 clone1`);
  assert.equal(readFileSync(join(work, "clone1", "a.txt"), "utf8"), "alpha\n");
  git(`-C clone1 log --oneline`, { stdio: "pipe" });
});

await check("protocol v0 clone", async () => {
  git(`-c protocol.version=0 clone ${auth}/forge/empty1 clone0`);
  assert.equal(readFileSync(join(work, "clone0", "a.txt"), "utf8"), "alpha\n");
});

await check("fetch new commit", async () => {
  writeFileSync(join(work, "empty1", "b.txt"), "beta\n");
  git(`-C empty1 add b.txt`);
  git(`-C empty1 commit -m "second commit"`);
  git(`-C empty1 push origin main`);
  git(`-C clone1 fetch origin`);
  git(`-C clone1 merge origin/main`);
  assert.equal(readFileSync(join(work, "clone1", "b.txt"), "utf8"), "beta\n");
});

await check("big 1MiB file push+clone", async () => {
  const big = Buffer.alloc(1024 * 1024, 65);
  writeFileSync(join(work, "empty1", "big.bin"), big);
  git(`-C empty1 add big.bin`);
  git(`-C empty1 commit -m "big file"`);
  git(`-C empty1 push origin main`);
  git(`-c protocol.version=2 clone ${auth}/forge/empty1 bigclone`);
  assert.ok(readFileSync(join(work, "bigclone", "big.bin")).length === 1024 * 1024);
});

await check("shallow clone depth 1", async () => {
  git(`-c protocol.version=2 clone --depth 1 ${auth}/forge/empty1 shallow1`);
  const count = execSync(`git -C shallow1 rev-list --count HEAD`, { cwd: work, encoding: "utf8" }).trim();
  assert.equal(count, "1");
});

await check("deepen", async () => {
  git(`-C shallow1 fetch --deepen=1 origin`);
  const count = execSync(`git -C shallow1 rev-list --count HEAD`, { cwd: work, encoding: "utf8" }).trim();
  assert.equal(count, "2");
});

await check("shallow clone v0 depth 1", async () => {
  git(`-c protocol.version=0 clone --depth 1 ${auth}/forge/empty1 shallow0`);
  const count = execSync(`git -C shallow0 rev-list --count HEAD`, { cwd: work, encoding: "utf8" }).trim();
  assert.equal(count, "1");
});

await check("tags roundtrip", async () => {
  git(`-C empty1 tag v1.0`);
  git(`-C empty1 push origin v1.0`);
  git(`-C clone1 fetch origin --tags`);
  const out = execSync(`git -C clone1 tag`, { cwd: work, encoding: "utf8" }).trim();
  assert.ok(out.includes("v1.0"));
});

await check("non-fast-forward refusal", async () => {
  git(`clone ${auth}/forge/empty1 diverge`);
  git(`-C diverge config user.email d@b.c`);
  git(`-C diverge config user.name diverge`);
  // rewind clone1 to an older commit, amend, force local change
  writeFileSync(join(work, "empty1", "c.txt"), "one\n");
  git(`-C empty1 add c.txt`);
  git(`-C empty1 commit -m "tip commit"`);
  git(`-C empty1 push origin main`);
  // make diverge's main a different commit not fast-forwardable
  writeFileSync(join(work, "diverge", "c.txt"), "different\n");
  git(`-C diverge add c.txt`);
  git(`-C diverge commit -m "divergent commit"`);
  // reset diverge's base to the older history so it is not a fast-forward
  const olderSha = execSync(`git -C empty1 rev-parse HEAD~1`, { cwd: work, encoding: "utf8" }).trim();
  git(`-C diverge reset --hard ${olderSha}`);
  writeFileSync(join(work, "diverge", "d.txt"), "divergent\n");
  git(`-C diverge add d.txt`);
  git(`-C diverge commit -m "divergent branch commit"`);
  let refused = false;
  try {
    git(`-C diverge push origin main`);
  } catch (err) {
    refused = true;
  }
  assert.ok(refused, "push should be refused");
});

await check("fast-forward push ok", async () => {
  writeFileSync(join(work, "empty1", "d.txt"), "ff\n");
  git(`-C empty1 add d.txt`);
  git(`-C empty1 commit -m "ff commit"`);
  git(`-C empty1 push origin main`);
});

await check("wrong token 401", async () => {
  let code = 0;
  try {
    execSync(`git clone http://x:wrong@127.0.0.1:${port}/forge/empty1 wt`, { cwd: work, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false" } });
  } catch (err) {
    code = err.status ?? 1;
  }
  assert.notEqual(code, 0);
  rmSync(join(work, "wt"), { recursive: true, force: true });
});

await check("branch push", async () => {
  git(`-C empty1 checkout -b topic`);
  writeFileSync(join(work, "empty1", "topic.txt"), "topic\n");
  git(`-C empty1 add topic.txt`);
  git(`-C empty1 commit -m "topic commit"`);
  git(`-C empty1 push -u origin topic`);
  const r = await fetch(`${base}/api/v3/repos/forge/empty1/branches`, { headers: { authorization: `Bearer ${TOKEN}` } }).catch((e) => { console.log("branchpush fetch error:", e.message, e.cause?.message ?? e.cause); throw e; });
  const branches = await r.json();
  assert.ok(branches.some((b) => b.name === "topic"));
});

await check("clone all branches", async () => {
  git(`clone ${auth}/forge/empty1 allb`);
  const out = execSync(`git -C allb branch -a`, { cwd: work, encoding: "utf8" });
  assert.ok(out.includes("topic"));
});

console.log(`\ngit-cli: ${passed} passed, ${failed} failed`);
child.kill("SIGTERM");
process.exit(failed === 0 ? 0 : 1);
