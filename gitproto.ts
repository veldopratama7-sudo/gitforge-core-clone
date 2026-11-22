// gitproto.ts — git smart HTTP: upload-pack (protocol v2 and v0) and
// receive-pack (v0), with shallow support, thin-pack toleration, per-ref
// report-status and non-fast-forward refusals.

import {
  FLUSH_PKT,
  DELIM_PKT,
  PktReader,
  ZERO_SHA,
  parseCommit,
  parseTree,
  pktLine,
  readPack,
  sha1Hex,
  sideband64k,
  writePack,
  type CommitObject,
  type PackEntry,
} from "./gitobj.ts";
import { ForgeStore, HttpError, type Repo } from "./store.ts";

const AGENT = "agent=gitforge/1.0";

export function isGitPath(pathname: string): boolean {
  return /\/(?:\.git\/)?(?:info\/refs|git-upload-pack|git-receive-pack)$/.test(pathname);
}

interface GitRequest {
  method: string;
  path: string; // decoded pathname
  query: URLSearchParams;
  protocolHeader: string | null;
  body: Buffer;
}

interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

export function handleGit(store: ForgeStore, req: GitRequest): GitReply {
  // POST endpoints
  const postM = req.path.match(/^(.*)\/(?:\.git\/)?(git-upload-pack|git-receive-pack)$/);
  if (postM && req.method === "POST") {
    const repo = repoFromPath(store, `${postM[1]}/${postM[2]}`, postM[2]);
    if (postM[2] === "git-upload-pack") {
      const body = handleUploadPack(store, repo, req);
      return { status: 200, contentType: "application/x-git-upload-pack-result", body };
    }
    const body = handleReceivePack(store, repo, req);
    return { status: 200, contentType: "application/x-git-receive-pack-result", body };
  }
  // GET info/refs
  const m = req.path.match(/^(.*)\/(?:\.git\/)?info\/refs$/);
  if (m && req.method === "GET") {
    const service = req.query.get("service") ?? "";
    if (service === "git-upload-pack") {
      const repo = repoFromPath(store, req.path, "git-upload-pack");
      const v2 = (req.protocolHeader ?? "").includes("version=2");
      return {
        status: 200,
        contentType: "application/x-git-upload-pack-advertisement",
        body: v2 ? uploadPackAdvertiseV2(store, repo) : uploadPackAdvertiseV0(store, repo),
      };
    }
    if (service === "git-receive-pack") {
      const repo = repoFromPath(store, req.path, "git-receive-pack");
      return {
        status: 200,
        contentType: "application/x-git-receive-pack-advertisement",
        body: receivePackAdvertise(store, repo),
      };
    }
    // dumb protocol probes: HEAD and looser objects are not supported
    throw new HttpError(400, "smart HTTP only");
  }
  // GET /{o}/{r}.git/HEAD — dumb-protocol probe some clients make first
  const head = req.path.match(/^(.*)\/\.git\/HEAD$/);
  if (head && req.method === "GET") {
    const repo = repoFromPath(store, `${head[1]}.git/git-upload-pack`, "git-upload-pack");
    const sym = store.headTarget(repo);
    const refName = sym ?? "refs/heads/main";
    const sha = store.resolveRef(repo, "HEAD") ?? ZERO_SHA;
    return { status: 200, contentType: "text/plain", body: Buffer.from(`ref: ${refName}\n${sha}\n`) };
  }
  throw new HttpError(404, "Not Found");
}

function repoFromPath(store: ForgeStore, path: string, service: string): Repo {
  const m = path.match(/^(.*)\/(?:\.git\/)?(?:git-upload-pack|git-receive-pack|info\/refs)$/);
  if (!m) throw new HttpError(404, "Not Found");
  const repoPath = m[1].replace(/\.git$/, "").replace(/\/+$/, ""); // "owner/repo"
  const parts = repoPath.replace(/^\/+/, "").split("/");
  if (parts.length < 2) throw new HttpError(404, "Not Found");
  const name = parts[parts.length - 1].replace(/\.git$/, "");
  const owner = parts[parts.length - 2];
  store.learnOwner(owner);
  const repo = store.getRepo(owner, name);
  if (!repo) throw new HttpError(404, `repository ${owner}/${name} not found`);
  void service;
  return repo;
}

// ---------------- upload-pack advertisement ----------------

