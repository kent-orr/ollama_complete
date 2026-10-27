import * as http from 'node:http';

/** Minimal fake Ollama server: /api/tags, /api/generate (warm and FIM), /api/chat. */
export function startStubOllama(reply = '    return n'): Promise<{ url: string; close: () => Promise<void>; requests: string[]; prompts: string[] }> {
  const requests: string[] = [];
  const prompts: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen3.5:2b' }, { name: 'stub:latest' }] }));
        return;
      }
      if (req.url === '/api/generate' || req.url === '/api/chat') {
        const parsed = body ? JSON.parse(body) : {};
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (req.url === '/api/generate' && parsed.prompt === undefined) {
          res.end(JSON.stringify({ done: true }) + '\n');
          return;
        }
        if (req.url === '/api/generate') {
          prompts.push(parsed.prompt);
          res.write(JSON.stringify({ response: reply, done: false }) + '\n');
        } else {
          res.write(JSON.stringify({ message: { role: 'assistant', content: reply }, done: false }) + '\n');
        }
        res.end(JSON.stringify({ done: true }) + '\n');
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        prompts,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
