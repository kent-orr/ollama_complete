/** Cleans raw model output into insertable text. No vscode imports. */

export interface PostprocessOptions {
  maxLines: number;
  /** Full suffix sent to the model; used to drop a duplicated tail. */
  suffix: string;
  /** Text right of the cursor on the cursor line; used to drop a duplicated head. */
  currentLineSuffix: string;
  /** Text left of the cursor on the cursor line; drives leading-newline and indentation handling. */
  linePrefix?: string;
}

const SPECIAL_TOKEN_RE =
  /<\|[a-z_▁]+\|>|<｜[a-z_▁]+｜>|<(?:fim_prefix|fim_suffix|fim_middle|file_sep|EOT|EOS|PRE|SUF|MID|eos)>/g;

const THINK_RE = /<think>[\s\S]*?<\/think>\s*/g;

const LEADING_BLANK_LINES_RE = /^(?:[ \t]*\n)+/;

/** Code ending like this continues on the same line: assignment, operator, open bracket, comma, pipe. */
const CONTINUATION_RE = /(?:[=([,+\-*/%&|!?~^.]|<-|\|>|=>)$/;

function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)![0].length;
}

function stripFence(s: string): string {
  const lines = s.split('\n');
  // Drop leading blank lines before checking for a fence.
  while (lines.length && lines[0].trim() === '') lines.shift();
  if (lines.length && /^\s*```/.test(lines[0])) {
    lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length && /^\s*```\s*$/.test(lines[lines.length - 1])) lines.pop();
    return lines.join('\n');
  }
  return s;
}

/** Remove the longest prefix of `suffix` that `out` ends with, if it is substantial. */
function dropSuffixOverlap(out: string, suffix: string): string {
  if (!suffix) return out;
  const maxLen = Math.min(out.length, suffix.length);
  for (let len = maxLen; len > 0; len--) {
    const cand = suffix.slice(0, len);
    if (out.endsWith(cand)) {
      const meaningful = cand.replace(/\s/g, '').length;
      if (meaningful >= 3) return out.slice(0, out.length - len);
      return out;
    }
  }
  return out;
}

/** Remove `delta` columns of indentation (or add them when negative), never cutting into code. */
function shiftIndent(line: string, delta: number, pad: string): string {
  if (delta < 0) return pad.repeat(-delta) + line;
  return line.slice(Math.min(delta, indentOf(line)));
}

/**
 * Small models often open with a newline. On a blank line, drop it and re-base the block on the
 * indentation the editor already gave the cursor. After code that clearly continues (`x <- `, `foo(`),
 * join onto the line. After a typed space, drop the model's own leading space.
 */
function fitToCursorLine(s: string, linePrefix: string, lineSuffix: string): string {
  const blankLine = !/\S/.test(linePrefix + lineSuffix);
  if (!LEADING_BLANK_LINES_RE.test(s)) {
    return !blankLine && /[ \t]$/.test(linePrefix) ? s.replace(/^[ \t]+/, '') : s;
  }
  const body = s.replace(LEADING_BLANK_LINES_RE, '');
  if (blankLine) {
    if (!linePrefix) return body;
    const lines = body.split('\n');
    const delta = indentOf(lines[0]) - linePrefix.length;
    return lines.map((l, i) => (i === 0 ? l.replace(/^[ \t]+/, '') : shiftIndent(l, delta, linePrefix[0]))).join('\n');
  }
  const code = linePrefix.trimEnd();
  if (!CONTINUATION_RE.test(code) || code.endsWith('*/')) return s;
  const space = /[\s([.]$/.test(linePrefix) ? '' : ' ';
  return space + body.replace(/^[ \t]+/, '');
}

/** Cut at the first line that repeats the next non-blank line below the cursor, if that line is substantial. */
function cutAtSuffixRepeat(lines: string[], suffix: string): string[] {
  const next = suffix.split('\n').slice(1).find((l) => l.trim())?.trim();
  if (!next || next.length < 4 || !/[\p{L}\p{N}]/u.test(next)) return lines;
  const i = lines.findIndex((l) => l.trim() === next);
  return i >= 0 ? lines.slice(0, i) : lines;
}

/** Cut where a later line dedents below the cursor line: the block being completed has ended. */
function limitToIndentScope(lines: string[], base: number): string[] {
  if (!base) return lines;
  const i = lines.findIndex((l, idx) => idx > 0 && /\S/.test(l) && indentOf(l) < base);
  return i > 0 ? lines.slice(0, i) : lines;
}

export function postprocess(raw: string, opts: PostprocessOptions): string {
  let s = raw.replace(/\r\n/g, '\n');
  s = s.replace(THINK_RE, '');
  s = stripFence(s);
  s = s.replace(SPECIAL_TOKEN_RE, '');

  if (opts.currentLineSuffix && s.startsWith(opts.currentLineSuffix)) {
    s = s.slice(opts.currentLineSuffix.length);
  }

  const linePrefix = opts.linePrefix ?? '';
  const suffix = opts.suffix.replace(/\r\n/g, '\n');
  s = fitToCursorLine(s, linePrefix, opts.currentLineSuffix);
  s = dropSuffixOverlap(s, suffix);

  let lines = cutAtSuffixRepeat(s.split('\n'), suffix);
  lines = limitToIndentScope(lines, indentOf(linePrefix));
  if (lines.length > opts.maxLines) lines = lines.slice(0, Math.max(1, opts.maxLines));

  return lines.join('\n').trimEnd();
}
