/** Pure helpers for slicing a document around the cursor. No vscode imports. */

export interface Position {
  line: number;
  character: number;
}

export interface ContextOptions {
  linesAbove: number;
  linesBelow: number;
}

export interface CompletionContext {
  /** Text before the cursor, limited to `linesAbove` lines plus the partial current line. */
  prefix: string;
  /** Text after the cursor, from the cursor to end of line plus up to `linesBelow` lines. */
  suffix: string;
  /** The part of the current line that sits to the right of the cursor. */
  currentLineSuffix: string;
  /** The part of the current line that sits to the left of the cursor. */
  linePrefix: string;
}

export function buildContext(text: string, pos: Position, opts: ContextOptions): CompletionContext {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const lineIdx = Math.min(Math.max(pos.line, 0), lines.length - 1);
  const current = lines[lineIdx];
  const ch = Math.min(Math.max(pos.character, 0), current.length);

  const aboveStart = Math.max(0, lineIdx - Math.max(0, opts.linesAbove));
  const above = lines.slice(aboveStart, lineIdx);
  const prefix = (above.length ? above.join('\n') + '\n' : '') + current.slice(0, ch);

  const currentLineSuffix = current.slice(ch);
  const below = lines.slice(lineIdx + 1, lineIdx + 1 + Math.max(0, opts.linesBelow));
  const suffix = currentLineSuffix + (below.length ? '\n' + below.join('\n') : '');

  return { prefix, suffix, currentLineSuffix, linePrefix: current.slice(0, ch) };
}
