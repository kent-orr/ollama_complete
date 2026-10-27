import { describe, it, expect, vi } from 'vitest';
import { CompletionEngine, type EngineConfig, type EngineClient } from '../../src/engine';
import type { GenerateRequest, ChatRequest } from '../../src/ollama';

const baseConfig: EngineConfig = {
  enabled: true,
  host: 'http://localhost:11434',
  model: 'qwen3.5:2b',
  mode: 'fim',
  thinking: false,
  instructions: '',
  contextLinesAbove: 100,
  contextLinesBelow: 30,
  maxLines: 5,
  maxTokens: 128,
  temperature: 0.2,
  debounceMs: 300,
  triggerMode: 'automatic',
  keepAlive: '30m',
  disabledLanguages: ['plaintext', 'markdown'],
  adaptiveLines: true,
  crossFileContextChars: 2000,
  definitionContextChars: 1500,
};

const text = 'def f(x):\n    \n\nprint(f(1))\n';
const req = { text, position: { line: 1, character: 4 }, languageId: 'python', automatic: true };

function fakeClient(reply = '    return x\n') {
  const generate = vi.fn(async (r: GenerateRequest) => {
    r.onToken?.(reply);
    return reply;
  });
  const chat = vi.fn(async (r: ChatRequest) => {
    r.onToken?.(reply);
    return reply;
  });
  const client: EngineClient = { generate, chat };
  return { client, generate, chat };
}

const makeSleep = (result: boolean) => vi.fn(async (_ms: number, _signal?: AbortSignal) => result);

function makeEngine(config: Partial<EngineConfig> = {}, client = fakeClient().client, sleep = makeSleep(true)) {
  const cfg = { ...baseConfig, ...config };
  const engine = new CompletionEngine({ client: () => client, config: () => cfg, sleep });
  return { engine, sleep };
}

