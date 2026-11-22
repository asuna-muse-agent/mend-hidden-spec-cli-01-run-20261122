// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order: [old, new]. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** File model (SPEC.md section 3) and the three-tier matcher (section 5). */
function splitFile(text: string): { lines: string[]; br: string; endsWithBr: boolean } {
  if (text === '') return { lines: [], br: '\n', endsWithBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const endsWithBr = text.endsWith(br);
  if (endsWithBr) lines.pop();
  return { lines, br, endsWithBr };
}
function joinFile(lines: string[], br: string, endsWithBr: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (endsWithBr ? br : '');
}
function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.trimEnd() === b.trimEnd();
  return a.trim() === b.trim();
}
/** Positions where O matches lines starting at or after `from`, at the given tier. Overlapping counts. */
function occurrences(O: string[], lines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (!tierEq(O[k]!, lines[i + k]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** First tier (0, then 1, then 2; only 0 when strict) with an occurrence at or after `from`. */
function findTier(O: string[], lines: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
/** One line of N: a context line names its index in O (written as the file's own line), else a new line. */
interface NLine { text: string; ctx: number | null; }
/** Build the replacement lines for an occurrence at `pos` (SPEC.md section 5). */
function buildReplacement(fileLines: string[], pos: number, oLines: string[], nLines: NLine[], tier: number): string[] {
  const out: string[] = [];
  const f = oLines.length > 0 ? leadingWS(fileLines[pos]!) : '';
  const p = oLines.length > 0 ? leadingWS(oLines[0]!) : '';
  for (const n of nLines) {
    if (n.ctx !== null) { out.push(fileLines[pos + n.ctx]!); continue; }
    let t = n.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}
/** Does the `\` line follow the hunk/chunk's last context or `+` body line? `body` holds the raw body lines. */
function backslashAfterLastAdded(body: string[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]![0];
    if (c === ' ' || c === '+' || body[i] === '') last = i;
  }
  if (last < 0) return false;
  return last + 1 < body.length && body[last + 1]!.startsWith('\\');
}
/** Split a hunk/chunk body into O lines, N lines and whether it ends with a backslash marker. */
function splitBody(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const raw of body) {
    if (raw.startsWith('\\')) continue;
    const c = raw[0];
    if (c === ' ') { const t = raw.slice(1); o.push(t); n.push({ text: t, ctx: o.length - 1 }); }
    else if (c === '-') o.push(raw.slice(1));
    else if (c === '+') n.push({ text: raw.slice(1), ctx: null });
    else if (raw === '') { o.push(''); n.push({ text: '', ctx: o.length - 1 }); }
  }
  return { o, n };
}

/** Unified diffs (SPEC.md section 6). */
interface Hunk { a: number; body: string[]; }
interface Section {
  pairOld: string | null; pairNew: string | null;
  renOld: string | null; renNew: string | null;
  gitOld: string | null; gitNew: string | null;
  isCreate: boolean; isDelete: boolean; hunks: Hunk[];
}
function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}
function headerPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const t = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  return t === '/dev/null' ? null : stripAB(t);
}
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let lines = f.lines;
  let endsWithBr = f.endsWithBr;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.body);
    const bs = backslashAfterLastAdded(h.body);
    if (o.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const ins = n.map((x) => x.text);
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (at === lines.length) endsWithBr = !bs;
      d += n.length;
      continue;
    }
    const found = findTier(o, lines, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    const toEOF = best + o.length === lines.length;
    const rep = buildReplacement(lines, best, o, n, found.tier);
    lines = [...lines.slice(0, best), ...rep, ...lines.slice(best + o.length)];
    if (toEOF) endsWithBr = !bs;
    d += n.length - o.length;
  }
  return joinFile(lines, f.br, endsWithBr);
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let pairSeen = false;
  let i = 0;
  const n = lines.length;
  const newSection = (oldP: string | null, newP: string | null): Section => {
    const s: Section = { pairOld: oldP, pairNew: newP, renOld: null, renNew: null, gitOld: null, gitNew: null, isCreate: false, isDelete: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(null, null);
      cur.gitOld = stripAB(m[1]!);
      cur.gitNew = stripAB(m[2]!);
      pairSeen = false;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      if (cur !== null && !pairSeen && cur.hunks.length === 0) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        pairSeen = true;
      } else {
        cur = newSection(headerPath(line), headerPath(lines[i + 1]!));
        pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        if (!pairSeen) { cur.pairNew = headerPath(line); pairSeen = true; }
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) { if (cur.renOld === null) cur.renOld = line.slice(12).trim(); i += 1; continue; }
      if (line.startsWith('rename to ')) { if (cur.renNew === null) cur.renNew = line.slice(10).trim(); i += 1; continue; }
      if (line.startsWith('new file mode')) { cur.isCreate = true; i += 1; continue; }
      if (line.startsWith('deleted file mode')) { cur.isDelete = true; i += 1; continue; }
      if (!line.startsWith('@@')) { i += 1; continue; }
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && j + 1 < n && lines[j + 1]!.startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') { body.push(bl); j += 1; }
        else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: parseInt(m[1]!, 10), body });
      i = j;
      continue;
    }
    i += 1;
  }
  return sections.map((sec) => {
    const oldP = sec.pairOld ?? sec.renOld ?? sec.gitOld;
    const newP = sec.pairNew ?? sec.renNew ?? sec.gitNew;
    return (tree: Tree): void => {
      if (oldP !== null && oldP !== undefined && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && newP !== undefined && !safe(newP)) throw new Fail('unsafe', newP);
      const isCreate = sec.isCreate || (oldP === null && newP !== null && newP !== undefined);
      const isDelete = !isCreate && (sec.isDelete || (newP === null && oldP !== null && oldP !== undefined));
      if (isCreate) {
        const np = newP!;
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let bs = false;
        let lastPlus: { h: number; b: number } | null = null;
        sec.hunks.forEach((h, hi) => {
          h.body.forEach((raw, bi) => {
            if (raw[0] === '+') { plus.push(raw.slice(1)); lastPlus = { h: hi, b: bi }; }
          });
        });
        if (lastPlus !== null) {
          const hb = sec.hunks[lastPlus.h]!.body;
          bs = lastPlus.b + 1 < hb.length && hb[lastPlus.b + 1]!.startsWith('\\');
        }
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (bs ? '' : '\n'));
        return;
      }
      if (isDelete) {
        const op = oldP!;
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      if (oldP === null || oldP === undefined || newP === null || newP === undefined) return;
      if (oldP !== newP) {
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const out = applyHunks(tree.get(oldP)!, sec.hunks, strict, oldP);
        tree.now.set(newP, out);
        tree.now.set(oldP, null);
        tree.moves.push([oldP, newP]);
        return;
      }
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, applyHunks(tree.get(oldP)!, sec.hunks, strict, oldP));
    };
  });
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
interface SRBlock { path: string; oldLines: string[]; newLines: string[]; }
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  const n = lines.length;
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const s = i;
    // Path: nearest line before s, after the previous block's REPLACE (or patch start),
    // non-blank, trimmed not starting with three backticks.
    let path: string | null = null;
    for (let k = s - 1; k > prevReplace; k -= 1) {
      const t = lines[k]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    // Find ======= then >>>>>>> REPLACE, bounded by the next SEARCH line.
    let nextSearch = -1;
    for (let k = s + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') { nextSearch = k; break; }
    }
    const end = nextSearch === -1 ? n : nextSearch;
    let eq = -1;
    let rep = -1;
    for (let k = s + 1; k < end; k += 1) {
      if (lines[k]!.trimEnd() === '=======') { eq = k; break; }
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
    for (let k = eq + 1; k < end; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { rep = k; break; }
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const found = findTier(b.oldLines, f.lines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.pos[0]!;
    const nSpec: NLine[] = b.newLines.map((t) => ({ text: t, ctx: null }));
    const rep = buildReplacement(f.lines, pos, b.oldLines, nSpec, found.tier);
    const out = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + b.oldLines.length)];
    tree.now.set(b.path, joinFile(out, f.br, f.endsWithBr));
  });
}

