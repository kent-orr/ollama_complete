import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_INSTRUCTIONS,
  CURSOR_MARKER,
  fimFamilyForModel,
  buildFimPrompt,
  buildChatMessages,
} from '../../src/prompt';

const ctx = { prefix: 'def f(x):\n    ', suffix: '\n\nprint(f(1))\n', currentLineSuffix: '', linePrefix: '    ' };

describe('fimFamilyForModel', () => {
  it('recognises qwen variants', () => {
    expect(fimFamilyForModel('qwen3.5:2b')).toBe('qwen');
    expect(fimFamilyForModel('qwen2.5-coder:7b')).toBe('qwen');
    expect(fimFamilyForModel('hf.co/someone/Qwen3-Coder-GGUF:Q4')).toBe('qwen');
  });

  it('recognises other known families', () => {
    expect(fimFamilyForModel('codellama:7b-code')).toBe('codellama');
    expect(fimFamilyForModel('deepseek-coder-v2:16b')).toBe('deepseek');
    expect(fimFamilyForModel('starcoder2:3b')).toBe('starcoder');
    expect(fimFamilyForModel('codegemma:2b')).toBe('codegemma');
  });

  it('returns undefined for unknown families', () => {
    expect(fimFamilyForModel('gemma4:31b')).toBeUndefined();
    expect(fimFamilyForModel('llama3.2')).toBeUndefined();
  });
});

describe('buildFimPrompt', () => {
  it('wraps prefix and suffix with qwen tokens', () => {
    const p = buildFimPrompt(ctx, 'qwen3.5:2b');
    expect(p).toBeDefined();
    expect(p!.prompt).toBe('<|fim_prefix|>def f(x):\n    <|fim_suffix|>\n\nprint(f(1))\n<|fim_middle|>');
    expect(p!.stop).toContain('<|endoftext|>');
    expect(p!.stop).toContain('<|fim_pad|>');
    expect(p!.stop).not.toContain('\n');
  });

  it('never stops on a newline, so a newline-led continuation can still be joined', () => {
    expect(buildFimPrompt(ctx, 'qwen3.5:2b')!.stop).not.toContain('\n');
  });

  it('prefixes the file path with the qwen file separator', () => {
    const p = buildFimPrompt(ctx, 'qwen3.5:2b', { filePath: 'src/f.py' });
    expect(p!.prompt).toBe('<|file_sep|>src/f.py\n<|fim_prefix|>def f(x):\n    <|fim_suffix|>\n\nprint(f(1))\n<|fim_middle|>');
  });

  it('adds snippets from other files as earlier files in the repo', () => {
    const p = buildFimPrompt(ctx, 'qwen3.5:2b', {
      filePath: 'src/f.py',
      snippets: [{ path: 'src/util.py', text: 'def g(y):\n    return y' }],
    });
    expect(p!.prompt).toBe(
      '<|file_sep|>src/util.py\ndef g(y):\n    return y\n' +
        '<|file_sep|>src/f.py\n<|fim_prefix|>def f(x):\n    <|fim_suffix|>\n\nprint(f(1))\n<|fim_middle|>',
    );
  });

  it('uses the starcoder file separator for starcoder', () => {
    const p = buildFimPrompt(ctx, 'starcoder2:7b', { filePath: 'a.py' });
    expect(p!.prompt.startsWith('<file_sep>a.py\n<fim_prefix>')).toBe(true);
  });

  it('ignores path and snippets for families without a file separator', () => {
    const p = buildFimPrompt(ctx, 'codellama:7b-code', { filePath: 'a.py', snippets: [{ path: 'b.py', text: 'x' }] });
    expect(p!.prompt).toBe('<PRE> def f(x):\n     <SUF>\n\nprint(f(1))\n <MID>');
  });

  it('uses codellama tokens for codellama', () => {
    const p = buildFimPrompt(ctx, 'codellama:7b-code');
    expect(p!.prompt).toBe('<PRE> def f(x):\n     <SUF>\n\nprint(f(1))\n <MID>');
  });

  it('returns undefined for an unknown family', () => {
    expect(buildFimPrompt(ctx, 'gemma4:31b')).toBeUndefined();
  });
});

describe('buildChatMessages', () => {
  it('produces a system message and a user message with the cursor marker', () => {
    const msgs = buildChatMessages(ctx, 'be terse');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toBe(`def f(x):\n    ${CURSOR_MARKER}\n\nprint(f(1))\n`);
  });

  it('falls back to the default instructions when none are given', () => {
    const msgs = buildChatMessages(ctx, '');
    expect(msgs[0].content).toBe(DEFAULT_INSTRUCTIONS);
  });
});

describe('DEFAULT_INSTRUCTIONS', () => {
  it('matches the manifest default so settings UI and code agree', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.contributes.configuration.properties['pawplete.instructions'].default).toBe(DEFAULT_INSTRUCTIONS);
  });

  it('mentions the cursor marker', () => {
    expect(DEFAULT_INSTRUCTIONS).toContain(CURSOR_MARKER);
  });
});
