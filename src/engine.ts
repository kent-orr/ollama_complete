/** Editor-agnostic completion pipeline: bail-outs, debounce, cache, cancellation. No vscode imports. */
import { buildContext, type CompletionContext, type Position } from './context';
import { buildFimPrompt, buildChatMessages, fimFamilyForModel, FIM_FAMILIES, type FimPrompt, type ChatMessage } from './prompt';
import { postprocess } from './postprocess';
import { selectSnippets, type Neighbor } from './snippets';
import { cursorSymbols, selectDefinitions, withTimeout, type CursorSymbols, type DefinitionSite } from './definitions';
import type { GenerateRequest, ChatRequest, GenerateOptions } from './ollama';

export interface EngineConfig {
  enabled: boolean;
  host: string;
  model: string;
  mode: 'fim' | 'chat';
  thinking: boolean;
  instructions: string;
  contextLinesAbove: number;
  contextLinesBelow: number;
  maxLines: number;
  maxTokens: number;
  temperature: number;
  debounceMs: number;
  triggerMode: 'automatic' | 'manual';
  keepAlive: string;
  disabledLanguages: string[];
  /** One line when the cursor line has code, up to `maxLines` on a blank line. */
  adaptiveLines: boolean;
  /** Characters of related code from other open files to add to FIM prompts. 0 disables. */
  crossFileContextChars: number;
  /** Characters of definitions for symbols near the cursor to add to FIM prompts. 0 disables. */
  definitionContextChars: number;
}

export interface EngineClient {
  generate(req: GenerateRequest): Promise<string>;
  chat(req: ChatRequest): Promise<string>;
}

export interface CompleteRequest {
  text: string;
  position: Position;
  languageId: string;
  /** True when the editor asked on its own (typing); false for an explicit trigger command. */
  automatic: boolean;
  signal?: AbortSignal;
  /** Workspace-relative path of the document. */
  filePath?: string;
  /** Other open documents. Called only once the debounce has passed. */
  neighbors?: () => Neighbor[];
  /** Resolves symbols near the cursor (positions relative to `text`). Called only once the debounce has passed. */
  definitions?: (symbols: CursorSymbols) => Promise<DefinitionSite[]>;
}

/** Resolves true after `ms`, or false early if `signal` aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<boolean>;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const t = setTimeout(() => resolve(true), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve(false);
    }, { once: true });
  });

export interface EngineDeps {
  client: () => EngineClient;
  config: () => EngineConfig;
  sleep?: Sleep;
}

const CACHE_LIMIT = 100;
const WORD_CHAR_RE = /^[\p{L}\p{N}_$]/u;
const LEADING_BLANK_LINES_RE = /^(?:[ \t]*\n)+/;
/** Lines just above the cursor used to find related code in other files. */
const SNIPPET_QUERY_LINES = 20;
/** Lines up to the cursor scanned for symbols to look up, and how many to resolve at most. */
const DEFINITION_LINES = 5;
const DEFINITION_MAX_REFS = 6;
/** A slow language server gets this long before the completion goes ahead without it. */
const DEFINITION_TIMEOUT_MS = 250;

type Prepared = { mode: 'fim'; fim: FimPrompt } | { mode: 'chat'; messages: ChatMessage[] };

export class CompletionEngine {
  private readonly cache = new Map<string, string>();
  private inflight: AbortController | undefined;
  private readonly sleep: Sleep;