describe('CompletionEngine bail-outs', () => {
  it('returns undefined when disabled', async () => {
    const f = fakeClient();
    const { engine } = makeEngine({ enabled: false }, f.client);
    expect(await engine.complete(req)).toBeUndefined();
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('returns undefined for a disabled language', async () => {
    const f = fakeClient();
    const { engine } = makeEngine({}, f.client);
    expect(await engine.complete({ ...req, languageId: 'markdown' })).toBeUndefined();
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('ignores automatic triggers in manual mode but honours explicit ones', async () => {
    const f = fakeClient();
    const { engine } = makeEngine({ triggerMode: 'manual' }, f.client);
    expect(await engine.complete(req)).toBeUndefined();
    expect(f.generate).not.toHaveBeenCalled();
    expect(await engine.complete({ ...req, automatic: false })).toBe('    return x');
  });

  it('does not complete in the middle of a word', async () => {
    const f = fakeClient();
    const { engine } = makeEngine({}, f.client);
    const mid = { ...req, text: 'foo bar\n', position: { line: 0, character: 1 } };
    expect(await engine.complete(mid)).toBeUndefined();
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('completes when the cursor is before punctuation', async () => {
    const f = fakeClient('x');
    const { engine } = makeEngine({}, f.client);
    const before = { ...req, text: 'f()\n', position: { line: 0, character: 2 } };
    expect(await engine.complete(before)).toBe('x');
  });
});

describe('CompletionEngine debounce', () => {
  it('waits debounceMs before requesting', async () => {
    const f = fakeClient();
    const { engine, sleep } = makeEngine({ debounceMs: 123 }, f.client);
    await engine.complete(req);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBe(123);
  });

  it('skips the debounce on explicit triggers', async () => {
    const f = fakeClient();
    const { engine, sleep } = makeEngine({ debounceMs: 123 }, f.client);
    await engine.complete({ ...req, automatic: false });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('returns undefined without a request when cancelled during the debounce', async () => {
    const f = fakeClient();
    const { engine } = makeEngine({}, f.client, makeSleep(false));
    expect(await engine.complete(req)).toBeUndefined();
    expect(f.generate).not.toHaveBeenCalled();
  });
});

describe('CompletionEngine fim mode', () => {
  it('sends a FIM prompt with the configured options and returns postprocessed text', async () => {
    const f = fakeClient('    return x\n\nprint(f(1))\n');
    const { engine } = makeEngine({ maxTokens: 42, temperature: 0.7 }, f.client);
    const out = await engine.complete(req);
    expect(out).toBe('    return x');
    const sent = f.generate.mock.calls[0][0];
    expect(sent.model).toBe('qwen3.5:2b');
    expect(sent.prompt).toBe('<|fim_prefix|>def f(x):\n    <|fim_suffix|>\n\nprint(f(1))\n<|fim_middle|>');
    expect(sent.keepAlive).toBe('30m');
    expect(sent.options).toMatchObject({ num_predict: 42, temperature: 0.7, presence_penalty: 0 });
    expect(sent.options.stop).toContain('<|endoftext|>');
  });

  it('adds the file path and related snippets from neighbouring files', async () => {
    const f = fakeClient();
    const { engine } = makeEngine({}, f.client);
    await engine.complete({
      ...req,
      filePath: 'pkg/f.py',
      neighbors: () => [{ path: 'pkg/g.py', text: 'def g(x):\n    return f(x) + 1\n' }],
    });
    const prompt = f.generate.mock.calls[0][0].prompt;
    expect(prompt.startsWith('<|file_sep|>pkg/g.py\ndef g(x):')).toBe(true);
    expect(prompt).toContain('<|file_sep|>pkg/f.py\n<|fim_prefix|>def f(x):');
  });

  it('skips neighbouring files when crossFileContextChars is 0', async () => {
    const f = fakeClient();
    const neighbors = vi.fn(() => [{ path: 'pkg/g.py', text: 'def g(x):\n    return f(x)\n' }]);
    const { engine } = makeEngine({ crossFileContextChars: 0 }, f.client);
    await engine.complete({ ...req, filePath: 'pkg/f.py', neighbors });
    expect(neighbors).not.toHaveBeenCalled();
    expect(f.generate.mock.calls[0][0].prompt).not.toContain('pkg/g.py');
  });

  it('does not gather neighbouring files when the debounce is cancelled', async () => {
    const f = fakeClient();
    const neighbors = vi.fn(() => []);
    const { engine } = makeEngine({}, f.client, makeSleep(false));
    await engine.complete({ ...req, neighbors });
    expect(neighbors).not.toHaveBeenCalled();
  });

  it('stops streaming once maxLines is exceeded', async () => {
    const { client, generate } = fakeClient();
    generate.mockImplementation(async (r: GenerateRequest) => {
      // Stop as soon as maxLines complete lines have arrived.
      expect(r.onToken?.('a\n')).toBe(true);
      expect(r.onToken?.('a\nb')).toBe(true);
      expect(r.onToken?.('a\nb\n')).toBe(false);
      return 'a\nb\nc\n';
    });
    const { engine } = makeEngine({ maxLines: 2 }, client);
    expect(await engine.complete({ ...req, position: { line: 2, character: 0 } })).toBe('a\nb');
  });

  it('throws a descriptive error for a model with unknown FIM tokens', async () => {
    const f = fakeClient();
    const { engine } = makeEngine({ model: 'gemma4:31b' }, f.client);
    await expect(engine.complete(req)).rejects.toThrow(/gemma4:31b.*chat/);
    expect(f.generate).not.toHaveBeenCalled();
  });
});

describe('CompletionEngine definitions', () => {
  const rText = 'con <- connect_wh()\norders <- fetch_table(con, \n';
  const rReq = { ...req, text: rText, position: { line: 1, character: 27 }, languageId: 'r', filePath: 'R/analysis.R' };
  const dbSite = {
    path: 'R/db.R',
    text: "x <- 1\n#' Fetch a table\nfetch_table <- function(con, table_name, as_of) {\n  query(con, table_name)\n}\n",
    line: 2,
  };

  it('looks up the symbols at the cursor and puts their definitions just before the current file', async () => {
    const f = fakeClient('"orders")');
    const definitions = vi.fn(async () => [dbSite]);
    const { engine } = makeEngine({}, f.client);
    await engine.complete({
      ...rReq,
      neighbors: () => [{ path: 'R/plot.R', text: 'plot_orders <- function(orders) plot(orders)\n' }],
      definitions,
    });
    const lookup = (definitions.mock.calls[0] as unknown[])[0] as { refs: { name: string }[] };
    expect(lookup.refs[0]).toEqual({ name: 'fetch_table', line: 1, character: 10 });
    const prompt = f.generate.mock.calls[0][0].prompt;
    const def = "<|file_sep|>R/db.R\n#' Fetch a table\nfetch_table <- function(con, table_name, as_of) {\n  query(con, table_name)\n}\n";
    expect(prompt).toContain(def + '<|file_sep|>R/analysis.R\n<|fim_prefix|>');
    expect(prompt.indexOf('R/plot.R')).toBeLessThan(prompt.indexOf('R/db.R'));
    expect(prompt).not.toContain('x <- 1');
  });

  it('passes a partial word at the cursor for a workspace symbol search', async () => {
    const f = fakeClient();
    const definitions = vi.fn(async () => []);
    const { engine } = makeEngine({}, f.client);
    await engine.complete({ ...rReq, text: 'orders <- fetch_', position: { line: 0, character: 16 }, definitions });
    expect((definitions.mock.calls[0] as unknown[])[0]).toMatchObject({ partial: 'fetch_' });
  });

  it('still completes when the lookup fails', async () => {
    const f = fakeClient('"orders")');
    const { engine } = makeEngine({}, f.client);
    const out = await engine.complete({ ...rReq, definitions: async () => Promise.reject(new Error('no server')) });
    expect(out).toBe('"orders")');
  });

  it('skips the lookup when disabled, in chat mode, or for models without file separators', async () => {
    for (const cfg of [{ definitionContextChars: 0 }, { mode: 'chat' as const }, { model: 'codellama:7b-code' }]) {
      const definitions = vi.fn(async () => [dbSite]);
      const { engine } = makeEngine(cfg, fakeClient().client);
      await engine.complete({ ...rReq, definitions });
      expect(definitions, JSON.stringify(cfg)).not.toHaveBeenCalled();
    }
  });

  it('does not look anything up when the debounce is cancelled', async () => {
    const definitions = vi.fn(async () => [dbSite]);
    const { engine } = makeEngine({}, fakeClient().client, makeSleep(false));
    await engine.complete({ ...rReq, definitions });
    expect(definitions).not.toHaveBeenCalled();
  });
});

describe('CompletionEngine adaptive line limit', () => {
  const codeLine = { ...req, text: 'x = compute(\n', position: { line: 0, character: 12 } };

  it('limits a completion to one line when the cursor line has code', async () => {
    const { client, generate } = fakeClient();
    generate.mockImplementation(async (r: GenerateRequest) => {
      expect(r.onToken?.('a, b)')).toBe(true);
      expect(r.onToken?.('a, b)\n')).toBe(false);
      return 'a, b)\ny = 2\n';
    });
    const { engine } = makeEngine({}, client);
    expect(await engine.complete(codeLine)).toBe('a, b)');
  });

  it('allows up to maxLines on a blank line', async () => {
    const f = fakeClient('\n    a = 1\n    b = 2\n    return a + b\n');
    const { engine } = makeEngine({}, f.client);
    expect(await engine.complete(req)).toBe('a = 1\n    b = 2\n    return a + b');
  });

  it('does not count leading blank lines against the line limit', async () => {
    const { client, generate } = fakeClient();
    generate.mockImplementation(async (r: GenerateRequest) => {
      expect(r.onToken?.('\nsummary(df)')).toBe(true);
      expect(r.onToken?.('\nsummary(df)\n')).toBe(false);
      return '\nsummary(df)\n';
    });
    const { engine } = makeEngine({}, client);
    expect(await engine.complete({ ...req, text: 'out <- \n', position: { line: 0, character: 7 } })).toBe('summary(df)');
  });

  it('leaves trailing spaces on a code line out of the FIM prompt', async () => {
    const f = fakeClient('\nfetch()\n');
    const { engine } = makeEngine({}, f.client);
    expect(await engine.complete({ ...req, text: 'x <- \ny\n', position: { line: 0, character: 5 } })).toBe('fetch()');
    expect(f.generate.mock.calls[0][0].prompt).toBe('<|fim_prefix|>x <-<|fim_suffix|>\ny\n<|fim_middle|>');
  });

  it('keeps the indentation of a blank line in the FIM prompt', async () => {
    const f = fakeClient();
    const { engine } = makeEngine({}, f.client);
    await engine.complete(req);
    expect(f.generate.mock.calls[0][0].prompt).toContain('<|fim_prefix|>def f(x):\n    <|fim_suffix|>');
  });

  it('uses maxLines everywhere when adaptiveLines is off', async () => {
    const f = fakeClient('a, b)\ny = 2\n');
    const { engine } = makeEngine({ adaptiveLines: false }, f.client);
    expect(await engine.complete(codeLine)).toBe('a, b)\ny = 2');
  });

  it('caches single-line and multi-line results separately', async () => {
    const f = fakeClient('a\nb\n');
    const cfg = { ...baseConfig };
    const engine = new CompletionEngine({ client: () => f.client, config: () => cfg, sleep: makeSleep(true) });
    expect(await engine.complete(codeLine)).toBe('a');
    cfg.adaptiveLines = false;
    expect(await engine.complete(codeLine)).toBe('a\nb');
    expect(f.generate).toHaveBeenCalledTimes(2);
  });
});

describe('CompletionEngine chat mode', () => {
  it('sends instructions, cursor marker and think flag', async () => {
    const f = fakeClient('return x');
    const { engine } = makeEngine({ mode: 'chat', thinking: true, instructions: 'be terse' }, f.client);
    expect(await engine.complete(req)).toBe('return x');
    expect(f.generate).not.toHaveBeenCalled();
    const sent = f.chat.mock.calls[0][0];
    expect(sent.think).toBe(true);
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(sent.messages[1].content).toContain('<CURSOR>');
    expect(sent.options.stop).toBeUndefined();
    expect(sent.options.presence_penalty).toBe(0);
  });
});

describe('CompletionEngine caching and cancellation', () => {
  it('serves a repeated request from cache', async () => {
    const f = fakeClient();
    const { engine } = makeEngine({}, f.client);
    await engine.complete(req);
    await engine.complete(req);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('does not cache empty results', async () => {
    const f = fakeClient('   ');
    const { engine } = makeEngine({}, f.client);
    expect(await engine.complete(req)).toBeUndefined();
    await engine.complete(req);
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it('aborts the previous in-flight request when a new one starts', async () => {
    const { client, generate } = fakeClient();
    const signals: AbortSignal[] = [];
    generate.mockImplementation(async (r: GenerateRequest) => {
      signals.push(r.signal!);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(undefined), 50);
        r.signal!.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      return 'x';
    });
    const { engine } = makeEngine({}, client);
    const first = engine.complete(req);
    const second = engine.complete({ ...req, text: 'other\n', position: { line: 0, character: 5 } });
    expect(await first).toBeUndefined();
    expect(await second).toBe('x');
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('returns undefined when the caller aborts', async () => {
    const { client, generate } = fakeClient();
    generate.mockImplementation(async (r: GenerateRequest) => {
      await new Promise((_, reject) => r.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      return 'x';
    });
    const { engine } = makeEngine({}, client);
    const ac = new AbortController();
    const p = engine.complete({ ...req, signal: ac.signal });
    ac.abort();
    expect(await p).toBeUndefined();
  });
});
