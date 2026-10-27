/**
 * Live regression test for the model/prompt pairing. Skipped unless OLLAMA_LIVE=1.
 * Run with: npm run test:live
 */
import { describe, it, expect } from 'vitest';
import { OllamaClient } from '../../src/ollama';
import { buildContext } from '../../src/context';
import { buildFimPrompt, buildChatMessages } from '../../src/prompt';
import { postprocess } from '../../src/postprocess';
import { CompletionEngine, type EngineConfig } from '../../src/engine';

const live = process.env.OLLAMA_LIVE === '1';
const HOST = process.env.OLLAMA_HOST_URL ?? 'http://localhost:11434';
const MODEL = process.env.PAWPLETE_MODEL ?? 'qwen3.5:2b';

const source = [
  'def fibonacci(n):',
  '    """Return the nth Fibonacci number."""',
  '',
  '',
  'print(fibonacci(10))',
  '',
].join('\n');

describe.skipIf(!live)(`live: ${MODEL} at ${HOST}`, () => {
  const client = new OllamaClient({ host: HOST });

  it('lists the default model', async () => {
    const models = await client.listModels();
    expect(models).toContain(MODEL);
  }, 30_000);

  it('completes a function body in fim mode', async () => {
    const ctx = buildContext(source, { line: 2, character: 0 }, { linesAbove: 100, linesBelow: 30 });
    const fim = buildFimPrompt(ctx, MODEL);
    expect(fim).toBeDefined();
    const raw = await client.generate({
      model: MODEL,
      prompt: fim!.prompt,
      keepAlive: '5m',
      options: { temperature: 0.2, num_predict: 128, presence_penalty: 0, stop: fim!.stop },
    });
    const out = postprocess(raw, { maxLines: 8, ...ctx });
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('```');
    expect(out).not.toContain('<|');
    expect(out).toMatch(/^\s{4}\S/m); // at least one 4-space indented line
    expect(out).toMatch(/return/);
    expect(out).not.toContain('print(fibonacci(10))');
  }, 60_000);

  it('completes a function body in chat mode with thinking off', async () => {
    const ctx = buildContext(source, { line: 2, character: 0 }, { linesAbove: 100, linesBelow: 30 });
    const raw = await client.chat({
      model: MODEL,
      messages: buildChatMessages(ctx, ''),
      think: false,
      keepAlive: '5m',
      options: { temperature: 0.2, num_predict: 128, presence_penalty: 0 },
    });
    const out = postprocess(raw, { maxLines: 8, ...ctx });
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('```');
    expect(out).toMatch(/return/);
  }, 60_000);

  describe('through the engine', () => {
    const config: EngineConfig = {
      enabled: true, host: HOST, model: MODEL, mode: 'fim', thinking: false, instructions: '',
      contextLinesAbove: 100, contextLinesBelow: 30, maxLines: 5, maxTokens: 128, temperature: 0,
      debounceMs: 0, triggerMode: 'automatic', keepAlive: '5m', disabledLanguages: [],
      adaptiveLines: true, crossFileContextChars: 2000, definitionContextChars: 1500,
    };
    const engine = new CompletionEngine({ client: () => client, config: () => config });

    it('fills an indented blank line without a stray leading newline', async () => {
      const out = await engine.complete({
        text: source, position: { line: 2, character: 4 }, languageId: 'python', automatic: false,
        filePath: 'fib.py',
      });
      expect(out).toBeDefined();
      expect(out!.startsWith('\n')).toBe(false);
      expect(out!.split('\n').length).toBeLessThanOrEqual(5);
      expect(out!.split('\n').slice(1).every((l) => !l.trim() || l.startsWith('    '))).toBe(true);
    }, 60_000);

    it('gives one line after code and uses a helper from another open file', async () => {
      const db = [
        "#' Fetch a table from the warehouse",
        'fetch_table <- function(con, table, since = Sys.Date() - 30) {',
        '  DBI::dbGetQuery(con, glue::glue_sql("SELECT * FROM {`table`}", .con = con))',
        '}',
        '',
        "connect_wh <- function(profile = 'default') {",
        "  DBI::dbConnect(odbc::odbc(), dsn = paste0('wh_', profile))",
        '}',
      ].join('\n');
      const text = "source('R/db.R')\n\ncon <- connect_wh()\norders <- \nsummary(orders)\n";
      const out = await engine.complete({
        text, position: { line: 3, character: 10 }, languageId: 'r', automatic: false,
        filePath: 'R/analysis.R', neighbors: () => [{ path: 'R/db.R', text: db }],
      });
      expect(out).toBeDefined();
      expect(out).not.toContain('\n');
      expect(out).toContain('fetch_table(');
    }, 60_000);

    it('uses the signature of a helper found by definition lookup in a closed file', async () => {
      const warehouse = [
        "#' Pull a point-in-time snapshot of the order book",
        "#' @param as_of Date of the snapshot",
        'wh_pull_ord_snapshot <- function(con, as_of, region = "na", include_returns = FALSE) {',
        '  DBI::dbGetQuery(con, build_snapshot_sql(as_of, region, include_returns))',
        '}',
      ].join('\n');
      const text = 'con <- connect_wh()\norders <- wh_\nsummary(orders)\n';
      const out = await engine.complete({
        text, position: { line: 1, character: 13 }, languageId: 'r', automatic: false, filePath: 'R/analysis.R',
        definitions: async (s) => (s.partial === 'wh_' ? [{ path: 'R/warehouse.R', text: warehouse, line: 2 }] : []),
      });
      // qwen3.5:2b takes the arguments but invents the name; starcoder2:15b gets both.
      expect(out).toMatch(/as_of|pull_ord_snapshot/);
    }, 60_000);
  });
});
