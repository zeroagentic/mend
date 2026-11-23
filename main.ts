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
  readonly moves: [string, string][] = [];
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

// AUDIT §3: first LF determines the file break; an empty file has no lines or final break.
type TextFile = { lines: string[]; br: string; final: boolean };
function readText(text: string): TextFile {
  const lf = text.indexOf('\n');
  const br = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  const final = text !== '' && text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}
// AUDIT §3: no lines serialize empty; edits retain the current break and final-break flag.
function writeText(f: TextFile): string {
  return f.lines.length ? f.lines.join(f.br) + (f.final ? f.br : '') : '';
}
const trimSpaces = (s: string): string => s.replace(/^ +| +$/g, '');
const indent = (s: string): string => /^[ \t]*/.exec(s)![0];
const normalize = (s: string, tier: number): string =>
  tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+|[ \t]+$/g, '');

// AUDIT §5: KMP returns every occurrence, including overlaps, in linear line comparisons.
function matches(old: string[], lines: string[], tier: number): number[] {
  if (!old.length) return [];
  const pattern = old.map((s) => normalize(s, tier));
  const prefix = new Array<number>(pattern.length).fill(0);
  for (let i = 1, j = 0; i < pattern.length; i++) {
    while (j > 0 && pattern[i] !== pattern[j]) j = prefix[j - 1];
    if (pattern[i] === pattern[j]) j++;
    prefix[i] = j;
  }
  const found: number[] = [];
  for (let i = 0, j = 0; i < lines.length; i++) {
    const line = normalize(lines[i], tier);
    while (j > 0 && line !== pattern[j]) j = prefix[j - 1];
    if (line === pattern[j]) j++;
    if (j === pattern.length) {
      found.push(i + 1 - j);
      j = prefix[j - 1];
    }
  }
  return found;
}
// AUDIT §5/8: choose the first tier with an eligible occurrence; strict tries tier zero only.
function locate(old: string[], lines: string[], strict: boolean, p: string,
  eligible: (at: number) => boolean = () => true): { tier: number; positions: number[] } {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const positions = matches(old, lines, tier).filter(eligible);
    if (positions.length) return { tier, positions };
  }
  throw new Fail('no-match', p);
}
type NewLine = { text: string; context: number | null };
type Body = { old: string[]; next: NewLine[]; noFinal: boolean; plus: string[]; plusNoFinal: boolean };
function bodyOf(body: string[]): Body {
  const old: string[] = [], next: NewLine[] = [], plus: string[] = [];
  let noFinal = false, plusNoFinal = false;
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    const mark = body[i + 1]?.startsWith('\\') ?? false;
    if (l === '' || l.startsWith(' ')) {
      const text = l.slice(1);
      next.push({ text, context: old.length });
      old.push(text);
      noFinal = mark;
    } else if (l.startsWith('-')) old.push(l.slice(1));
    else if (l.startsWith('+')) {
      next.push({ text: l.slice(1), context: null });
      plus.push(l.slice(1));
      noFinal = mark;
      plusNoFinal = mark;
    }
  }
  return { old, next, noFinal, plus, plusNoFinal };
}
// AUDIT §5: contexts use the matched file bytes at every tier; only additions re-indent at tier 2.
function replacement(body: Body, lines: string[], at: number, tier: number): string[] {
  const p = body.old.length ? indent(body.old[0]) : '';
  const f = body.old.length ? indent(lines[at]) : '';
  return body.next.map((n) => {
    if (n.context !== null) return lines[at + n.context];
    if (tier === 2 && !blank(n.text) && n.text.startsWith(p)) return f + n.text.slice(p.length);
    return n.text;
  });
}
function replaceLines(f: TextFile, at: number, count: number, next: string[]): void {
  f.lines = f.lines.slice(0, at).concat(next, f.lines.slice(at + count));
}
function safePaths(...paths: (string | null)[]): void {
  // AUDIT §10: all named paths are checked before existence or matching; null is /dev/null only.
  for (const p of paths) if (p !== null && !safe(p)) throw new Fail('unsafe', p);
}
function existing(tree: Tree, p: string): string {
  const text = tree.get(p);
  if (text === null) throw new Fail('missing', p);
  return text;
}
function create(tree: Tree, p: string, text: string): void {
  if (tree.get(p) !== null) throw new Fail('exists', p);
  tree.now.set(p, text);
}
const parseAt = (n: number): never => { throw new Exit2(`error: parse ${n}`); };

