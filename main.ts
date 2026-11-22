// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// The command line, output and exit codes, safe paths, format detection, JSON
// edits and the all-or-nothing write follow SPEC.md sections 1 to 4, 9 and 10.
// Line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8) are written
// here from the specification.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

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

/** A file's text as lines: its line break, its lines, whether it ends with one. */
interface FileText {
  br: '\n' | '\r\n';
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>();
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

/* ------------------------------------------------------------------ */
/* Section 5: matching lines at three tiers.                           */
/* ------------------------------------------------------------------ */

/** One line of the replacement: a context line (written as the file's own
 *  matched line) or a new line. `oIdx` is the context line's index in O. */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

function tierLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where O occurs at this tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const pos: number[] = [];
  if (o.length === 0) return pos;
  const ot = o.map((l) => tierLine(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (tierLine(lines[i + j]!, tier) !== ot[j]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs
 *  at or after `from`, with every occurrence there. */
function firstTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** Replace the k matched lines at `start` with N. Context lines are written
 *  as the file's own matched lines; at tier 2 every other line of N is
 *  re-indented from O's first line's leading whitespace to the file's. */
function buildReplacement(
  fileLines: string[],
  start: number,
  oLen: number,
  nLines: NLine[],
  tier: number,
  oLines: string[],
): string[] {
  const repl: string[] = [];
  if (tier === 2 && oLines.length > 0) {
    const f = leadingWs(fileLines[start]!);
    const p = leadingWs(oLines[0]!);
    for (const nl of nLines) {
      if (nl.ctx) repl.push(fileLines[start + nl.oIdx]!);
      else if (nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) repl.push(f + nl.text.slice(p.length));
      else repl.push(nl.text);
    }
  } else {
    for (const nl of nLines) {
      if (nl.ctx) repl.push(fileLines[start + nl.oIdx]!);
      else repl.push(nl.text);
    }
  }
  const out = [...fileLines];
  out.splice(start, oLen, ...repl);
  return out;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
}

/** Split a hunk/chunk body into its old lines O and its new lines N. */
function splitBody(body: BodyLine[]): { oLines: string[]; nLines: NLine[] } {
  const oLines: string[] = [];
  const nLines: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      oLines.push(b.text);
      nLines.push({ text: b.text, ctx: true, oIdx: oLines.length - 1 });
    } else if (b.kind === 'del') {
      oLines.push(b.text);
    } else if (b.kind === 'add') {
      nLines.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { oLines, nLines };
}

/** N's length minus O's length, for the running offset d of a section. */
function bodyDelta(body: BodyLine[]): number {
  let o = 0;
  let n = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      o += 1;
      n += 1;
    } else if (b.kind === 'del') o += 1;
    else if (b.kind === 'add') n += 1;
  }
  return n - o;
}

/** Whether a `\` line follows the body's last context or `+` line. */
function lastLineNoBreak(body: BodyLine[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    if (body[j]!.kind === 'ctx' || body[j]!.kind === 'add') last = j;
  }
  return last >= 0 && body[last + 1]?.kind === 'bs';
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs.                                           */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
  pairSeen: boolean;
}

/** A `---`/`+++` path: after the four characters, up to the first tab, with
 *  surrounding spaces removed and a leading a/ or b/ removed. */
function cleanPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inBody = false;
  let curHunk: Hunk | null = null;

  const startSection = (s: Section): void => {
    sections.push(s);
    cur = s;
    inBody = false;
    curHunk = null;
  };
  const flushHunk = (): void => {
    if (curHunk !== null && cur !== null) {
      while (curHunk.body.length > 0) {
        const b = curHunk.body[curHunk.body.length - 1]!;
        if (b.kind === 'ctx' && b.text === '') curHunk.body.pop();
        else break;
      }
      cur.hunks.push(curHunk);
    }
    curHunk = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${i + 1}`);
      const bIdx = rest.indexOf(' b/');
      if (bIdx < 0) throw new Exit2(`error: parse ${i + 1}`);
      const x = rest.slice(2, bIdx);
      const y = rest.slice(bIdx + 3);
      if (x === '' || y === '') throw new Exit2(`error: parse ${i + 1}`);
      flushHunk();
      startSection({
        oldPath: null,
        newPath: null,
        renameFrom: null,
        renameTo: null,
        gitOld: x,
        gitNew: y,
        isNew: false,
        isDeleted: false,
        hunks: [],
        pairSeen: false,
      });
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !inBody && !cur.pairSeen) {
        cur.oldPath = cleanPath(line.slice(4));
        cur.newPath = cleanPath(lines[i + 1]!.slice(4));
        cur.pairSeen = true;
        i += 2;
        continue;
      }
      flushHunk();
      startSection({
        oldPath: cleanPath(line.slice(4)),
        newPath: cleanPath(lines[i + 1]!.slice(4)),
        renameFrom: null,
        renameTo: null,
        gitOld: null,
        gitNew: null,
        isNew: false,
        isDeleted: false,
        hunks: [],
        pairSeen: true,
      });
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (cur === null || m === null) throw new Exit2(`error: parse ${i + 1}`);
      flushHunk();
      curHunk = { a: Number(m[1]), body: [] };
      inBody = true;
      i += 1;
      continue;
    }
    if (curHunk !== null) {
      if (line === '') {
        curHunk.body.push({ kind: 'ctx', text: '' });
        i += 1;
        continue;
      }
      if (line.startsWith(' ')) {
        curHunk.body.push({ kind: 'ctx', text: line.slice(1) });
        i += 1;
        continue;
      }
      if (line.startsWith('-')) {
        curHunk.body.push({ kind: 'del', text: line.slice(1) });
        i += 1;
        continue;
      }
      if (line.startsWith('+')) {
        curHunk.body.push({ kind: 'add', text: line.slice(1) });
        i += 1;
        continue;
      }
      if (line.startsWith('\\')) {
        curHunk.body.push({ kind: 'bs', text: line.slice(1) });
        i += 1;
        continue;
      }
      flushHunk();
      continue;
    }
    if (cur !== null && !inBody) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isNew = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDeleted = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  flushHunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply one hunk to the file's current lines. `d` is the running offset of
 *  this section's hunks applied so far. */
function applyHunk(f: FileText, h: Hunk, d: number, strict: boolean, path: string): FileText {
  const { oLines, nLines } = splitBody(h.body);
  const noBreak = lastLineNoBreak(h.body);
  if (oLines.length === 0) {
    const idx = Math.max(0, Math.min(h.a + d, f.lines.length));
    const ins = nLines.map((nl) => nl.text);
    const lines = [...f.lines];
    lines.splice(idx, 0, ...ins);
    let final = f.final;
    if (ins.length > 0 && idx === f.lines.length) final = !noBreak;
    return { br: f.br, lines, final };
  }
  const found = firstTier(f.lines, oLines, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.positions[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const lines = buildReplacement(f.lines, best, oLines.length, nLines, found.tier, oLines);
  let final = f.final;
  if (best + oLines.length === f.lines.length) final = !noBreak;
  return { br: f.br, lines, final };
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.oldPath ?? s.renameFrom ?? s.gitOld ?? s.newPath ?? s.renameTo ?? s.gitNew ?? '';
  const newPath = s.newPath ?? s.renameTo ?? s.gitNew ?? s.oldPath ?? s.renameFrom ?? s.gitOld ?? '';
  const isCreate = oldPath === '/dev/null' || s.isNew;
  const isDelete = newPath === '/dev/null' || s.isDeleted;
  return (tree) => {
    if (isCreate) {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let lastPlusNoBreak = false;
      for (const h of s.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          const b = h.body[j]!;
          if (b.kind === 'add') {
            plus.push(b.text);
            lastPlusNoBreak = h.body[j + 1]?.kind === 'bs';
          }
        }
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoBreak ? '' : '\n');
      tree.now.set(newPath, text);
      return;
    }
    if (isDelete) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const isMove = oldPath !== newPath;
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let f = parseFile(before);
    let d = 0;
    for (const h of s.hunks) {
      f = applyHunk(f, h, d, strict, oldPath);
      d += bodyDelta(h.body);
    }
    const out = renderFile(f);
    if (isMove) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      tree.moves.set(oldPath, newPath);
    } else {
      tree.now.set(oldPath, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks.                                   */
/* ------------------------------------------------------------------ */

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNum = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchNum}`);
    }
    let eq = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchNum}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchNum}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    const found = firstTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const start = found.positions[0]!;
    const nLines: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const lines = buildReplacement(f.lines, start, oldLines.length, nLines, found.tier, oldLines);
    tree.now.set(path, renderFile({ br: f.br, lines, final: f.final }));
  };
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches.                                             */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      i += 1;
      const fileLines: { text: string; blank: boolean }[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) {
          fileLines.push({ text: l.slice(1), blank: false });
          i += 1;
        } else if (l === '') {
          fileLines.push({ text: '', blank: true });
          i += 1;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1]!.blank) fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines.map((x) => x.text)));
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      i += 1;
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      const updateNum = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let seenChunk = false;
      const pushBody = (l: string): void => {
        if (l === '') cur!.body.push({ kind: 'ctx', text: '' });
        else if (l.startsWith(' ')) cur!.body.push({ kind: 'ctx', text: l.slice(1) });
        else if (l.startsWith('-')) cur!.body.push({ kind: 'del', text: l.slice(1) });
        else cur!.body.push({ kind: 'add', text: l.slice(1) });
      };
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          seenChunk = true;
          i += 1;
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          i += 1;
        } else if (cur !== null && (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '')) {
          pushBody(l);
          i += 1;
        } else if (cur === null && seenChunk && blank(l)) {
          i += 1;
        } else if (cur === null && !seenChunk && (l === '' || l.startsWith(' '))) {
          cur = { anchor: null, body: [], eof: false };
          seenChunk = true;
          pushBody(l);
          i += 1;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      if (cur !== null) {
        while (cur.body.length > 0) {
          const b = cur.body[cur.body.length - 1]!;
          if (b.kind === 'ctx' && b.text.trim() === '') cur.body.pop();
          else break;
        }
        if (cur.body.length > 0 || cur.anchor !== null || cur.eof) chunks.push(cur);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNum}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = parseFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const a = firstTier(f.lines, [chunk.anchor], strict, cursor);
        if (a === null) throw new Fail('no-match', path);
        cursor = a.positions[0]! + 1;
      }
      const { oLines, nLines } = splitBody(chunk.body);
      if (oLines.length === 0) {
        const idx = chunk.eof ? f.lines.length : cursor;
        const ins = nLines.map((nl) => nl.text);
        const lines = [...f.lines];
        lines.splice(idx, 0, ...ins);
        f = { br: f.br, lines, final: f.final };
        cursor = idx + ins.length;
      } else {
        const found = firstTier(f.lines, oLines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let positions = found.positions;
        if (chunk.eof) positions = positions.filter((p) => p + oLines.length === f.lines.length);
        if (positions.length === 0) throw new Fail('no-match', path);
        const start = positions[0]!;
        const lines = buildReplacement(f.lines, start, oLines.length, nLines, found.tier, oLines);
        f = { br: f.br, lines, final: f.final };
        cursor = start + nLines.length;
      }
    }
    const out = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.set(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits.                                              */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Sections 1, 2 and 10: the command line, output and atomicity.      */
/* ------------------------------------------------------------------ */

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSR(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const rPairs: [string, string][] = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) rPairs.push([o, n]);
  }
  const rOld = new Set(rPairs.map(([o]) => o));
  const rNew = new Set(rPairs.map(([, n]) => n));
  for (const [o, n] of rPairs) rows.push({ key: n, line: `R ${o} -> ${n}` });
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