function uploadPackAdvertiseV2(store: ForgeStore, repo: Repo): Buffer {
  const lines: string[] = ["version 2\n", `${AGENT}\n`, "ls-refs=unborn\n", "fetch=shallow\n", "object-format=sha1\n"];
  const out: Buffer[] = [];
  for (const l of lines) out.push(pktLine(l));
  out.push(FLUSH_PKT);
  void repo;
  return Buffer.concat(out);
}

const V0_UPLOAD_CAPS =
  "multi_ack_detailed multi_ack side-band-64k side-band thin-pack ofs-delta shallow deepen deepen-since deepen-not no-progress include-tag no-done symref=HEAD:refs/heads/main " +
  AGENT;

function uploadPackAdvertiseV0(store: ForgeStore, repo: Repo): Buffer {
  const out: Buffer[] = [];
  out.push(pktLine("# service=git-upload-pack\n"));
  out.push(FLUSH_PKT);
  const headSym = store.headTarget(repo) ?? "refs/heads/main";
  const headSha = store.resolveRef(repo, "HEAD") ?? ZERO_SHA;
  const refs: [string, string][] = [];
  if (headSha !== ZERO_SHA) refs.push(["HEAD", headSha]);
  const sorted = [...repo.refs.entries()].filter(([k, v]) => k.startsWith("refs/") && v !== ZERO_SHA);
  for (const [name, sha] of sorted) if (name !== "HEAD") refs.push([name, sha]);
  let first = true;
  for (const [name, sha] of refs) {
    const cap = first ? `\0${V0_UPLOAD_CAPS}` : "";
    first = false;
    const line = name === "HEAD" ? `${sha} HEAD${cap}\n` : `${sha} ${name}${cap}\n`;
    out.push(pktLine(line));
  }
  out.push(FLUSH_PKT);
  return Buffer.concat(out);
}

// ---------------- receive-pack advertisement ----------------

const V0_RECEIVE_CAPS = "report-status delete-refs side-band-64k quiet ofs-delta " + AGENT;

function receivePackAdvertise(store: ForgeStore, repo: Repo): Buffer {
  const out: Buffer[] = [];
  out.push(pktLine("# service=git-receive-pack\n"));
  out.push(FLUSH_PKT);
  const entries = [...repo.refs.entries()].filter(([k, v]) => k.startsWith("refs/") && v !== ZERO_SHA);
  let first = true;
  if (entries.length === 0) {
    out.push(pktLine(`${ZERO_SHA} capabilities^{}\0${V0_RECEIVE_CAPS}\n`));
  } else {
    for (const [name, sha] of entries) {
      const cap = first ? `\0${V0_RECEIVE_CAPS}` : "";
      first = false;
      out.push(pktLine(`${sha} ${name}${cap}\n`));
    }
  }
  out.push(FLUSH_PKT);
  return Buffer.concat(out);
}

// ---------------- upload-pack commands ----------------

function handleUploadPack(store: ForgeStore, repo: Repo, req: GitRequest): Buffer {
  const v2 = (req.protocolHeader ?? "").includes("version=2");
  if (v2) return handleFetchV2(store, repo, req.body);
  return handleFetchV0(store, repo, req.body);
}

/** protocol v0 fetch: wants/shallow/deepen, then negotiation haves, then done. */
function handleFetchV0(store: ForgeStore, repo: Repo, body: Buffer): Buffer {
  const parsed = parseV0Fetch(new PktReader(body));
  const args: FetchArgs = {
    wants: parsed.wants,
    haves: parsed.haves,
    caps: parsed.caps,
    shallow: parsed.shallow,
    deepen: parsed.deepen,
    deepenRelative: parsed.deepenRelative,
    deepenNot: [],
    done: parsed.done,
    wantRefs: [],
  };
  return handleFetchBody(store, repo, args, false);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  caps: Set<string>;
  shallow: string[];
  deepen: number | null;
  deepenRelative: boolean;
  deepenNot: string[];
  done: boolean;
  wantRefs: string[];
}

function parseV2Fetch(pkts: string[]): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    haves: [],
    caps: new Set(),
    shallow: [],
    deepen: null,
    deepenRelative: false,
    deepenNot: [],
    done: false,
    wantRefs: [],
  };
  for (const p of pkts) {
    const t = p.trim();
    if (t.startsWith("want ")) args.wants.push(t.slice(5).trim());
    else if (t.startsWith("have ")) args.haves.push(t.slice(5).trim());
    else if (t.startsWith("shallow ")) args.shallow.push(t.slice(8).trim());
    else if (t.startsWith("deepen ")) args.deepen = parseInt(t.slice(7).trim(), 10);
    else if (t === "deepen-relative") args.deepenRelative = true;
    else if (t.startsWith("deepen-not ")) args.deepenNot.push(t.slice(11).trim());
    else if (t === "done") args.done = true;
    else if (t.startsWith("want-ref ")) args.wantRefs.push(t.slice(9).trim());
    else if (t === "thin-pack" || t === "no-progress" || t === "include-tag" || t === "ofs-delta" || t === "sideband-all" || t === "wait-for-done") args.caps.add(t);
    else if (t.startsWith("filter") || t.startsWith("packfile-uris") || t.startsWith("deepen-since")) args.caps.add(t.split(" ")[0]);
  }
  return args;
}

