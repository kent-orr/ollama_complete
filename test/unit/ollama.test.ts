import { describe, it, expect, vi } from 'vitest';
import { OllamaClient, OllamaError } from '../../src/ollama';

function ndjsonResponse(objs: object[], opts: { status?: number; delayMs?: number } = {}): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const o of objs) {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        controller.enqueue(enc.encode(JSON.stringify(o) + '\n'));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: opts.status ?? 200 });
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init ?? {}));
}

describe('OllamaClient.generate', () => {
  it('posts a raw generate request and concatenates streamed tokens', async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toBe('http://h:1/api/generate');
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        model: 'm',
        prompt: 'P',
        raw: true,
        stream: true,
        think: false,
        keep_alive: '30m',
        options: { temperature: 0.2, num_predict: 10, stop: ['X'] },
      });
      return ndjsonResponse([
        { response: 'foo', done: false },
        { response: ' bar', done: false },
        { response: '', done: true, eval_count: 2 },
      ]);
    });
    const c = new OllamaClient({ host: 'http://h:1/', fetchImpl });
    const out = await c.generate({
      model: 'm', prompt: 'P', keepAlive: '30m',
      options: { temperature: 0.2, num_predict: 10, stop: ['X'] },
    });
    expect(out).toBe('foo bar');
  });

  it('calls onToken with the accumulated text and stops early when it returns false', async () => {
    const fetchImpl = mockFetch(() => ndjsonResponse([
      { response: 'a\n', done: false },
      { response: 'b\n', done: false },
      { response: 'c\n', done: false },
      { response: '', done: true },
    ], { delayMs: 5 }));
    const c = new OllamaClient({ host: 'http://h:1', fetchImpl });
    const seen: string[] = [];
    const out = await c.generate({
      model: 'm', prompt: 'P', keepAlive: '1m', options: {},
      onToken: (acc) => { seen.push(acc); return !acc.includes('b'); },
    });
    expect(seen).toEqual(['a\n', 'a\nb\n']);
    expect(out).toBe('a\nb\n');
  });

  it('throws OllamaError with the server message on a non-2xx response', async () => {
    const fetchImpl = mockFetch(() => new Response(JSON.stringify({ error: 'model "m" not found' }), { status: 404 }));
    const c = new OllamaClient({ host: 'http://h:1', fetchImpl });
    await expect(c.generate({ model: 'm', prompt: 'P', keepAlive: '1m', options: {} }))
      .rejects.toThrow(OllamaError);
    await expect(c.generate({ model: 'm', prompt: 'P', keepAlive: '1m', options: {} }))
      .rejects.toThrow('model "m" not found');
  });

  it('surfaces an error object inside the stream', async () => {
    const fetchImpl = mockFetch(() => ndjsonResponse([{ error: 'boom' }]));
    const c = new OllamaClient({ host: 'http://h:1', fetchImpl });
    await expect(c.generate({ model: 'm', prompt: 'P', keepAlive: '1m', options: {} })).rejects.toThrow('boom');
  });

  it('rejects with an AbortError when the signal is aborted mid-stream', async () => {
    const fetchImpl = mockFetch((_u, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ response: 'a', done: false }) + '\n'));
          init.signal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(stream, { status: 200 });
    });
    const c = new OllamaClient({ host: 'http://h:1', fetchImpl });
    const ac = new AbortController();
    const p = c.generate({ model: 'm', prompt: 'P', keepAlive: '1m', options: {}, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('wraps a connection failure in OllamaError', async () => {
    const fetchImpl = mockFetch(() => { throw new TypeError('fetch failed'); });
    const c = new OllamaClient({ host: 'http://h:1', fetchImpl });
    await expect(c.generate({ model: 'm', prompt: 'P', keepAlive: '1m', options: {} }))
      .rejects.toThrow(/Cannot reach Ollama at http:\/\/h:1/);
  });
});

describe('OllamaClient.chat', () => {
  it('posts to /api/chat with think flag and concatenates message content, ignoring thinking', async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toBe('http://h:1/api/chat');
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ model: 'm', think: true, stream: true, messages: [{ role: 'system', content: 's' }] });
      return ndjsonResponse([
        { message: { role: 'assistant', content: '', thinking: 'let me think' }, done: false },
        { message: { role: 'assistant', content: 'x = ' }, done: false },
        { message: { role: 'assistant', content: '1' }, done: true },
      ]);
    });
    const c = new OllamaClient({ host: 'http://h:1', fetchImpl });
    const out = await c.chat({
      model: 'm', messages: [{ role: 'system', content: 's' }], think: true, keepAlive: '1m', options: {},
    });
    expect(out).toBe('x = 1');
  });
});

describe('OllamaClient.listModels', () => {
  it('returns model names from /api/tags', async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toBe('http://h:1/api/tags');
      return new Response(JSON.stringify({ models: [{ name: 'a:1' }, { name: 'b:2' }] }), { status: 200 });
    });
    const c = new OllamaClient({ host: 'http://h:1', fetchImpl });
    expect(await c.listModels()).toEqual(['a:1', 'b:2']);
  });
});

describe('OllamaClient.warm', () => {
  it('sends an empty generate request with keep_alive to load the model', async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toBe('http://h:1/api/generate');
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ model: 'm', keep_alive: '30m' });
      return new Response(JSON.stringify({ done: true }), { status: 200 });
    });
    const c = new OllamaClient({ host: 'http://h:1', fetchImpl });
    await expect(c.warm('m', '30m')).resolves.toBeUndefined();
  });
});
