import { describe, it, expect } from 'vitest';
import { buildContext } from '../../src/context';

const text = ['line0', 'line1', 'line2', 'line3', 'line4', 'line5'].join('\n');

describe('buildContext', () => {
  it('splits at the cursor within the current line', () => {
    const ctx = buildContext(text, { line: 2, character: 3 }, { linesAbove: 100, linesBelow: 100 });
    expect(ctx.prefix).toBe('line0\nline1\nlin');
    expect(ctx.suffix).toBe('e2\nline3\nline4\nline5');
    expect(ctx.currentLineSuffix).toBe('e2');
    expect(ctx.linePrefix).toBe('lin');
  });

  it('exposes the cursor line text left of the cursor regardless of linesAbove', () => {
    const ctx = buildContext('a\n    b = 1\n', { line: 1, character: 4 }, { linesAbove: 0, linesBelow: 0 });
    expect(ctx.linePrefix).toBe('    ');
  });

  it('limits lines above the cursor', () => {
    const ctx = buildContext(text, { line: 4, character: 0 }, { linesAbove: 2, linesBelow: 100 });
    expect(ctx.prefix).toBe('line2\nline3\n');
  });

  it('limits lines below the cursor', () => {
    const ctx = buildContext(text, { line: 1, character: 5 }, { linesAbove: 100, linesBelow: 1 });
    expect(ctx.suffix).toBe('\nline2');
  });

  it('handles zero context lines', () => {
    const ctx = buildContext(text, { line: 3, character: 2 }, { linesAbove: 0, linesBelow: 0 });
    expect(ctx.prefix).toBe('li');
    expect(ctx.suffix).toBe('ne3');
  });

  it('normalizes CRLF to LF', () => {
    const crlf = 'a\r\nb\r\nc';
    const ctx = buildContext(crlf, { line: 1, character: 1 }, { linesAbove: 10, linesBelow: 10 });
    expect(ctx.prefix).toBe('a\nb');
    expect(ctx.suffix).toBe('\nc');
  });

  it('works at the very start and very end of the document', () => {
    const start = buildContext(text, { line: 0, character: 0 }, { linesAbove: 5, linesBelow: 5 });
    expect(start.prefix).toBe('');
    expect(start.suffix).toBe(text);
    const end = buildContext(text, { line: 5, character: 5 }, { linesAbove: 5, linesBelow: 5 });
    expect(end.prefix).toBe(text);
    expect(end.suffix).toBe('');
  });

  it('clamps an out-of-range character to the line length', () => {
    const ctx = buildContext(text, { line: 0, character: 99 }, { linesAbove: 5, linesBelow: 5 });
    expect(ctx.prefix).toBe('line0');
  });
});