function parseV0Fetch(reader: PktReader): { wants: string[]; caps: Set<string>; shallow: string[]; deepen: number | null; deepenRelative: boolean; haves: string[]; done: boolean } {
  const wants: string[] = [];
  const caps = new Set<string>();
  const shallow: string[] = [];
  let deepen: number | null = null;
  let deepenRelative = false;
  let first = true;
  let state: "wants" | "haves" = "wants";
  const haves: string[] = [];
  let done = false;
  for (;;) {
    if (reader.atEnd()) break;
    const line = reader.next();
    if (line === null) continue; // flush between sections; "done" may follow
    if (line === "DELIM") continue;
    const t = (line as string).trim();
    if (t === "done") {
      done = true;
      continue;
    }
    if (t.startsWith("want ")) {
      const rest = t.slice(5);
      const sp = rest.indexOf(" ");
      const sha = sp === -1 ? rest : rest.slice(0, sp);
      if (sp !== -1 && first) {
        for (const c of rest.slice(sp + 1).split(" ")) if (c) caps.add(c);
      }
      first = false;
      wants.push(sha);
      state = "wants";
    } else if (t.startsWith("shallow ")) {
      shallow.push(t.slice(8).trim());
    } else if (t.startsWith("deepen ")) {
      deepen = parseInt(t.slice(7).trim(), 10);
    } else if (t === "deepen-relative") {
      deepenRelative = true;
    } else if (t.startsWith("have ")) {
      state = "haves";
      haves.push(t.slice(5).trim());
    } else if (t === "" ) {
      // ignore
    }
  }
  return { wants, caps, shallow, deepen, deepenRelative, haves, done };
}

/** Resolve wants (shas or want-refs) against the repo; throws 400 on unknown. */
function resolveWants(store: ForgeStore, repo: Repo, args: FetchArgs): { wantShas: string[]; wantedRefs: [string, string][] } {
  const wantShas: string[] = [];
  for (const w of args.wants) {
    if (w === ZERO_SHA) continue; // unborn ref: nothing to send
    if (!store.hasObject(repo, w)) throw new HttpError(400, `want ${w} not available`);
    wantShas.push(w);
  }
  const wantedRefs: [string, string][] = [];
  for (const refName of args.wantRefs) {
    const sha = store.resolveRef(repo, refName);
    if (!sha) throw new HttpError(400, `unknown ref ${refName}`);
    wantedRefs.push([refName, sha]);
    wantShas.push(sha);
  }
  return { wantShas, wantedRefs };
}

