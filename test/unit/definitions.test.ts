import { describe, it, expect } from 'vitest';
import { cursorSymbols, extractDefinition, selectDefinitions, withTimeout } from '../../src/definitions';

const opts = { maxRefs: 6, lines: 5 };

describe('cursorSymbols', () => {
  it('puts the function being called at the cursor first', () => {
    const text = 'con <- connect_wh()\norders <- fetch_table(con, \n';
    const out = cursorSymbols(text, { line: 1, character: 26 }, opts);
    expect(out.refs[0]).toEqual({ name: 'fetch_table', line: 1, character: 10 });
  });

  it('finds the callee across lines and past closed calls', () => {
    const text = 'x <- summarise(df,\n  total = sum(a), ';
    const out = cursorSymbols(text, { line: 1, character: 18 }, opts);
    expect(out.refs[0].name).toBe('summarise');
  });

  it('ignores brackets inside strings when finding the callee', () => {
    const text = 'paste0("(", label, ';
    const out = cursorSymbols(text, { line: 0, character: 19 }, opts);
    expect(out.refs[0].name).toBe('paste0');
  });

  it('lists other identifiers nearest the cursor first, without duplicates or keywords', () => {
    const text = 'def run(rows):\n    if rows:\n        total = helper_total(rows)\n        ';
    const out = cursorSymbols(text, { line: 3, character: 8 }, opts);
    expect(out.refs.map((r) => r.name)).toEqual(['rows', 'helper_total', 'total', 'run']);
    expect(out.refs.find((r) => r.name === 'rows')).toEqual({ name: 'rows', line: 2, character: 29 });
  });

  it('only looks back the configured number of lines and caps the count', () => {
    const text = 'alpha()\nbeta()\ngamma()\ndelta()\n';
    expect(cursorSymbols(text, { line: 3, character: 7 }, { maxRefs: 6, lines: 2 }).refs.map((r) => r.name)).toEqual([
      'delta',
      'gamma',
    ]);
    expect(cursorSymbols(text, { line: 3, character: 7 }, { maxRefs: 1, lines: 5 }).refs).toHaveLength(1);
  });

  it('reports a partial word at the cursor separately from the refs', () => {
    const text = 'con <- connect_wh()\norders <- fetch_';
    const out = cursorSymbols(text, { line: 1, character: 16 }, opts);
    expect(out.partial).toBe('fetch_');
    expect(out.refs.map((r) => r.name)).not.toContain('fetch_');
    expect(out.refs.map((r) => r.name)).toContain('connect_wh');
  });

  it('ignores partial words shorter than three characters', () => {
    expect(cursorSymbols('x <- fe', { line: 0, character: 7 }, opts).partial).toBeUndefined();
  });

  it('does not look past the cursor', () => {
    const out = cursorSymbols('a <- \nlater_thing()\n', { line: 0, character: 5 }, opts);
    expect(out.refs).toEqual([]);
  });
});

