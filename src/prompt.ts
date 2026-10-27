/** Prompt construction for FIM and chat modes. No vscode imports. */
import type { CompletionContext } from './context';
import type { Snippet } from './snippets';

export const CURSOR_MARKER = '<CURSOR>';

export const DEFAULT_INSTRUCTIONS = [
  'You are an inline code completion engine inside a code editor.',
  `You will receive a file excerpt containing the marker ${CURSOR_MARKER}.`,
  `Reply with ONLY the code that should be inserted at ${CURSOR_MARKER}.`,
  'Rules:',
  '- Do not repeat any code that already appears before or after the marker.',
  '- Do not add explanations, comments about your reasoning, or markdown fences.',
  '- Match the indentation, naming, and style of the surrounding code.',
  '- Stop as soon as the immediate statement, block, or expression is complete.',
].join('\n');

export interface FimTokens {
  prefix: string;
  suffix: string;
  middle: string;
  stop: string[];
  /** Repo-level file separator. Families that have one get the file path and cross-file snippets. */
  fileSep?: string;
}

/** FIM token sets keyed by model family. Only `qwen` has been verified against a live model. */
export const FIM_FAMILIES: Record<string, FimTokens> = {
  qwen: {
    prefix: '<|fim_prefix|>',
    suffix: '<|fim_suffix|>',
    middle: '<|fim_middle|>',
    stop: ['<|endoftext|>', '<|fim_pad|>', '<|repo_name|>', '<|file_sep|>', '<|im_end|>'],
    fileSep: '<|file_sep|>',
  },
  codellama: {
    prefix: '<PRE> ',
    suffix: ' <SUF>',
    middle: ' <MID>',
    stop: ['<EOT>', '<EOS>'],
  },
  deepseek: {
    prefix: '<｜fim▁begin｜>',
    suffix: '<｜fim▁hole｜>',
    middle: '<｜fim▁end｜>',
    stop: ['<｜end▁of▁sentence｜>'],
  },
  starcoder: {
    prefix: '<fim_prefix>',
    suffix: '<fim_suffix>',
    middle: '<fim_middle>',
    stop: ['<|endoftext|>', '<file_sep>'],
    fileSep: '<file_sep>',
  },
  codegemma: {
    prefix: '<|fim_prefix|>',
    suffix: '<|fim_suffix|>',
    middle: '<|fim_middle|>',
    stop: ['<|file_separator|>', '<eos>'],
  },
};

const FAMILY_ORDER: string[] = ['qwen', 'codellama', 'deepseek', 'starcoder', 'codegemma'];

export function fimFamilyForModel(model: string): string | undefined {
  const m = model.toLowerCase();
  return FAMILY_ORDER.find((f) => m.includes(f));
}

export interface FimPrompt {
  prompt: string;
  stop: string[];
}

export interface FimOptions {
  /** Workspace-relative path of the file being edited. */
  filePath?: string;
  /** Related code from other open files, placed before the current file. */
  snippets?: Snippet[];
}

export function buildFimPrompt(ctx: CompletionContext, model: string, opts: FimOptions = {}): FimPrompt | undefined {
  const family = fimFamilyForModel(model);
  if (!family) return undefined;
  const t = FIM_FAMILIES[family];
  let header = '';
  if (t.fileSep) {
    for (const s of opts.snippets ?? []) header += `${t.fileSep}${s.path}\n${s.text.replace(/\n*$/, '\n')}`;
    if (opts.filePath || header) header += `${t.fileSep}${opts.filePath || 'untitled'}\n`;
  }
  return {
    prompt: `${header}${t.prefix}${ctx.prefix}${t.suffix}${ctx.suffix}${t.middle}`,
    stop: [...t.stop],
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function buildChatMessages(ctx: CompletionContext, instructions: string): ChatMessage[] {
  const system = instructions.trim() ? instructions : DEFAULT_INSTRUCTIONS;
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${ctx.prefix}${CURSOR_MARKER}${ctx.suffix}` },
  ];
}
