/** Thin streaming client for the Ollama HTTP API. No vscode imports, no runtime deps. */
import type { ChatMessage } from './prompt';

export class OllamaError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'OllamaError';
  }
}

export interface GenerateOptions {
  temperature?: number;
  num_predict?: number;
  presence_penalty?: number;
  stop?: string[];
}

export interface GenerateRequest {
  model: string;
  prompt: string;
  keepAlive: string;
  options: GenerateOptions;
  signal?: AbortSignal;
  /** Called with the accumulated text after each chunk. Return false to stop early. */
  onToken?: (accumulated: string) => boolean | void;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  think: boolean;
  keepAlive: string;
  options: GenerateOptions;
  signal?: AbortSignal;
  onToken?: (accumulated: string) => boolean | void;
}

export interface OllamaClientOptions {
  host: string;
  fetchImpl?: typeof fetch;
}

type Chunk = {
  response?: string;
  message?: { content?: string; thinking?: string };
  done?: boolean;
  error?: string;
};

export class OllamaClient {
  readonly host: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaClientOptions) {
    this.host = opts.host.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async generate(req: GenerateRequest): Promise<string> {
    const body = {
      model: req.model,
      prompt: req.prompt,
      raw: true,
      stream: true,
      think: false,
      keep_alive: req.keepAlive,
      options: req.options,
    };
    const res = await this.post('/api/generate', body, req.signal);
    return this.consumeStream(res, (c) => c.response ?? '', req.onToken);
  }

  async chat(req: ChatRequest): Promise<string> {
    const body = {
      model: req.model,
      messages: req.messages,
      stream: true,
      think: req.think,
      keep_alive: req.keepAlive,
      options: req.options,
    };
    const res = await this.post('/api/chat', body, req.signal);
    return this.consumeStream(res, (c) => c.message?.content ?? '', req.onToken);
  }

  async listModels(): Promise<string[]> {
    const res = await this.request('/api/tags', { method: 'GET' });
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  }

  /** Load the model into memory without generating anything. */
  async warm(model: string, keepAlive: string): Promise<void> {
    const res = await this.post('/api/generate', { model, keep_alive: keepAlive });
    await res.text();
  }

  private post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host}${path}`, init);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new OllamaError(`Cannot reach Ollama at ${this.host} (${detail})`);
    }
    if (!res.ok) {
      const text = await res.text();
      let message = text || `${res.status} ${res.statusText}`;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // not JSON; keep raw text
      }
      throw new OllamaError(message, res.status);
    }
    return res;
  }

  private async consumeStream(
    res: Response,
    pick: (c: Chunk) => string,
    onToken?: (accumulated: string) => boolean | void,
  ): Promise<string> {
    if (!res.body) throw new OllamaError('Empty response body from Ollama');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let acc = '';

    const handleLine = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(trimmed) as Chunk;
      } catch {
        return true;
      }
      if (chunk.error) throw new OllamaError(chunk.error);
      const piece = pick(chunk);
      if (piece) {
        acc += piece;
        if (onToken && onToken(acc) === false) return false;
      }
      return !chunk.done;
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let nl: number;
        let keepGoing = true;
        while ((nl = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, nl);
          buffered = buffered.slice(nl + 1);
          if (!handleLine(line)) {
            keepGoing = false;
            break;
          }
        }
        if (!keepGoing) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
      if (buffered.trim()) handleLine(buffered);
    } finally {
      reader.releaseLock();
    }
    return acc;
  }
}
