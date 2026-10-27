import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { startStubOllama } from './stubOllama';
import type { PawpleteApi } from '../../../src/extension';
import { lookupDefinitions } from '../../../src/definitionSource';

const EXT_ID = 'pawpaw-analytics.pawplete';
const SETTINGS_TO_RESET = ['host', 'debounceMs', 'enabled', 'mode', 'model'];

suite('Pawplete extension', () => {
  let stub: Awaited<ReturnType<typeof startStubOllama>>;
  let api: PawpleteApi;

  suiteSetup(async () => {
    stub = await startStubOllama();
    const cfg = vscode.workspace.getConfiguration('pawplete');
    await cfg.update('host', stub.url, vscode.ConfigurationTarget.Global);
    await cfg.update('debounceMs', 0, vscode.ConfigurationTarget.Global);
    const ext = vscode.extensions.getExtension<PawpleteApi>(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found`);
    api = await ext.activate();
  });

  suiteTeardown(async () => {
    const cfg = vscode.workspace.getConfiguration('pawplete');
    for (const k of SETTINGS_TO_RESET) await cfg.update(k, undefined, vscode.ConfigurationTarget.Global);
    await stub.close();
  });

  test('activates and exposes its API', () => {
    assert.ok(api.provider);
    assert.ok(api.engine);
  });

  test('registers all commands', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ['pawplete.trigger', 'pawplete.toggle', 'pawplete.selectModel', 'pawplete.acceptLine', 'pawplete.openSidebar']) {
      assert.ok(all.includes(c), `missing command ${c}`);
    }
  });

  test('ships the documented defaults', () => {
    const cfg = vscode.workspace.getConfiguration('pawplete');
    const def = (k: string) => cfg.inspect(k)?.defaultValue;
    assert.equal(def('enabled'), true);
    assert.equal(def('host'), 'http://localhost:11434');
    assert.equal(def('model'), 'qwen3.5:2b');
    assert.equal(def('mode'), 'fim');
    assert.equal(def('thinking'), false);
    assert.equal(def('contextLinesAbove'), 100);
    assert.equal(def('contextLinesBelow'), 30);
    assert.equal(def('maxLines'), 5);
    assert.equal(def('maxTokens'), 128);
    assert.equal(def('temperature'), 0.2);
    assert.equal(def('debounceMs'), 300);
    assert.equal(def('triggerMode'), 'automatic');
    assert.equal(def('keepAlive'), '30m');
    assert.deepEqual(def('disabledLanguages'), ['plaintext', 'markdown']);
    assert.equal(def('adaptiveLines'), true);
    assert.equal(def('crossFileContextChars'), 2000);
    assert.equal(def('definitionContextChars'), 1500);
    assert.ok(String(def('instructions')).includes('<CURSOR>'));
  });

  test('warms the model on activation', () => {
    assert.ok(stub.requests.includes('POST /api/generate'), `requests: ${stub.requests.join(', ')}`);
  });

  test('returns an inline completion for a python document', async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: 'python',
      content: 'def f(n):\n    \n\nprint(f(1))\n',
    });
    const items = await api.provider.provideInlineCompletionItems(
      doc,
      new vscode.Position(1, 4),
      { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined },
      new vscode.CancellationTokenSource().token,
    );
    assert.ok(items && items.length === 1, 'expected one item');
    assert.equal(items[0].insertText, '    return n');
  });

  test('sends the file path and related code from other open documents', async () => {
    await vscode.workspace.openTextDocument({ language: 'python', content: 'def helper_total(rows):\n    return sum(rows)\n' });
    const doc = await vscode.workspace.openTextDocument({
      language: 'python',
      content: 'rows = [1, 2]\nresult = helper_total(rows)\n    \n',
    });
    stub.prompts.length = 0;
    await api.provider.provideInlineCompletionItems(
      doc,
      new vscode.Position(2, 4),
      { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined },
      new vscode.CancellationTokenSource().token,
    );
    const prompt = stub.prompts[0] ?? '';
    assert.ok(prompt.includes('def helper_total(rows):'), `prompt lacks neighbour code: ${prompt}`);
    assert.ok(/<\|file_sep\|>Untitled-\d+\n<\|fim_prefix\|>/.test(prompt), `prompt lacks file path: ${prompt}`);
  });

  suite('definitions from the language server', () => {
    const fixture = (name: string) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, name);
    // Cursor sits after `formatPrice(cents, ` in fixtures/checkout.ts.
    const cursor = new vscode.Position(3, 35);
    const callee = { name: 'formatPrice', line: 3, character: 16 };
    const wholeFile = { lineOffset: 0, window: { start: 0, end: 0 } };
    let doc: vscode.TextDocument;

    suiteSetup(async function () {
      this.timeout(60_000);
      // The test host otherwise sends go-to-definition to the syntax-only server, which cannot see other files.
      await vscode.workspace.getConfiguration('typescript').update('tsserver.useSyntaxServer', 'never', vscode.ConfigurationTarget.Global);
      doc = await vscode.workspace.openTextDocument(fixture('checkout.ts'));
      // The TypeScript server takes a few seconds to load the project.
      const deadline = Date.now() + 50_000;
      while (Date.now() < deadline) {
        if ((await lookupDefinitions(doc, { refs: [callee] }, wholeFile)).length) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('TypeScript language server never resolved formatPrice');
    });

    suiteTeardown(async () => {
      await vscode.workspace.getConfiguration('typescript').update('tsserver.useSyntaxServer', undefined, vscode.ConfigurationTarget.Global);
    });

    test('resolves the call at the cursor to its declaration in a closed file', async () => {
      const sites = await lookupDefinitions(doc, { refs: [callee] }, wholeFile);
      const site = sites.find((s) => s.path === 'pricing.ts');
      assert.ok(site, `sites: ${JSON.stringify(sites.map((s) => s.path))}`);
      assert.match(site.text.split('\n')[site.line], /export function formatPrice/);
      assert.ok(!vscode.workspace.textDocuments.some((d) => d.fileName.endsWith('pricing.ts')), 'pricing.ts was opened');
    });

    test('finds a symbol from a partial word with a workspace search', async () => {
      const sites = await lookupDefinitions(doc, { refs: [], partial: 'formatPr' }, wholeFile);
      assert.ok(sites.some((s) => s.path === 'pricing.ts'), `sites: ${JSON.stringify(sites.map((s) => s.path))}`);
    });

    test('skips definitions inside the visible window of the current file', async () => {
      const receipt = { name: 'receiptLine', line: 2, character: 16 };
      const sites = await lookupDefinitions(doc, { refs: [receipt] }, { lineOffset: 0, window: { start: 0, end: 5 } });
      assert.deepEqual(sites, []);
    });

    test('puts the definition and its doc comment into the fim prompt', async () => {
      stub.prompts.length = 0;
      await api.provider.provideInlineCompletionItems(
        doc,
        cursor,
        { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined },
        new vscode.CancellationTokenSource().token,
      );
      const prompt = stub.prompts[0] ?? '';
      assert.ok(
        prompt.includes('<|file_sep|>pricing.ts\n/** Formats an amount in cents'),
        `prompt lacks the definition: ${prompt}`,
      );
      assert.ok(prompt.includes("currency: 'USD' | 'EUR' = 'USD'"), `prompt lacks the signature: ${prompt}`);
    });
  });

  test('returns nothing for a disabled language', async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'hello \n' });
    const items = await api.provider.provideInlineCompletionItems(
      doc,
      new vscode.Position(0, 6),
      { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined },
      new vscode.CancellationTokenSource().token,
    );
    assert.equal(items, undefined);
  });

  test('contributes a sidebar container with the settings view', () => {
    const ext = vscode.extensions.getExtension(EXT_ID)!;
    const contributes = ext.packageJSON.contributes;
    assert.equal(contributes.viewsContainers.activitybar[0].id, 'pawplete');
    assert.equal(contributes.views.pawplete[0].id, 'pawplete.settings');
    assert.equal(contributes.views.pawplete[0].type, 'webview');
  });

  test('opens the sidebar and resolves the settings webview', async () => {
    await vscode.commands.executeCommand('pawplete.openSidebar');
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(stub.requests.includes('GET /api/tags'), `sidebar did not fetch models: ${stub.requests.join(', ')}`);
  });

  test('toggle command flips the enabled setting', async () => {
    await vscode.commands.executeCommand('pawplete.toggle');
    assert.equal(vscode.workspace.getConfiguration('pawplete').get('enabled'), false);
    await vscode.commands.executeCommand('pawplete.toggle');
    assert.equal(vscode.workspace.getConfiguration('pawplete').get('enabled'), true);
  });
});
