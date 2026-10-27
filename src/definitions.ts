/** Picks symbols near the cursor and trims their definitions into prompt snippets. No vscode imports. */
import type { Position } from './context';
import type { Snippet } from './snippets';

export interface SymbolRef {
  name: string;
  line: number;
  character: number;
}

export interface CursorSymbols {
  /** Identifiers to resolve with go-to-definition, most useful first. The call being typed leads. */
  refs: SymbolRef[];
  /** An unfinished identifier ending at the cursor, for a workspace symbol search. */
  partial?: string;
}

export interface CursorSymbolOptions {
  maxRefs: number;
  /** Lines to scan, counting the cursor line. */
  lines: number;
}

/** Where a symbol is defined. `text` is the whole file; lines are zero-based. */
export interface DefinitionSite {
  path: string;
  text: string;
  line: number;
  /** Last line of the declaration, when the language server gives one. */
  endLine?: number;
}

const IDENT_RE = /[\p{L}_][\p{L}\p{N}_]*/gu;
const STRING_RE = /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?/g;
const MIN_PARTIAL = 3;
const KEYWORDS = new Set(
  (
    'if else elif for while repeat do in of function return def class const let var new this self ' +
    'TRUE FALSE NULL NA Inf NaN true false null undefined None True False and or not is ' +
    'import from export library require async await try catch finally with as lambda pass ' +
    'break next continue yield typeof instanceof void switch case default'
  ).split(' '),
);

/** Replaces string contents with spaces so brackets inside them are ignored and columns stay put. */
function maskStrings(line: string): string {
  return line.replace(STRING_RE, (m) => m[0] + ' '.repeat(m.length - 1));
}

export function cursorSymbols(text: string, pos: Position, opts: CursorSymbolOptions): CursorSymbols {
  const all = text.replace(/\r\n/g, '\n').split('\n');
  const lineIdx = Math.min(Math.max(pos.line, 0), all.length - 1);
  const first = Math.max(0, lineIdx - Math.max(1, opts.lines) + 1);
  const lines = all.slice(first, lineIdx + 1);
  lines[lines.length - 1] = lines[lines.length - 1].slice(0, Math.max(0, pos.character));

  const found: SymbolRef[] = [];
  let partial: string | undefined;
  lines.forEach((l, i) => {
    for (const m of l.matchAll(IDENT_RE)) {
      const ref = { name: m[0], line: first + i, character: m.index };
      if (i === lines.length - 1 && m.index + m[0].length === l.length) {
        if (m[0].length >= MIN_PARTIAL) partial = m[0];
      } else if (m[0].length > 1 && !KEYWORDS.has(m[0])) {
        found.push(ref);
      }
    }
  });

  const callee = findCallee(lines.map(maskStrings), first, found);
  const refs: SymbolRef[] = callee ? [callee] : [];
  for (const ref of found.reverse()) {
    if (refs.length >= opts.maxRefs) break;
    if (!refs.some((r) => r.name === ref.name)) refs.push(ref);
  }
  return { refs, partial };
}

/** The identifier just before the innermost unclosed `(`. */
function findCallee(lines: string[], first: number, found: SymbolRef[]): SymbolRef | undefined {
  let depth = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    for (let c = lines[i].length - 1; c >= 0; c--) {
      const ch = lines[i][c];
      if (ch === ')' || ch === ']') depth++;
      else if (ch === '[') depth--;
      else if (ch === '(') {
        if (depth > 0) depth--;
        else {
          const end = lines[i].slice(0, c).trimEnd().length;
          return found.find((r) => r.line === first + i && r.character + r.name.length === end);
        }
      }
    }
  }
  return undefined;
}

const COMMENT_RE = /^\s*(#|\/\/|\/\*|\*|--|@|%)/;
const CLOSER_RE = /^\s*([}\])]|end\b)/;
const MAX_DOC_LINES = 8;

const indentOf = (l: string): number => l.match(/^\s*/)![0].length;

function bracketDelta(line: string): number {
  let d = 0;
  for (const ch of maskStrings(line)) {
    if (ch === '(' || ch === '[') d++;
    else if (ch === ')' || ch === ']') d--;
  }
  return d;
}

/**
 * The doc comment above `line`, the full signature, and as much of the body as fits in `maxLines`.
 * Without `endLine` the body ends where the code dedents back to the definition's own indentation.
 */
export function extractDefinition(text: string, line: number, endLine?: number, maxLines = 12): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (line < 0 || line >= lines.length) return '';
  // Some servers start the range at the doc comment or decorator; move to the code itself.
  while (line < lines.length - 1 && COMMENT_RE.test(lines[line])) line++;

  let docStart = line;
  while (docStart > 0 && lines[docStart - 1].trim() && COMMENT_RE.test(lines[docStart - 1])) docStart--;
  const doc = lines.slice(docStart, Math.min(line, docStart + MAX_DOC_LINES));

  const indent = indentOf(lines[line]);
  const body: string[] = [];
  let depth = 0;
  let signatureDone = false;
  for (let i = line; i < lines.length; i++) {
    const l = lines[i];
    if (signatureDone) {
      if (endLine !== undefined && i > endLine) break;
      if (body.length >= maxLines) break;
      if (l.trim() && indentOf(l) <= indent) {
        if (CLOSER_RE.test(l)) body.push(l);
        break;
      }
    }
    body.push(l);
    depth += bracketDelta(l);
    if (depth <= 0) signatureDone = true;
  }
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return [...doc, ...body].join('\n');
}

export interface SelectDefinitionOptions {
  maxChars: number;
  /** Snippets already in the prompt. Definitions they contain are skipped. */
  existing?: Snippet[];
}

/** Trimmed definitions in the order given, without repeats, within `maxChars`. */
export function selectDefinitions(sites: DefinitionSite[], opts: SelectDefinitionOptions): Snippet[] {
  const out: Snippet[] = [];
  let used = 0;
  for (const site of sites) {
    const text = extractDefinition(site.text, site.line, site.endLine);
    if (!text) continue;
    if (out.some((s) => s.path === site.path && s.text === text)) continue;
    if (opts.existing?.some((s) => s.path === site.path && s.text.includes(text))) continue;
    if (used + text.length > opts.maxChars) continue;
    out.push({ path: site.path, text });
    used += text.length;
  }
  return out;
}

/** `promise`'s value, or `fallback` if it rejects or takes longer than `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}
