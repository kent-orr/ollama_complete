import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FIELDS, coerceValue, renderSettingsHtml, type Field } from '../../src/settingsPanel';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifestKeys = Object.keys(pkg.contributes.configuration.properties).map((k) => k.replace(/^pawplete\./, ''));

const values: Record<string, unknown> = {
  enabled: true, host: 'http://localhost:11434', model: 'qwen3.5:2b', mode: 'fim', thinking: false,
  instructions: 'line one\n<b>two</b>', contextLinesAbove: 100, contextLinesBelow: 30, maxLines: 5,
  maxTokens: 128, temperature: 0.2, debounceMs: 300, triggerMode: 'automatic', keepAlive: '30m',
  disabledLanguages: ['plaintext', 'markdown'], adaptiveLines: true, crossFileContextChars: 2000, definitionContextChars: 1500,
};

const field = (key: string): Field => FIELDS.find((f) => f.key === key)!;

describe('FIELDS', () => {
  it('covers exactly the settings declared in package.json', () => {
    expect(FIELDS.map((f) => f.key).sort()).toEqual(manifestKeys.sort());
  });

  it('uses the manifest enum options', () => {
    expect(field('mode').options).toEqual(pkg.contributes.configuration.properties['pawplete.mode'].enum);
    expect(field('triggerMode').options).toEqual(pkg.contributes.configuration.properties['pawplete.triggerMode'].enum);
  });
});

describe('coerceValue', () => {
  it('coerces booleans', () => {
    expect(coerceValue(field('enabled'), true)).toBe(true);
    expect(coerceValue(field('enabled'), 'false')).toBe(false);
  });

  it('coerces integers and rejects garbage', () => {
    expect(coerceValue(field('maxLines'), '7')).toBe(7);
    expect(coerceValue(field('maxLines'), '7.9')).toBe(7);
    expect(coerceValue(field('maxLines'), 'abc')).toBeUndefined();
    expect(coerceValue(field('maxLines'), '0')).toBe(1); // clamped to minimum
  });

  it('coerces numbers', () => {
    expect(coerceValue(field('temperature'), '0.7')).toBe(0.7);
    expect(coerceValue(field('temperature'), '')).toBeUndefined();
  });

  it('validates enums', () => {
    expect(coerceValue(field('mode'), 'chat')).toBe('chat');
    expect(coerceValue(field('mode'), 'nope')).toBeUndefined();
  });

  it('splits lists on commas and drops blanks', () => {
    expect(coerceValue(field('disabledLanguages'), ' plaintext, markdown ,, ')).toEqual(['plaintext', 'markdown']);
    expect(coerceValue(field('disabledLanguages'), '')).toEqual([]);
  });

  it('passes strings through', () => {
    expect(coerceValue(field('host'), ' http://x:1 ')).toBe('http://x:1');
    expect(coerceValue(field('instructions'), 'a\nb')).toBe('a\nb');
  });
});

describe('renderSettingsHtml', () => {
  const html = renderSettingsHtml({ values, models: ['qwen3.5:2b', 'other:1b'], nonce: 'N0NCE', cspSource: 'vscode-resource:' });

  it('renders a control for every field', () => {
    for (const f of FIELDS) expect(html).toContain(`data-key="${f.key}"`);
  });

  it('uses the right control types', () => {
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*data-key="enabled"/);
    expect(html).toMatch(/<select[^>]*data-key="mode"/);
    expect(html).toMatch(/<textarea[^>]*data-key="instructions"/);
    expect(html).toMatch(/<input[^>]*type="number"[^>]*data-key="temperature"[^>]*step="0.05"/);
    expect(html).toMatch(/<select[^>]*data-key="model"/);
  });

  it('reflects current values and marks the selected options', () => {
    expect(html).toMatch(/data-key="enabled"[^>]*checked/);
    expect(html).toMatch(/<option value="fim" selected>/);
    expect(html).toMatch(/<option value="qwen3.5:2b" selected>/);
    expect(html).toMatch(/<option value="other:1b">/);
    expect(html).toContain('value="plaintext, markdown"');
  });

  it('adds the current model to the dropdown when it is not in the list', () => {
    const h = renderSettingsHtml({ values: { ...values, model: 'missing:1' }, models: ['a:1'], nonce: 'n', cspSource: 'x' });
    expect(h).toMatch(/<option value="missing:1" selected>/);
  });

  it('escapes HTML in values', () => {
    expect(html).not.toContain('<b>two</b>');
    expect(html).toContain('&lt;b&gt;two&lt;/b&gt;');
  });

  it('carries a nonce-locked CSP and a nonced script', () => {
    expect(html).toContain("script-src 'nonce-N0NCE'");
    expect(html).toContain('<script nonce="N0NCE">');
  });

  it('exposes the command buttons', () => {
    for (const c of ['trigger', 'refreshModels', 'reset']) expect(html).toContain(`data-command="${c}"`);
  });
});
