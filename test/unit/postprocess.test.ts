import { describe, it, expect } from 'vitest';
import { postprocess } from '../../src/postprocess';

const base = { maxLines: 5, suffix: '', currentLineSuffix: '' };

describe('postprocess', () => {
  it('returns clean text unchanged apart from trailing whitespace', () => {
    expect(postprocess('    return x\n', base)).toBe('    return x');
  });

  it('keeps leading whitespace (indentation matters)', () => {
    expect(postprocess('    return x', base)).toBe('    return x');
  });

  it('returns an empty string for whitespace-only output', () => {
    expect(postprocess('   \n\n', base)).toBe('');
  });

  it('strips a surrounding markdown fence with a language tag', () => {
    expect(postprocess('```python\nreturn x\n```\n', base)).toBe('return x');
  });

  it('strips a surrounding markdown fence without a language tag', () => {
    expect(postprocess('```\nreturn x\n```', base)).toBe('return x');
  });

  it('strips a leaked think block', () => {
    expect(postprocess('<think>\nhmm\n</think>\nreturn x', base)).toBe('return x');
  });

  it('strips stray FIM and special tokens', () => {
    expect(postprocess('return x<|endoftext|>', base)).toBe('return x');
    expect(postprocess('return x<|fim_pad|>\n<|file_sep|>', base)).toBe('return x');
    expect(postprocess('return x<|im_end|>', base)).toBe('return x');
  });

  it('truncates to maxLines', () => {
    const out = postprocess('a\nb\nc\nd', { ...base, maxLines: 2 });
    expect(out).toBe('a\nb');
  });

  it('drops a leading repeat of the text after the cursor on the same line', () => {
    const out = postprocess(')\n    return x', { ...base, currentLineSuffix: ')' });
    expect(out).toBe('\n    return x');
  });

  it('drops a trailing repeat of the start of the suffix', () => {
    const out = postprocess('    return x\n\nprint(f(1))', { ...base, suffix: '\n\nprint(f(1))\n' });
    expect(out).toBe('    return x');
  });

  it('does not drop a trailing line that merely resembles the suffix partially', () => {
    const out = postprocess('    return x\n    y = 2', { ...base, suffix: '\n    y = 3\n' });
    expect(out).toBe('    return x\n    y = 2');
  });

  it('normalizes CRLF in model output', () => {
    expect(postprocess('a\r\nb', base)).toBe('a\nb');
  });
});

describe('postprocess on a blank, indented cursor line', () => {
  const blank = { ...base, linePrefix: '    ' };

  it('drops a leading newline and re-bases the first line on the existing indent', () => {
    expect(postprocess('\n    result = 1\n    return result', blank)).toBe('result = 1\n    return result');
  });

  it('trims the first line when its indent does not extend the cursor indent', () => {
    expect(postprocess('\n\n  x = 1', blank)).toBe('x = 1');
  });

  it('shifts the whole block when the model over-indents the first line', () => {
    expect(postprocess('\n        df = 1\n        return df', blank)).toBe('df = 1\n    return df');
  });

  it('shifts the whole block when the model under-indents the first line', () => {
    expect(postprocess('\n  if x:\n      y()', blank)).toBe('if x:\n        y()');
  });

  it('keeps the model indentation on an empty line at column 0', () => {
    expect(postprocess('\n    return x', { ...base, linePrefix: '' })).toBe('    return x');
  });

  it('leaves a completion without a leading newline untouched', () => {
    expect(postprocess('    return x', blank)).toBe('    return x');
  });

  it('stops when a line dedents below the cursor indentation', () => {
    const out = postprocess('\n    a = 1\n    return a\n\ndef other():\n    pass', blank);
    expect(out).toBe('a = 1\n    return a');
  });

  it('applies no indentation scope at column 0', () => {
    expect(postprocess('a = 1\ndef g():\n    pass', { ...base, linePrefix: '' })).toBe('a = 1\ndef g():\n    pass');
  });
});

describe('postprocess on a line that already has code', () => {
  const one = { ...base, maxLines: 1 };

  it('joins a newline-led continuation after an assignment operator', () => {
    expect(postprocess("\nfetch_table(con, 'orders')", { ...one, linePrefix: 'orders <- ' })).toBe("fetch_table(con, 'orders')");
  });

  it('inserts a space when joining after an operator with no trailing space', () => {
    expect(postprocess('\n5', { ...one, linePrefix: 'x =' })).toBe(' 5');
  });

  it('joins directly after an opening bracket', () => {
    expect(postprocess('\na, b)', { ...one, linePrefix: 'foo(' })).toBe('a, b)');
  });

  it('joins after a pipe', () => {
    expect(postprocess('\n  summarise(n = n())', { ...one, linePrefix: '  group_by(region) |> ' })).toBe('summarise(n = n())');
  });

  it('drops leading spaces when the user already typed a space', () => {
    expect(postprocess(' n = n())', { ...one, linePrefix: 'summarise(total = sum(x), ' })).toBe('n = n())');
  });

  it('returns nothing for a newline-led completion after a finished statement', () => {
    expect(postprocess('\ny = 6', { ...one, linePrefix: 'x = 5' })).toBe('');
    expect(postprocess('\n    return 1', { ...one, linePrefix: 'def f():' })).toBe('');
  });

  it('measures the indentation scope from the code line', () => {
    const out = postprocess('\n        y()\nz()', { ...base, linePrefix: '    if x:' });
    expect(out).toBe('\n        y()');
  });
});

describe('postprocess against the code below the cursor', () => {
  it('stops before a line that repeats the next line of the suffix', () => {
    const out = postprocess('\n  for (const x of xs) sum += x;\n  return sum;\n}\n\nfunction other() {', {
      ...base,
      linePrefix: '  ',
      suffix: '\n  return sum;\n}\n',
    });
    expect(out).toBe('for (const x of xs) sum += x;');
  });

  it('does not cut at a short structural line such as a closing brace', () => {
    const out = postprocess('\n  if (a) {\n    b();\n  }', { ...base, linePrefix: '  ', suffix: '\n}\n' });
    expect(out).toBe('if (a) {\n    b();\n  }');
  });

  it('returns nothing when the first line duplicates the next line', () => {
    const out = postprocess('\n    return total', { ...base, linePrefix: '    ', suffix: '\n    return total\n' });
    expect(out).toBe('');
  });
});