type Hunk = { a: number; body: Body };
type UnifiedSection = {
  old: string | null; next: string | null; pair: boolean; creation: boolean; deletion: boolean; hunks: Hunk[];
};
function unifiedPath(line: string): string | null {
  const p = trimSpaces(line.slice(4).split('\t', 1)[0]);
  return p === '/dev/null' ? null : p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | null = null;
  const start = (old: string | null, next: string | null): UnifiedSection => {
    const s = { old, next, pair: false, creation: false, deletion: false, hunks: [] };
    sections.push(s);
    return s;
  };
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    // AUDIT §6: malformed git headers and every malformed/orphan @@ report their own line.
    if (l.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (!m) parseAt(i + 1);
      section = start(m[1], m[2]);
      i++;
    } else if (l.startsWith('--- ')) {
      // AUDIT §6: an unpaired --- reports the following line, even beyond patch EOF.
      if (!(lines[i + 1] ?? '').startsWith('+++ ')) parseAt(i + 2);
      if (!section || section.pair || section.hunks.length) section = start(null, null);
      section.old = unifiedPath(l);
      section.next = unifiedPath(lines[i + 1]);
      section.pair = true;
      i += 2;
    } else if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (!m || !section) parseAt(i + 1);
      const a = Number(m[1]);
      const body: string[] = [];
      i++;
      // AUDIT §6: counts B/D are ignored; headers or non-body lines end a body, raw trailing empties vanish.
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('diff --git ') || (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
        if (b !== '' && !' -+\\'.includes(b[0])) break;
        body.push(b);
        i++;
      }
      while (body.length && body[body.length - 1] === '') body.pop();
      section.hunks.push({ a, body: bodyOf(body) });
    } else {
      // AUDIT §6: pair paths outrank rename paths, which outrank git paths; metadata/prose are ignored.
      if (section && !section.hunks.length) {
        if (!section.pair && l.startsWith('rename from ')) section.old = trimSpaces(l.slice(12));
        if (!section.pair && l.startsWith('rename to ')) section.next = trimSpaces(l.slice(10));
        if (l.startsWith('new file mode')) section.creation = true;
        if (l.startsWith('deleted file mode')) section.deletion = true;
      }
      i++;
    }
  }
  return sections.map((s): Edit => (tree) => {
    safePaths(s.old, s.next);
    if (s.old === null || s.creation) {
      const p = s.next ?? '';
      safePaths(p);
      const added: string[] = [];
      let noFinal = false;
      // AUDIT §6: creation uses only + lines, with the marker on the last + controlling its final break.
      for (const h of s.hunks) {
        for (const line of h.body.plus) added.push(line);
        if (h.body.plus.length) noFinal = h.body.plusNoFinal;
      }
      create(tree, p, writeText({ lines: added, br: '\n', final: !noFinal }));
      return;
    }
    const p = s.old;
    if (s.next === null || s.deletion) {
      // AUDIT §6: deletion checks existence but does not match any hunk.
      existing(tree, p);
      tree.now.set(p, null);
      return;
    }
    const text = existing(tree, p);
    if (s.next !== p && tree.get(s.next) !== null) throw new Fail('exists', s.next);
    const f = readText(text);
    let d = 0;
    for (const h of s.hunks) {
      const b = h.body;
      let at: number, tier = 0;
      if (!b.old.length) at = Math.max(0, Math.min(f.lines.length, h.a + d));
      else {
        const found = locate(b.old, f.lines, strict, p);
        tier = found.tier;
        at = found.positions[0];
        // AUDIT §6: nearest A-1+d wins, ties retain the earlier occurrence; empty O uses A+d.
        for (const pos of found.positions) if (Math.abs(pos - (h.a - 1 + d)) < Math.abs(at - (h.a - 1 + d))) at = pos;
      }
      const next = replacement(b, f.lines, at, tier);
      // AUDIT §6: only a hunk reaching EOF overrides the final break, using the last context/+ marker.
      if (at + b.old.length === f.lines.length) f.final = !b.noFinal;
      replaceLines(f, at, b.old.length, next);
      d += next.length - b.old.length;
    }
    tree.now.set(s.next, writeText(f));
    if (p !== s.next) {
      tree.now.set(p, null);
      tree.moves.push([p, s.next]);
    }
  });
}

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previous: string | null = null, candidate: string | null = null;
  for (let i = 0; i < lines.length;) {
    const marker = lines[i].trimEnd();
    if (marker !== '<<<<<<< SEARCH') {
      // AUDIT §7: nearest nonblank, non-fence path since the previous block wins, otherwise reuse its path.
      if (!blank(lines[i]) && !lines[i].trim().startsWith('```')) candidate = lines[i].trim();
      i++;
      continue;
    }
    const start = i;
    const p = candidate ?? previous;
    if (p === null) parseAt(start + 1);
    let middle = i + 1;
    // AUDIT §7: marker comparisons remove trailing whitespace only; missing ordered delimiters name SEARCH.
    while (middle < lines.length && lines[middle].trimEnd() !== '=======') middle++;
    let end = middle + 1;
    while (end < lines.length && lines[end].trimEnd() !== '>>>>>>> REPLACE') end++;
    if (middle >= lines.length || end >= lines.length) parseAt(start + 1);
    const old = lines.slice(i + 1, middle), next = lines.slice(middle + 1, end);
    edits.push((tree) => {
      safePaths(p);
      // AUDIT §7: empty old creates; a nonempty old must occur exactly once at its first matching tier.
      if (!old.length) {
        create(tree, p, writeText({ lines: next, br: '\n', final: true }));
        return;
      }
      const f = readText(existing(tree, p));
      const found = locate(old, f.lines, strict, p);
      if (found.positions.length !== 1) throw new Fail('ambiguous', p);
      const at = found.positions[0];
      const body: Body = { old, next: next.map((text) => ({ text, context: null })), plus: [], noFinal: false, plusNoFinal: false };
      replaceLines(f, at, old.length, replacement(body, f.lines, at, found.tier));
      tree.now.set(p, writeText(f));
    });
    previous = p;
    candidate = null;
    i = end + 1;
  }
  return edits;
}