/** V4A patches (SPEC.md section 8). */
interface V4AChunk { anchor: string | null; body: string[]; eof: boolean; }
type V4ASection =
  | { kind: 'add'; path: string; fileLines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4AChunk[] };
function isSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i += 1; continue; }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const raw: { text: string; wasBlank: boolean }[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        const l = lines[j]!;
        if (l.startsWith('+')) raw.push({ text: l.slice(1), wasBlank: false });
        else if (l === '') raw.push({ text: '', wasBlank: true });
        else throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      // Blank lines at the end of a section are not part of it; a '+' line is a file line even if empty.
      while (raw.length > 0 && raw[raw.length - 1]!.wasBlank) raw.pop();
      sections.push({ kind: 'add', path, fileLines: raw.map((r) => r.text) });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      sections.push({ kind: 'delete', path });
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const updateLine = i + 1;
      let j = i + 1;
      while (j < last && blank(lines[j]!)) j += 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice(13).trim();
        j += 1;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      let expectChunk = true;
      while (j < last) {
        const l = lines[j]!;
        if (blank(l)) {
          if (cur !== null) cur.body.push('');
          j += 1;
          continue;
        }
        if (isSectionStart(l)) break;
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          expectChunk = true;
          j += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), body: [], eof: false };
          expectChunk = false;
          j += 1;
          continue;
        }
        if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (!expectChunk || chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
            cur = { anchor: null, body: [], eof: false };
            expectChunk = false;
          }
          cur.body.push(l);
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (cur !== null) {
        while (cur.body.length > 0 && cur.body[cur.body.length - 1] === '') cur.body.pop();
        chunks.push(cur);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((sec) => (tree: Tree): void => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.fileLines.length === 0 ? '' : sec.fileLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    let linesNow = f.lines;
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let at = -1;
        for (const t of tiers) {
          for (let k = cursor; k < linesNow.length; k += 1) {
            if (tierEq(ch.anchor, linesNow[k]!, t)) { at = k; break; }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const { o, n } = splitBody(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? linesNow.length : cursor;
        const ins = n.map((x) => x.text);
        linesNow = [...linesNow.slice(0, at), ...ins, ...linesNow.slice(at)];
        cursor = at + ins.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let found: { tier: number; pos: number[] } | null = null;
      for (const t of tiers) {
        const pos = occurrences(o, linesNow, t, cursor).filter((p) => !ch.eof || p + o.length === linesNow.length);
        if (pos.length > 0) { found = { tier: t, pos }; break; }
      }
      if (found === null) throw new Fail('no-match', sec.path);
      const pos = found.pos[0]!;
      const rep = buildReplacement(linesNow, pos, o, n, found.tier);
      linesNow = [...linesNow.slice(0, pos), ...rep, ...linesNow.slice(pos + o.length)];
      cursor = pos + rep.length;
    }
    const out = joinFile(linesNow, f.br, f.endsWithBr);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const consumed = new Set<string>();
  const entries: { key: string; line: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
