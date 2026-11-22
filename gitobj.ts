// gitobj.ts — the SHA-1 git object model: loose objects, tree/commit/tag
// codecs, packfile reading (plain, OFS-delta, REF-delta) and writing (plain),
// pkt-line and sideband framing. Standard library only.

import { createHash } from "node:crypto";
import { inflateSync, deflateSync } from "node:zlib";

export const ZERO_SHA = "0000000000000000000000000000000000000000";

export function sha1Hex(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

/** The bytes of a loose object: "<type> <size>\0" + body. */
export function looseObject(type: string, body: Buffer): Buffer {
  const header = Buffer.from(`${type} ${body.length}\0`);
  return Buffer.concat([header, body]);
}

export function hashObject(type: string, body: Buffer): { sha: string; raw: Buffer } {
  const raw = looseObject(type, body);
  return { sha: sha1Hex(raw), raw };
}

// ---------- trees ----------

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(body: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    const mode = body.subarray(i, sp).toString();
    const nul = body.indexOf(0, sp + 1);
    const name = body.subarray(sp + 1, nul).toString("utf8");
    const sha = body.subarray(nul + 1, nul + 21).toString("hex");
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

function treeSortKey(name: string, mode: string): string {
  // directories sort as if their name ends in "/"
  return mode === "40000" ? `${name}/` : name;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a.name, a.mode).localeCompare(treeSortKey(b.name, b.mode))
  );
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`));
    parts.push(Buffer.from(e.sha, "hex"));
  }
  return Buffer.concat(parts);
}

// ---------- commits ----------

export interface CommitObject {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(body: Buffer): CommitObject {
  const text = body.toString("utf8");
  const sep = text.indexOf("\n\n");
  const head = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? "" : text.slice(sep + 2);
  const c: CommitObject = { tree: "", parents: [], author: "", committer: "", message };
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) c.tree = line.slice(5);
    else if (line.startsWith("parent ")) c.parents.push(line.slice(7));
    else if (line.startsWith("author ")) c.author = line.slice(7);
    else if (line.startsWith("committer ")) c.committer = line.slice(10);
    // gpgsig / encoding / mergetag headers are ignored
  }
  return c;
}

export function serializeCommit(c: CommitObject): Buffer {
  const lines = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  return Buffer.from(lines.join("\n") + "\n\n" + c.message, "utf8");
}

export function parsePerson(s: string): { name: string; email: string; when: string } {
  const lt = s.lastIndexOf("<");
  const gt = s.lastIndexOf(">");
  return { name: s.slice(0, lt).trim(), email: s.slice(lt + 1, gt), when: s.slice(gt + 1).trim() };
}

// ---------- pkt-lines ----------

export function pktLine(payload: string | Buffer): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const len = data.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, "0")), data]);
}

export const FLUSH_PKT = Buffer.from("0000", "ascii");
export const DELIM_PKT = Buffer.from("0001", "ascii");

export class PktReader {
  buf: Buffer;
  pos = 0;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  atEnd(): boolean {
    return this.pos >= this.buf.length;
  }
  /** Next pkt payload; null for flush-pkt, "DELIM" for 0001. */
  next(): string | null | "DELIM" {
    if (this.atEnd()) return null;
    const len = parseInt(this.buf.subarray(this.pos, this.pos + 4).toString("ascii"), 16);
    this.pos += 4;
    if (len === 0) return null;
    if (len === 1) return "DELIM";
    if (len <= 3) throw new Error(`bad pkt length ${len}`);
    const payload = this.buf.subarray(this.pos, this.pos + len - 4);
    this.pos += len - 4;
    return payload.toString("utf8");
  }
}

// ---------- sideband ----------

export function sideband64k(band: number, data: Buffer): Buffer {
  const out: Buffer[] = [];
  const chunkMax = 65515;
  for (let i = 0; i < data.length; i += chunkMax) {
    const chunk = data.subarray(i, Math.min(i + chunkMax, data.length));
    const frame = Buffer.alloc(5 + chunk.length);
    frame.write((chunk.length + 5).toString(16).padStart(4, "0"), 0, "ascii");
    frame[4] = band;
    chunk.copy(frame, 5);
    out.push(frame);
  }
  return Buffer.concat(out);
}

// ---------- packfiles ----------

export const OBJ_COMMIT = 1;
export const OBJ_TREE = 2;
export const OBJ_BLOB = 3;
export const OBJ_TAG = 4;
export const OBJ_OFS_DELTA = 6;
export const OBJ_REF_DELTA = 7;

const TYPE_NAMES: Record<number, string> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const TYPE_NUMS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface PackEntry {
  type: string;
  data: Buffer;
}

function readVarint(buf: Buffer, p: { i: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    const b = buf[p.i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return value;
}

/** Advance past one zlib stream starting at pos; returns consumed length. */
function zlibStreamLength(data: Buffer, start: number, expectedSize: number): number {
  // Binary search for the smallest end whose inflate output matches the size
  // recorded in the object header. inflateSync throws on truncated input, so a
  // failed probe means the stream continues past that point.
  let lo = start + 1;
  let hi = Math.min(data.length, start + expectedSize * 2 + 4096);
  let end = hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(data.subarray(start, mid));
      if (out.length >= expectedSize) {
        end = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  return end - start;
}

/**
 * Parse a packfile (version 2), applying OFS/REF deltas and verifying the
 * SHA-1 trailer. Returns every object in the pack.
 */
export function readPack(pack: Buffer, external?: (sha: string) => PackEntry | null): PackEntry[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString() !== "PACK") throw new Error("not a packfile");
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = sha1Hex(pack.subarray(0, pack.length - 20));
  if (trailer !== pack.subarray(pack.length - 20).toString("hex")) throw new Error("pack trailer sha mismatch");

  // Scan the entries, inflating each into memory and remembering offsets.
  const offsets: number[] = [];
  const kinds: number[] = [];
  const plain: (PackEntry | null)[] = new Array(count).fill(null);
  const deltas: { baseOffset?: number; baseSha?: string; delta: Buffer }[] = new Array(count);
  let pos = 12;
  for (let n = 0; n < count; n++) {
    offsets.push(pos);
    let byte = pack[pos++];
    const type = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    kinds.push(type);
    if (type === OBJ_OFS_DELTA) {
      let b = pack[pos++];
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos++];
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      const consumed = zlibStreamLength(pack, pos, size);
      const delta = inflateSync(pack.subarray(pos, pos + consumed));
      pos += consumed;
      deltas[n] = { baseOffset, delta };
    } else if (type === OBJ_REF_DELTA) {
      const baseSha = pack.subarray(pos, pos + 20).toString("hex");
      pos += 20;
      const consumed = zlibStreamLength(pack, pos, size);
      const delta = inflateSync(pack.subarray(pos, pos + consumed));
      pos += consumed;
      deltas[n] = { baseSha, delta };
    } else {
      const consumed = zlibStreamLength(pack, pos, size);
      const out = inflateSync(pack.subarray(pos, pos + consumed));
      if (out.length !== size) throw new Error("inflated size mismatch");
      pos += consumed;
      plain[n] = { type: TYPE_NAMES[type], data: out };
    }
  }

  const store = new Map<number, PackEntry>(); // offset -> entry
  const bySha = new Map<string, PackEntry>();
  for (let i = 0; i < count; i++) {
    const e = plain[i];
    if (e) {
      store.set(offsets[i], e);
      const { sha } = hashObject(e.type, e.data);
      bySha.set(sha, e);
    }
  }

  const applyDelta = (base: Buffer, delta: Buffer): Buffer => {
    const p = { i: 0 };
    readVarint(delta, p); // base size
    const resultSize = readVarint(delta, p);
    const out: Buffer[] = [];
    while (p.i < delta.length) {
      const op = delta[p.i++];
      if (op & 0x80) {
        let off = 0;
        let size = 0;
        if (op & 0x01) off |= delta[p.i++];
        if (op & 0x02) off |= delta[p.i++] << 8;
        if (op & 0x04) off |= delta[p.i++] << 16;
        if (op & 0x08) off |= delta[p.i++] << 24;
        if (op & 0x10) size |= delta[p.i++];
        if (op & 0x20) size |= delta[p.i++] << 8;
        if (op & 0x40) size |= delta[p.i++] << 16;
        if (size === 0) size = 0x10000;
        out.push(base.subarray(off, off + size));
      } else {
        out.push(delta.subarray(p.i, p.i + op));
        p.i += op;
      }
    }
    const result = Buffer.concat(out);
    if (result.length !== resultSize) throw new Error("delta result size mismatch");
    return result;
  };

  // Iteratively resolve deltas until none is left.
  const resolved = plain.map(() => false);
  for (;;) {
    let progress = false;
    for (let i = 0; i < count; i++) {
      if (plain[i]) continue;
      const d = deltas[i];
      const base =
        d.baseOffset !== undefined ? store.get(offsets[i] - d.baseOffset) : d.baseSha !== undefined ? (bySha.get(d.baseSha) ?? external?.(d.baseSha) ?? undefined) : undefined;
      if (!base) continue;
      const entry: PackEntry = { type: base.type, data: applyDelta(base.data, d.delta) };
      plain[i] = entry;
      resolved[i] = true;
      store.set(offsets[i], entry);
      const { sha } = hashObject(entry.type, entry.data);
      bySha.set(sha, entry);
      progress = true;
    }
    if (!progress) break;
  }
  for (let i = 0; i < count; i++) if (!plain[i]) throw new Error(`unresolvable delta at entry ${i}`);
  return plain as PackEntry[];
}

/** Write a packfile (version 2, plain objects, no deltas). */
export function writePack(entries: PackEntry[]): Buffer {
  const body: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  body.push(header);
  for (const e of entries) {
    const t = TYPE_NUMS[e.type];
    if (t === undefined) throw new Error(`unknown pack type ${e.type}`);
    let size = e.data.length;
    let b = (t << 4) | (size & 15);
    size >>= 4;
    const hdr: number[] = [];
    while (size > 0) {
      hdr.push(b | 0x80);
      b = size & 0x7f;
      size >>= 7;
    }
    hdr.push(b);
    body.push(Buffer.from(hdr));
    body.push(deflateSync(e.data));
  }
  const payload = Buffer.concat(body);
  const trailer = Buffer.from(sha1Hex(payload), "hex");
  return Buffer.concat([payload, trailer]);
}

export { inflateSync, deflateSync };