/** Compute the shallow boundary for the requested depth; returns commits to send. */
function computeShallowHistory(
  store: ForgeStore,
  repo: Repo,
  wantShas: string[],
  deepen: number | null,
  deepenRelative: boolean,
  clientShallow: string[]
): { send: Set<string>; newShallow: string[]; unshallow: string[] } {
  const noLimit = deepen === null;
  if (noLimit && clientShallow.length === 0) {
    const reach = store.reachable(repo, wantShas);
    return { send: new Set(reach.keys()), newShallow: [], unshallow: [] };
  }
  // depth map from wants
  const depth = new Map<string, number>();
  const queue: [string, number][] = wantShas.map((s) => [s, 1]);
  let maxDepth = 0;
  let limit = deepen ?? Infinity;
  if (deepenRelative) {
    // extend depth beyond the client's shallow tips by deepen
    let baseDepth = 0;
    for (const tip of clientShallow) {
      // the client's shallow tip's depth within our graph (1-based)
      baseDepth = Math.max(baseDepth, depthOf(store, repo, tip, wantShas));
    }
    limit = baseDepth + (deepen ?? 0);
  }
  while (queue.length > 0) {
    const [sha, d] = queue.shift()!;
    if (depth.has(sha)) continue;
    if (d > limit) continue;
    depth.set(sha, d);
    maxDepth = Math.max(maxDepth, d);
    const obj = store.getObject(repo, sha);
    if (!obj || obj.type !== "commit") continue;
    for (const p of parseCommit(obj.data).parents) if (!depth.has(p)) queue.push([p, d + 1]);
  }
  const send = new Set(depth.keys());
  // new shallow tips: commits in `send` that have parents NOT in send (only when a limit exists)
  const newShallow: string[] = [];
  const unshallow: string[] = [];
  if (limit !== Infinity) {
    for (const sha of send) {
      const obj = store.getObject(repo, sha);
      if (!obj || obj.type !== "commit") continue;
      const parents = parseCommit(obj.data).parents;
      const missing = parents.filter((p) => !send.has(p));
      if (missing.length > 0) newShallow.push(sha);
      if (clientShallow.includes(sha) && missing.length === 0) unshallow.push(sha);
    }
  } else {
    // unlimited: any previously shallow tip that is now complete gets unshallowed
    for (const tip of clientShallow) {
      const obj = store.getObject(repo, tip);
      if (!obj || obj.type !== "commit") continue;
      const parents = parseCommit(obj.data).parents;
      let complete = true;
      for (const p of parents) {
        if (!store.reachable(repo, [tip]).has(p)) {
          complete = false;
          break;
        }
      }
      if (complete) unshallow.push(tip);
    }
  }
  void maxDepth;
  return { send, newShallow, unshallow };
}

function depthOf(store: ForgeStore, repo: Repo, target: string, wants: string[]): number {
  // shortest depth of target below any want (1 = is a want)
  const depth = new Map<string, number>();
  const queue: [string, number][] = wants.map((s) => [s, 1]);
  while (queue.length > 0) {
    const [sha, d] = queue.shift()!;
    if (depth.has(sha)) continue;
    depth.set(sha, d);
    if (sha === target) return d;
    const obj = store.getObject(repo, sha);
    if (!obj || obj.type !== "commit") continue;
    for (const p of parseCommit(obj.data).parents) queue.push([p, d + 1]);
  }
  return 1;
}

/** Build a pack from a set of shas (objects reachable, parents of shallow tips cut). */
function packFrom(store: ForgeStore, repo: Repo, send: Set<string>, shallowTips: Set<string>): Buffer {
  const entries: PackEntry[] = [];
  const seen = new Set<string>();
  const stack = [...send];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha) || sha === ZERO_SHA) continue;
    seen.add(sha);
    const obj = store.getObject(repo, sha);
    if (!obj) continue;
    entries.push({ type: obj.type, data: obj.data });
    if (obj.type === "commit") {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (shallowTips.has(sha)) continue; // cut the parents here, keep the tree
      stack.push(...c.parents);
    } else if (obj.type === "tree") {
      for (const e of parseTree(obj.data)) stack.push(e.sha);
    } else if (obj.type === "tag") {
      const m = obj.data.toString("utf8").match(/^object ([0-9a-f]{40})/m);
      if (m) stack.push(m[1]);
    }
  }
  return writePack(entries);
}

function packOfAll(store: ForgeStore, repo: Repo, shas: string[]): Buffer {
  const entries: PackEntry[] = [];
  for (const sha of shas) {
    const obj = store.getObject(repo, sha);
    if (obj) entries.push({ type: obj.type, data: obj.data });
  }
  return writePack(entries);
}

function handleFetchV2(store: ForgeStore, repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  let command = "";
  const lines: string[] = [];
  let inArgs = false;
  for (;;) {
    const p = reader.next();
    if (p === null) break;
    if (p === "DELIM") {
      inArgs = true;
      continue;
    }
    const t = (p as string).trim();
    if (!inArgs) {
      if (t.startsWith("command=")) command = t.slice(8);
    } else {
      lines.push(t);
    }
  }

  if (command === "ls-refs") return handleLsRefs(store, repo, lines);
  if (command === "fetch") {
    const args = parseV2Fetch(lines);
    return handleFetchBody(store, repo, args, true);
  }
  const out: Buffer[] = [];
  out.push(pktLine(`error: unknown command ${command}\n`));
  return Buffer.concat(out);
}