  constructor(private readonly deps: EngineDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async complete(req: CompleteRequest): Promise<string | undefined> {
    const cfg = this.deps.config();
    if (!cfg.enabled) return undefined;
    if (cfg.disabledLanguages.includes(req.languageId)) return undefined;
    if (cfg.triggerMode === 'manual' && req.automatic) return undefined;

    const ctx = buildContext(req.text, req.position, {
      linesAbove: cfg.contextLinesAbove,
      linesBelow: cfg.contextLinesBelow,
    });
    if (WORD_CHAR_RE.test(ctx.currentLineSuffix)) return undefined;

    if (req.automatic && cfg.debounceMs > 0) {
      const proceed = await this.sleep(cfg.debounceMs, req.signal);
      if (!proceed) return undefined;
    }
    if (req.signal?.aborted) return undefined;

    const lineHasCode = /\S/.test(ctx.linePrefix + ctx.currentLineSuffix);
    const maxLines = cfg.adaptiveLines && lineHasCode ? 1 : cfg.maxLines;
    const prepared = await this.prepare(cfg, ctx, req);
    if (req.signal?.aborted) return undefined;

    const cacheKey = [cfg.model, maxLines, JSON.stringify(prepared)].join('\u0000');
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;
    req.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    // Leading blank lines are re-based onto the cursor line later, so they do not count.
    const onToken = (acc: string): boolean => {
      const newlines = acc.replace(LEADING_BLANK_LINES_RE, '').split('\n').length - 1;
      return newlines < maxLines;
    };

    let raw: string;
    try {
      raw = await this.request(cfg, prepared, controller.signal, onToken);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return undefined;
      throw err;
    } finally {
      if (this.inflight === controller) this.inflight = undefined;
    }
    if (controller.signal.aborted) return undefined;

    const out = postprocess(raw, {
      maxLines,
      suffix: ctx.suffix,
      currentLineSuffix: ctx.currentLineSuffix,
      linePrefix: ctx.linePrefix,
    });
    if (!out) return undefined;

    this.cache.set(cacheKey, out);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return out;
  }

  private async prepare(cfg: EngineConfig, ctx: CompletionContext, req: CompleteRequest): Promise<Prepared> {
    if (cfg.mode === 'chat') return { mode: 'chat', messages: buildChatMessages(ctx, cfg.instructions) };
    const snippets =
      cfg.crossFileContextChars > 0 && req.neighbors
        ? selectSnippets(req.neighbors(), ctx.prefix.split('\n').slice(-SNIPPET_QUERY_LINES).join('\n'), {
            maxChars: cfg.crossFileContextChars,
          })
        : [];
    const sites = await this.lookupDefinitions(cfg, req);
    // Most relevant definition last, so it sits right above the current file.
    const definitions = selectDefinitions(sites, { maxChars: cfg.definitionContextChars, existing: snippets }).reverse();
    // A prompt ending in a space tokenizes badly ("x <- " gave "'fetch()"); let the model supply it.
    const lineHasCode = /\S/.test(ctx.linePrefix);
    const promptCtx = lineHasCode ? { ...ctx, prefix: ctx.prefix.replace(/[ \t]+$/, '') } : ctx;
    const fim = buildFimPrompt(promptCtx, cfg.model, { filePath: req.filePath, snippets: [...snippets, ...definitions] });
    if (!fim) {
      throw new Error(
        `Pawplete: model "${cfg.model}" has no known fill-in-the-middle tokens. Set pawplete.mode to "chat" or pick a Qwen/CodeLlama/DeepSeek/StarCoder/CodeGemma model.`,
      );
    }
    return { mode: 'fim', fim };
  }

  private async lookupDefinitions(cfg: EngineConfig, req: CompleteRequest): Promise<DefinitionSite[]> {
    if (cfg.definitionContextChars <= 0 || !req.definitions) return [];
    // Only families with a file separator can show code from other files.
    const family = fimFamilyForModel(cfg.model);
    if (!family || !FIM_FAMILIES[family].fileSep) return [];
    const symbols = cursorSymbols(req.text, req.position, { maxRefs: DEFINITION_MAX_REFS, lines: DEFINITION_LINES });
    if (!symbols.refs.length && !symbols.partial) return [];
    return withTimeout(req.definitions(symbols), DEFINITION_TIMEOUT_MS, []);
  }

  private request(
    cfg: EngineConfig,
    prepared: Prepared,
    signal: AbortSignal,
    onToken: (acc: string) => boolean,
  ): Promise<string> {
    const client = this.deps.client();
    // Model cards often ship a presence penalty (qwen3.5: 1.5) that punishes the repetition code needs.
    const options: GenerateOptions = { temperature: cfg.temperature, num_predict: cfg.maxTokens, presence_penalty: 0 };
    if (prepared.mode === 'chat') {
      return client.chat({
        model: cfg.model,
        messages: prepared.messages,
        think: cfg.thinking,
        keepAlive: cfg.keepAlive,
        options,
        signal,
        onToken,
      });
    }
    return client.generate({
      model: cfg.model,
      prompt: prepared.fim.prompt,
      keepAlive: cfg.keepAlive,
      options: { ...options, stop: prepared.fim.stop },
      signal,
      onToken,
    });
  }
}
