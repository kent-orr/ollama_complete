import { describe, it, expect } from 'vitest';
import { identifiers, selectSnippets } from '../../src/snippets';

const db = [
  "#' Fetch a table from the warehouse",
  'fetch_table <- function(con, table, since = Sys.Date() - 30) {',
  '  DBI::dbGetQuery(con, table)',
  '}',
  '',
  'connect_wh <- function(profile) {',
  "  DBI::dbConnect(odbc::odbc(), dsn = profile)",
  '}',
].join('\n');

const unrelated = ['plot_colours <- c("red", "blue")', 'theme_set(theme_minimal())'].join('\n');

describe('identifiers', () => {
  it('collects word-like identifiers of two or more characters', () => {
    expect([...identifiers('x <- fetch_table(con, "orders") + 10')].sort()).toEqual(['con', 'fetch_table', 'orders']);
  });
});

describe('selectSnippets', () => {
  const query = "source('R/db.R')\ncon <- connect_wh()\norders <- fetch_table(con, ";

  it('returns nothing with a zero budget or no neighbours', () => {
    expect(selectSnippets([{ path: 'R/db.R', text: db }], query, { maxChars: 0 })).toEqual([]);
    expect(selectSnippets([], query, { maxChars: 1000 })).toEqual([]);
  });

  it('picks windows that share identifiers with the query and skips unrelated files', () => {
    const out = selectSnippets(
      [{ path: 'R/plot.R', text: unrelated }, { path: 'R/db.R', text: db }],
      query,
      { maxChars: 1000, windowLines: 4 },
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((s) => s.path === 'R/db.R')).toBe(true);
    expect(out.map((s) => s.text).join('\n')).toContain('fetch_table <- function');
  });

  it('keeps the total size within maxChars', () => {
    const out = selectSnippets([{ path: 'R/db.R', text: db }], query, { maxChars: 120, windowLines: 4 });
    const total = out.reduce((n, s) => n + s.text.length, 0);
    expect(total).toBeLessThanOrEqual(120);
    expect(out.length).toBeGreaterThan(0);
  });

  it('merges overlapping windows from the same file into one contiguous snippet', () => {
    const out = selectSnippets([{ path: 'R/db.R', text: db }], query, { maxChars: 5000, windowLines: 4 });
    expect(out).toHaveLength(1);
    expect(db).toContain(out[0].text);
    expect(out[0].text).toContain('fetch_table <- function');
    expect(out[0].text).toContain('connect_wh <- function');
  });

  it('orders snippets by file and position so code reads top to bottom', () => {
    const out = selectSnippets([{ path: 'R/db.R', text: db }], query, { maxChars: 5000, windowLines: 4 });
    const starts = out.map((s) => db.indexOf(s.text));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