function handleLsRefs(store: ForgeStore, repo: Repo, args: string[]): Buffer {
  const wantSym = args.includes("symrefs");
  const wantPeel = args.includes("peel");
  const unborn = args.includes("unborn");
  const prefixes = args.filter((a) => a.startsWith("ref-prefix ")).map((a) => a.slice(11));
  const out: Buffer[] = [];

  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

  // HEAD
  const sym = store.headTarget(repo) ?? "refs/heads/main";
  const headSha = store.resolveRef(repo, "HEAD");
  if (matches("HEAD")) {
    if (headSha) {
      let head = `${headSha} HEAD`;
      if (wantSym) head += ` symref-target:${sym}`;
      out.push(pktLine(head + "\n"));
    } else if (unborn && wantSym) {
      out.push(pktLine(`unborn HEAD symref-target:${sym}\n`));
    }
  }
  const refs = [...repo.refs.entries()].filter(([k, v]) => k.startsWith("refs/") && v !== ZERO_SHA).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, sha] of refs) {
    if (!matches(name)) continue;
    let line = `${sha} ${name}`;
    if (wantPeel && name.startsWith("refs/tags/") && name.endsWith("^{}") === false) {
      const obj = store.getObject(repo, sha);
      if (obj && obj.type === "tag") {
        const target = obj.data.toString("utf8").match(/^object ([0-9a-f]{40})/m);
        // peel iteratively to the non-tag object
        let cur = target ? target[1] : sha;
        for (;;) {
          const o = store.getObject(repo, cur);
          if (!o || o.type !== "tag") break;
          const m2 = o.data.toString("utf8").match(/^object ([0-9a-f]{40})/m);
          if (!m2) break;
          cur = m2[1];
        }
        line += ` peeled:${cur}`;
      }
    }
    out.push(pktLine(line + "\n"));
  }
  out.push(FLUSH_PKT);
  return Buffer.concat(out);
}

function handleFetchBody(store: ForgeStore, repo: Repo, args: FetchArgs, isV2: boolean): Buffer {
  const { wantShas, wantedRefs } = resolveWants(store, repo, args);

  const common = args.haves.filter((h) => store.hasObject(repo, h));
  const { send, newShallow, unshallow } = computeShallowHistory(
    store,
    repo,
    wantShas,
    args.deepen,
    args.deepenRelative,
    args.shallow
  );
  const shallowTips = new Set(newShallow);
  const pack = packFrom(store, repo, send, shallowTips);

  const out: Buffer[] = [];
  if (isV2) {
    const acks: Buffer[] = [];
    let ready = false;
    if (args.haves.length > 0) {
      if (common.length === 0) {
        acks.push(pktLine("NAK\n"));
      } else {
        for (const c of common) acks.push(pktLine(`ACK ${c}\n`));
        ready = true;
        acks.push(pktLine("ready\n"));
      }
    }
    if (!args.done && !ready) {
      // negotiation round: acknowledgments only, response ends with flush-pkt
      out.push(pktLine("acknowledgments\n"), ...acks, FLUSH_PKT);
      return Buffer.concat(out);
    }
    // done (or ready): shallow-info / wanted-refs / packfile
    if (ready || args.haves.length > 0) {
      out.push(pktLine("acknowledgments\n"), ...acks, DELIM_PKT);
    }
    if (newShallow.length > 0 || unshallow.length > 0) {
      out.push(pktLine("shallow-info\n"));
      for (const s of newShallow) out.push(pktLine(`shallow ${s}`));
      for (const s of unshallow) out.push(pktLine(`unshallow ${s}`));
      out.push(DELIM_PKT);
    }
    if (wantedRefs.length > 0) {
      out.push(pktLine("wanted-refs\n"));
      for (const [name, sha] of wantedRefs) out.push(pktLine(`${sha} ${name}\n`));
      out.push(DELIM_PKT);
    }
    out.push(pktLine("packfile\n"));
    out.push(sideband64k(1, pack));
    out.push(FLUSH_PKT);
    return Buffer.concat(out);
  }

  // v0
  const out0: Buffer[] = [];
  for (const s of newShallow) out0.push(pktLine(`shallow ${s}`));
  for (const s of unshallow) out0.push(pktLine(`unshallow ${s}`));
  if (!args.done) {
    // deepen round (and negotiation rounds): shallow lines only, then flush; no pack
    out0.push(FLUSH_PKT);
    return Buffer.concat(out0);
  }
  if (newShallow.length > 0 || unshallow.length > 0) out0.push(FLUSH_PKT);
  if (args.haves.length > 0 && common.length > 0) {
    out0.push(pktLine(`ACK ${common[common.length - 1]}\n`));
  } else {
    out0.push(pktLine("NAK\n"));
  }
  const noProgress = args.caps.has("no-progress");
  const useSideband = args.caps.has("side-band-64k") || args.caps.has("side-band");
  const band = args.caps.has("side-band-64k") ? sideband64k : sideband;
  let payload = pack;
  if (useSideband) {
    const frames: Buffer[] = [];
    if (!noProgress) {
      const progress = Buffer.from("Counting objects: done\n");
      frames.push(band(2, progress));
    }
    frames.push(band(1, payload));
    payload = Buffer.concat(frames);
  }
  out0.push(payload);
  out0.push(FLUSH_PKT);
  return Buffer.concat(out0);
}

