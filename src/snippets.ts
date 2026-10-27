/** Picks code from other open files that looks related to the text near the cursor. No vscode imports. */

export interface Neighbor {
  path: string;
  text: string;
}

export interface Snippet {
  path: string;
  text: string;
}

export interface SnippetOptions {
  /** Total characters of snippet text to return. 0 disables. */
  maxChars: number;
  /** Lines per candidate window. Windows overlap by half. */
  windowLines?: number;
}

const IDENT_RE = /[\p{L}_][\p{L}\p{N}_]+/gu;

export function identifiers(text: string): Set<string> {
  return new Set(text.match(IDENT_RE) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

interface Window {
  file: number;
  start: number;
  end: number;
  score: number;
}

/**
 * Best-matching windows from `neighbors`, within `maxChars`. Overlapping or adjacent picks from one
 * file are merged into a single range. Ordered by file and line so code reads top to bottom.
 */
export function selectSnippets(neighbors: Neighbor[], query: string, opts: SnippetOptions): Snippet[] {
  if (opts.maxChars <= 0 || !neighbors.length) return [];
  const size = Math.max(1, opts.windowLines ?? 20);
  const step = Math.max(1, Math.floor(size / 2));
  const q = identifiers(query);
  const files = neighbors.map((n) => n.text.replace(/\r\n/g, '\n').split('\n'));
  const textOf = (r: { file: number; start: number; end: number }): string =>
    files[r.file].slice(r.start, r.end).join('\n').trimEnd();

  const windows: Window[] = [];
  files.forEach((lines, file) => {
    for (let start = 0; start < lines.length; start += step) {
      const end = Math.min(lines.length, start + size);
      const score = jaccard(q, identifiers(lines.slice(start, end).join('\n')));
      if (score > 0) windows.push({ file, start, end, score });
      if (end === lines.length) break;
    }
  });
  windows.sort((a, b) => b.score - a.score);

  let ranges: Window[] = [];
  let used = 0;
  for (const w of windows) {
    const touching = ranges.filter((r) => r.file === w.file && r.start <= w.end && w.start <= r.end);
    const merged = {
      ...w,
      start: Math.min(w.start, ...touching.map((r) => r.start)),
      end: Math.max(w.end, ...touching.map((r) => r.end)),
    };
    const cost = textOf(merged).length - touching.reduce((n, r) => n + textOf(r).length, 0);
    if (used + cost > opts.maxChars) continue;
    ranges = ranges.filter((r) => !touching.includes(r)).concat(merged);
    used += cost;
  }
  ranges.sort((a, b) => a.file - b.file || a.start - b.start);
  return ranges.map((r) => ({ path: neighbors[r.file].path, text: textOf(r) }));
}
