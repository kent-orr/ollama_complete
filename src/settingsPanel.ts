/** Pure rendering and validation for the sidebar settings form. No vscode imports. */

export type FieldType = 'boolean' | 'integer' | 'number' | 'string' | 'enum' | 'multiline' | 'list' | 'model';

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  chatOnly?: boolean;
}

export interface Section {
  title: string;
  fields: Field[];
}

export const SECTIONS: Section[] = [
  {
    title: 'General',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'boolean' },
      { key: 'model', label: 'Model', type: 'model', hint: 'Models pulled on the Ollama host' },
      { key: 'mode', label: 'Mode', type: 'enum', options: ['fim', 'chat'], hint: 'fim: fast fill-in-the-middle. chat: uses instructions and thinking' },
      { key: 'host', label: 'Ollama host', type: 'string' },
    ],
  },
  {
    title: 'Generation',
    fields: [
      { key: 'maxLines', label: 'Max lines', type: 'integer', min: 1, hint: '1 forces single-line suggestions' },
      { key: 'adaptiveLines', label: 'One line when the line has code', type: 'boolean', hint: 'Max lines then applies on blank lines only' },
      { key: 'maxTokens', label: 'Max tokens', type: 'integer', min: 1 },
      { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.05 },
      { key: 'contextLinesAbove', label: 'Context lines above', type: 'integer', min: 0 },
      { key: 'contextLinesBelow', label: 'Context lines below', type: 'integer', min: 0 },
      { key: 'crossFileContextChars', label: 'Context from other open files (chars)', type: 'integer', min: 0, hint: 'fim mode. 0 disables' },
      { key: 'definitionContextChars', label: 'Definitions of nearby symbols (chars)', type: 'integer', min: 0, hint: 'fim mode. From the language server. 0 disables' },
    ],
  },
  {
    title: 'Behaviour',
    fields: [
      { key: 'triggerMode', label: 'Trigger', type: 'enum', options: ['automatic', 'manual'], hint: 'manual: only on Alt+\\' },
      { key: 'debounceMs', label: 'Debounce (ms)', type: 'integer', min: 0 },
      { key: 'keepAlive', label: 'Keep model loaded', type: 'string', hint: 'e.g. 30m, 1h, -1 for forever' },
      { key: 'disabledLanguages', label: 'Disabled languages', type: 'list', hint: 'Comma-separated language IDs' },
    ],
  },
  {
    title: 'Chat mode',
    fields: [
      { key: 'thinking', label: 'Thinking', type: 'boolean', chatOnly: true, hint: 'Slower. Reasoning is discarded, only code is shown' },
      { key: 'instructions', label: 'Instructions', type: 'multiline', chatOnly: true },
    ],
  },
];

export const FIELDS: Field[] = SECTIONS.flatMap((s) => s.fields);

/** Convert a raw value from the webview into a typed setting value, or undefined if invalid. */
export function coerceValue(field: Field, raw: unknown): unknown {
  switch (field.type) {
    case 'boolean':
      return raw === true || raw === 'true';
    case 'integer': {
      const n = Math.trunc(Number(raw));
      if (raw === '' || !Number.isFinite(n)) return undefined;
      return clamp(n, field);
    }
    case 'number': {
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n)) return undefined;
      return clamp(n, field);
    }
    case 'enum':
      return field.options?.includes(String(raw)) ? String(raw) : undefined;
    case 'list':
      return String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    case 'multiline':
      return String(raw);
    case 'string':
    case 'model':
      return String(raw).trim();
  }
}

function clamp(n: number, f: Field): number {
  if (f.min !== undefined && n < f.min) return f.min;
  if (f.max !== undefined && n > f.max) return f.max;
  return n;
}

export function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderOptions {
  values: Record<string, unknown>;
  models: string[];
  nonce: string;
  cspSource: string;
}

function displayValue(f: Field, v: unknown): string {
  if (f.type === 'list') return Array.isArray(v) ? v.join(', ') : String(v ?? '');
  return String(v ?? '');
}