/** side-band with 1000-byte frames (v0 "side-band"). */
function sideband(band: number, data: Buffer): Buffer {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += 998) {
    const chunk = data.subarray(i, Math.min(i + 998, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(out);
}

// ---------------- receive-pack ----------------

interface ReceiveCommand {
  old: string;
  new: string;
  ref: string;
}

function handleReceivePack(store: ForgeStore, repo: Repo, req: GitRequest): Buffer {
  const reader = new PktReader(req.body);
  const commands: ReceiveCommand[] = [];
  const caps = new Set<string>();
  let packData: Buffer;
  {
    // pkt-lines until flush, then the pack
    const lines: string[] = [];
    for (;;) {
      const p = reader.next();
      if (p === null) break;
      if (p === "DELIM") continue;
      let t = p as string;
      if (commands.length === 0 && firstCommand(t)) {
        const nul = t.indexOf("\0");
        if (nul !== -1) {
          for (const c of t.slice(nul + 1).split(" ")) if (c) caps.add(c);
          t = t.slice(0, nul);
        }
      }
      const m = t.trim().match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
      if (m) commands.push({ old: m[1], new: m[2], ref: m[3] });
      else lines.push(t.trim());
    }
    packData = req.body.subarray(reader.pos);
    void lines;
  }

  const report: string[] = ["unpack ok\n"];
  try {
    if (packData.length > 0) {
      const entries = readPack(packData, (sha) => {
        const obj = store.getObject(repo, sha);
        return obj ? { type: obj.type, data: obj.data } : null;
      });
      for (const e of entries) store.putObject(repo, e.type, e.data);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unpack error";
    const out: Buffer[] = [];
    const reportLines = [`unpack ${reason}\n`];
    for (const c of commands) reportLines.push(`ng ${c.ref} n/a (unpacker error)\n`);
    return Buffer.concat(out.concat(sidebandOrPlain(caps, reportLines)));
  }

  for (const c of commands) {
    try {
      applyCommand(store, repo, c);
      report.push(`ok ${c.ref}\n`);
    } catch (err) {
      const reason = err instanceof HttpError ? err.message : err instanceof Error ? err.message : "failed";
      report.push(`ng ${c.ref} ${reason}\n`);
    }
  }
  return Buffer.concat(sidebandOrPlain(caps, report));
}

const FLUSH_PKT_SYMBOL = "0000";

function firstCommand(t: string): boolean {
  void t;
  return true;
}

function sidebandOrPlain(caps: Set<string>, lines: string[]): Buffer[] {
  const plain = Buffer.concat([...lines.map((l) => pktLine(l)), FLUSH_PKT]);
  if (caps.has("side-band-64k")) {
    const muxed = sideband64k(1, plain);
    return [muxed, FLUSH_PKT];
  }
  return [plain];
}

function applyCommand(store: ForgeStore, repo: Repo, c: ReceiveCommand): void {
  if (c.new === ZERO_SHA) {
    // delete
    if (c.old !== ZERO_SHA) {
      const cur = repo.refs.get(c.ref);
      if (cur !== c.old) throw new HttpError(400, "fetch first");
      if (!store.isAncestor(repo, c.old, c.old)) throw new HttpError(400, "deny");
    }
    repo.refs.delete(c.ref);
    return;
  }
  if (!store.hasObject(repo, c.new)) throw new HttpError(400, "missing necessary objects");
  if (c.old === ZERO_SHA) {
    // create
    if (repo.refs.has(c.ref) && (repo.refs.get(c.ref) ?? ZERO_SHA) !== ZERO_SHA) {
      throw new HttpError(400, "already exists");
    }
    repo.refs.set(c.ref, c.new);
    return;
  }
  const cur = repo.refs.get(c.ref);
  if (cur !== c.old) throw new HttpError(400, "fetch first");
  if (!store.isAncestor(repo, c.old, c.new)) {
    throw new HttpError(400, "non-fast-forward");
  }
  repo.refs.set(c.ref, c.new);
}

export { parseV0Fetch, parseV2Fetch, packOfAll, sha1Hex };
