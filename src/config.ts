import * as vscode from 'vscode';
import type { EngineConfig } from './engine';
import { DEFAULT_INSTRUCTIONS } from './prompt';

export const SECTION = 'pawplete';

export function readConfig(): EngineConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    enabled: c.get<boolean>('enabled', true),
    host: c.get<string>('host', 'http://localhost:11434'),
    model: c.get<string>('model', 'qwen3.5:2b'),
    mode: c.get<'fim' | 'chat'>('mode', 'fim'),
    thinking: c.get<boolean>('thinking', false),
    instructions: c.get<string>('instructions', DEFAULT_INSTRUCTIONS),
    contextLinesAbove: c.get<number>('contextLinesAbove', 100),
    contextLinesBelow: c.get<number>('contextLinesBelow', 30),
    maxLines: Math.max(1, c.get<number>('maxLines', 5)),
    maxTokens: Math.max(1, c.get<number>('maxTokens', 128)),
    temperature: c.get<number>('temperature', 0.2),
    debounceMs: Math.max(0, c.get<number>('debounceMs', 300)),
    triggerMode: c.get<'automatic' | 'manual'>('triggerMode', 'automatic'),
    keepAlive: c.get<string>('keepAlive', '30m'),
    disabledLanguages: c.get<string[]>('disabledLanguages', ['plaintext', 'markdown']),
    adaptiveLines: c.get<boolean>('adaptiveLines', true),
    crossFileContextChars: Math.max(0, c.get<number>('crossFileContextChars', 2000)),
    definitionContextChars: Math.max(0, c.get<number>('definitionContextChars', 1500)),
  };
}

export async function updateSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}