type Chunk = { anchor: string; eof: boolean; body: Body };
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  // AUDIT §8: Begin/End alone are trimmed; bad Begin names its line, bad End names patch-line-count+1.
  if (first < 0) parseAt(1);
  if (lines[first].trim() !== '*** Begin Patch') parseAt(first + 1);
  let last = lines.length - 1;
  while (last >= first && blank(lines[last])) last--;
  if (lines[last].trim() !== '*** End Patch') parseAt(lines.length + 1);
  const header = (l: string) => /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(l);
  const edits: Edit[] = [];
  for (let i = first + 1; i < last;) {
    if (blank(lines[i])) { i++; continue; }
    const h = header(lines[i]);
    if (!h) parseAt(i + 1);
    const sectionLine = i + 1, kind = h[1], p = trimSpaces(h[2]);
    const begin = ++i;
    while (i < last && !header(lines[i])) i++;
    let end = i;
    // AUDIT §8: blank tails between sections are ignored, including space/tab-only lines.
    while (end > begin && blank(lines[end - 1])) end--;
    if (kind === 'Add') {
      const add: string[] = [];
      for (let j = begin; j < end; j++) {
        if (lines[j] !== '' && !lines[j].startsWith('+')) parseAt(j + 1);
        add.push(lines[j].slice(1));
      }
      edits.push((tree) => {
        safePaths(p);
        create(tree, p, writeText({ lines: add, br: '\n', final: true }));
      });
    } else if (kind === 'Delete') {
      // AUDIT §8: Delete has no body; Add permits only plus-prefixed or raw empty lines.
      if (end > begin) parseAt(begin + 1);
      edits.push((tree) => {
        safePaths(p);
        existing(tree, p);
        tree.now.set(p, null);
      });
    } else {
      let j = begin, move: string | null = null;
      // AUDIT §8: Move to is accepted only as the update's first line and may stand without chunks.
      if (j < end && lines[j].startsWith('*** Move to: ')) move = trimSpaces(lines[j++].slice(13));
      const chunks: Chunk[] = [];
      while (j < end) {
        let anchor = '';
        if (lines[j].startsWith('@@')) anchor = trimSpaces(lines[j++].slice(2));
        else if (chunks.length || (lines[j] !== '' && !' -+'.includes(lines[j][0]))) parseAt(j + 1);
        const body: string[] = [];
        while (j < end && (lines[j] === '' || ' -+'.includes(lines[j][0]))) body.push(lines[j++]);
        let eof = false;
        if (j < end && lines[j] === '*** End of File') { eof = true; j++; }
        chunks.push({ anchor, eof, body: bodyOf(body) });
        // AUDIT §8: after the first implicit chunk, chunks need @@; every other internal line is a parse fault.
        if (j < end && !lines[j].startsWith('@@')) parseAt(j + 1);
      }
      if (!chunks.length && move === null) parseAt(sectionLine);
      edits.push((tree) => {
        safePaths(p, move);
        const f = readText(existing(tree, p));
        if (move !== null && tree.get(move) !== null) throw new Fail('exists', move);
        let cursor = 0;
        for (const c of chunks) {
          // AUDIT §8: anchor matching is tiered independently, restricted to the cursor, and skips its line.
          if (c.anchor !== '') cursor = locate([c.anchor], f.lines, strict, p, (at) => at >= cursor).positions[0] + 1;
          const b = c.body;
          let at = c.eof ? f.lines.length : cursor, tier = 0;
          if (b.old.length) {
            const found = locate(b.old, f.lines, strict, p,
              (pos) => pos >= cursor && (!c.eof || pos + b.old.length === f.lines.length));
            at = found.positions[0];
            tier = found.tier;
          }
          // AUDIT §8: EOF restricts matches, empty O inserts at cursor/EOF, and cursor follows written lines.
          const next = replacement(b, f.lines, at, tier);
          replaceLines(f, at, b.old.length, next);
          cursor = at + next.length;
        }
        tree.now.set(move ?? p, writeText(f));
        if (move !== null) {
          tree.now.set(p, null);
          tree.moves.push([p, move]);
        }
      });
    }
  }
  return edits;
}

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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchEdits(lines, strict) : kind === 'v4a' ? v4aEdits(lines, strict) : [];
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
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.get(p));
  const rows = new Map<string, string>();
  for (const p of changed) rows.set(p, `${tree.original(p) === null ? 'A' : tree.get(p) === null ? 'D' : 'M'} ${p}`);
  // AUDIT §2: only successful, qualifying original-to-final move pairs replace D/A and sort by destination.
  const paired = new Set<string>();
  for (const [old, next] of tree.moves) {
    if (!paired.has(old) && !paired.has(next) && tree.original(old) !== null && tree.get(old) === null &&
        tree.original(next) === null && tree.get(next) !== null) {
      rows.delete(old);
      rows.set(next, `R ${old} -> ${next}`);
      paired.add(old);
      paired.add(next);
    }
  }
  // AUDIT §10: no writes precede complete validation; --check has identical output without writing.
  if (!check) {
    for (const p of changed) if (tree.get(p) === null) rmSync(p, { force: true });
    for (const p of changed) {
      const now = tree.get(p);
      if (now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  // AUDIT §2: UTF-8 byte sorting, no unchanged paths, singular only for one output row (R counts once).
  const out = [...rows.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map((p) => rows.get(p)!);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