describe('extractDefinition', () => {
  const r = [
    'library(DBI)',
    '',
    "#' Fetch a table from the warehouse",
    "#' @param con A DBI connection",
    'fetch_table <- function(con, table,',
    '                        since = Sys.Date() - 30) {',
    '  DBI::dbGetQuery(con, table)',
    '}',
    '',
    'other <- 1',
  ].join('\n');

  it('takes the doc comment, a multi-line signature and a short body', () => {
    expect(extractDefinition(r, 4)).toBe(
      [
        "#' Fetch a table from the warehouse",
        "#' @param con A DBI connection",
        'fetch_table <- function(con, table,',
        '                        since = Sys.Date() - 30) {',
        '  DBI::dbGetQuery(con, table)',
        '}',
      ].join('\n'),
    );
  });

  it('stops at the end of a python function, keeping its docstring', () => {
    const py = [
      '@cache',
      'def total(rows, *, tax=0.2):',
      '    """Sum rows and add tax."""',
      '    s = sum(rows)',
      '',
      '    return s * (1 + tax)',
      '',
      'def other():',
      '    pass',
    ].join('\n');
    expect(extractDefinition(py, 1)).toBe(
      ['@cache', 'def total(rows, *, tax=0.2):', '    """Sum rows and add tax."""', '    s = sum(rows)', '', '    return s * (1 + tax)'].join('\n'),
    );
  });

  it('caps long definitions at maxLines, always keeping the signature', () => {
    const long = ['function big(a, b) {', ...Array.from({ length: 30 }, (_, i) => `  step${i}();`), '}'].join('\n');
    const out = extractDefinition(long, 0, undefined, 4);
    expect(out.split('\n')).toEqual(['function big(a, b) {', '  step0();', '  step1();', '  step2();']);
  });

  it('respects an end line from the language server', () => {
    const ts = ['export const RATE = 0.2;', 'export const OTHER = 1;'].join('\n');
    expect(extractDefinition(ts, 0, 0)).toBe('export const RATE = 0.2;');
  });

  it('keeps only the first lines of a long doc comment', () => {
    const doc = [...Array.from({ length: 12 }, (_, i) => `// note ${i}`), 'const x = 1;'].join('\n');
    const out = extractDefinition(doc, 12).split('\n');
    expect(out[0]).toBe('// note 0');
    expect(out[out.length - 1]).toBe('const x = 1;');
    expect(out.length).toBeLessThanOrEqual(9);
  });

  it('handles a start line that points at the doc comment instead of the code', () => {
    const ts = ['/**', ' * Adds tax.', ' */', 'export function withTax(x: number): number {', '  return x * 1.2;', '}', 'const y = 1;'].join('\n');
    expect(extractDefinition(ts, 0)).toBe(ts.split('\n').slice(0, 6).join('\n'));
  });

  it('returns an empty string for a line outside the file', () => {
    expect(extractDefinition('a\nb', 7)).toBe('');
  });
});

describe('selectDefinitions', () => {
  const site = (path: string, text: string, line = 0) => ({ path, text, line });

  it('extracts each site in order and drops duplicates', () => {
    const a = site('R/db.R', 'f <- function(x) {\n  x\n}\n');
    const b = site('R/util.R', 'g <- function(y) y\n');
    const out = selectDefinitions([a, b, a], { maxChars: 1000 });
    expect(out).toEqual([
      { path: 'R/db.R', text: 'f <- function(x) {\n  x\n}' },
      { path: 'R/util.R', text: 'g <- function(y) y' },
    ]);
  });

  it('skips definitions already shown in a snippet from the same file', () => {
    const a = site('R/db.R', 'f <- function(x) {\n  x\n}\n');
    const existing = [{ path: 'R/db.R', text: 'z <- 1\nf <- function(x) {\n  x\n}' }];
    expect(selectDefinitions([a], { maxChars: 1000, existing })).toEqual([]);
  });

  it('stays within the character budget, skipping what does not fit', () => {
    const big = site('a.py', `def big():\n    return "${'x'.repeat(200)}"\n`);
    const small = site('b.py', 'def small(): pass\n');
    const out = selectDefinitions([big, small], { maxChars: 50 });
    expect(out.map((s) => s.path)).toEqual(['b.py']);
  });

  it('returns nothing with a zero budget', () => {
    expect(selectDefinitions([site('a.py', 'def a(): pass')], { maxChars: 0 })).toEqual([]);
  });
});

describe('withTimeout', () => {
  it('resolves with the value when it arrives in time', async () => {
    expect(await withTimeout(Promise.resolve([1]), 50, [])).toEqual([1]);
  });

  it('resolves with the fallback when the promise is too slow or rejects', async () => {
    expect(await withTimeout(new Promise<number[]>(() => {}), 10, [])).toEqual([]);
    expect(await withTimeout(Promise.reject(new Error('lsp down')), 50, [])).toEqual([]);
  });
});