function renderControl(f: Field, values: Record<string, unknown>, models: string[]): string {
  const v = values[f.key];
  const id = `f-${f.key}`;
  switch (f.type) {
    case 'boolean':
      return `<input id="${id}" type="checkbox" data-key="${f.key}"${v ? ' checked' : ''}>`;
    case 'integer':
    case 'number': {
      const attrs = [
        f.min !== undefined ? `min="${f.min}"` : '',
        f.max !== undefined ? `max="${f.max}"` : '',
        `step="${f.step ?? 1}"`,
      ].filter(Boolean).join(' ');
      return `<input id="${id}" type="number" data-key="${f.key}" ${attrs} value="${escapeHtml(v)}">`;
    }
    case 'enum':
      return `<select id="${id}" data-key="${f.key}">${(f.options ?? [])
        .map((o) => `<option value="${escapeHtml(o)}"${o === v ? ' selected' : ''}>${escapeHtml(o)}</option>`)
        .join('')}</select>`;
    case 'model': {
      const current = String(v ?? '');
      const list = models.includes(current) || !current ? models : [current, ...models];
      return `<div class="row"><select id="${id}" data-key="${f.key}">${list
        .map((m) => `<option value="${escapeHtml(m)}"${m === current ? ' selected' : ''}>${escapeHtml(m)}</option>`)
        .join('')}</select><button type="button" class="icon" title="Refresh model list" data-command="refreshModels">&#8635;</button></div>`;
    }
    case 'multiline':
      return `<textarea id="${id}" data-key="${f.key}" rows="8" spellcheck="false">${escapeHtml(v)}</textarea>`;
    case 'list':
    case 'string':
      return `<input id="${id}" type="text" data-key="${f.key}" value="${escapeHtml(displayValue(f, v))}">`;
  }
}

function renderField(f: Field, values: Record<string, unknown>, models: string[]): string {
  const cls = ['field', f.type === 'boolean' ? 'inline' : '', f.chatOnly ? 'chat-only' : ''].filter(Boolean).join(' ');
  const hint = f.hint ? `<div class="hint">${escapeHtml(f.hint)}</div>` : '';
  return `<div class="${cls}"><label for="f-${f.key}">${escapeHtml(f.label)}</label>${renderControl(f, values, models)}${hint}</div>`;
}

export function renderSettingsHtml(opts: RenderOptions): string {
  const { values, models, nonce, cspSource } = opts;
  const sections = SECTIONS.map(
    (s) => `<section><h3>${escapeHtml(s.title)}</h3>${s.fields.map((f) => renderField(f, values, models)).join('')}</section>`,
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pawplete</title>
<style nonce="${nonce}">
  body { padding: 0 12px 12px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  h3 { margin: 14px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
  .field { margin-bottom: 10px; }
  .field label { display: block; margin-bottom: 3px; }
  .field.inline { display: flex; align-items: center; gap: 8px; }
  .field.inline label { margin: 0; order: 2; }
  .hidden { display: none; }
  .hint { margin-top: 3px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .row { display: flex; gap: 4px; }
  .row select { flex: 1; }
  input[type=text], input[type=number], select, textarea {
    width: 100%; box-sizing: border-box; padding: 4px 6px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font-family: inherit; font-size: inherit;
  }
  select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border-color: var(--vscode-dropdown-border, transparent); }
  textarea { font-family: var(--vscode-editor-font-family); resize: vertical; }
  input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button { padding: 5px 10px; border: none; border-radius: 2px; cursor: pointer; font-family: inherit; font-size: inherit;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.icon { padding: 0 8px; }
  .actions { display: flex; gap: 6px; margin-top: 14px; flex-wrap: wrap; }
  .status { margin-top: 10px; font-size: 11px; color: var(--vscode-descriptionForeground); min-height: 1.2em; }
</style>
</head>
<body>
${sections}
<div class="actions">
  <button type="button" data-command="trigger" title="Alt+\\">Trigger completion</button>
  <button type="button" class="secondary" data-command="reset">Reset to defaults</button>
</div>
<div class="status" id="status"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (sel) => document.querySelectorAll(sel);
  const status = document.getElementById('status');

  function readControl(el) {
    return el.type === 'checkbox' ? el.checked : el.value;
  }
  function writeControl(el, v) {
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  }
  function applyMode() {
    const mode = document.querySelector('[data-key="mode"]').value;
    $('.chat-only').forEach((el) => el.classList.toggle('hidden', mode !== 'chat'));
  }

  $('[data-key]').forEach((el) => {
    el.addEventListener('change', () => {
      vscode.postMessage({ type: 'set', key: el.dataset.key, value: readControl(el) });
      if (el.dataset.key === 'mode') applyMode();
    });
  });
  $('[data-command]').forEach((b) => {
    b.addEventListener('click', () => vscode.postMessage({ type: 'command', command: b.dataset.command }));
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'values') {
      for (const [k, v] of Object.entries(m.values)) {
        const el = document.querySelector('[data-key="' + k + '"]');
        if (el && el !== document.activeElement) writeControl(el, v);
      }
      applyMode();
    } else if (m.type === 'models') {
      const sel = document.querySelector('[data-key="model"]');
      const current = m.current;
      const list = m.models.includes(current) || !current ? m.models : [current, ...m.models];
      sel.innerHTML = '';
      for (const name of list) {
        const o = document.createElement('option');
        o.value = name; o.textContent = name; o.selected = name === current;
        sel.appendChild(o);
      }
    } else if (m.type === 'status') {
      status.textContent = m.text || '';
    }
  });
  applyMode();
</script>
</body>
</html>`;
}
