/** Resolves symbols near the cursor through the editor's language servers. */
import * as vscode from 'vscode';
import type { CursorSymbols, DefinitionSite } from './definitions';

/** Files larger than this are not read for definitions. */
const MAX_FILE_CHARS = 200_000;
/** Workspace symbol matches kept for a partial word. */
const MAX_PARTIAL_MATCHES = 3;
const PARTIAL_KINDS = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Constant,
  vscode.SymbolKind.Variable,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
]);

export interface LookupOptions {
  /** Added to symbol lines, which are relative to the text the engine was given. */
  lineOffset: number;
  /** Lines of `document` already in the prompt; definitions there are skipped. */
  window: { start: number; end: number };
}

interface Target {
  uri: vscode.Uri;
  line: number;
  endLine?: number;
}

function toTarget(loc: vscode.Location | vscode.LocationLink): Target {
  if ('targetUri' in loc) {
    const r = loc.targetRange;
    return { uri: loc.targetUri, line: r.start.line, endLine: r.end.line };
  }
  return { uri: loc.uri, line: loc.range.start.line };
}

/** Only the user's own code: the model already knows the standard library and packages. */
function inWorkspace(uri: vscode.Uri): boolean {
  return !!vscode.workspace.getWorkspaceFolder(uri) && !uri.path.includes('/node_modules/');
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  // Prefer an open document so unsaved edits count; read closed files without opening them.
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function definitionTargets(document: vscode.TextDocument, symbols: CursorSymbols, lineOffset: number): Promise<Target[][]> {
  return Promise.all(
    symbols.refs.map(async (ref) => {
      const pos = new vscode.Position(ref.line + lineOffset, ref.character);
      const locs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>(
        'vscode.executeDefinitionProvider',
        document.uri,
        pos,
      );
      return (locs ?? []).map(toTarget);
    }),
  );
}

async function partialTargets(partial: string | undefined): Promise<Target[]> {
  if (!partial) return [];
  const found = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
    'vscode.executeWorkspaceSymbolProvider',
    partial,
  );
  return (found ?? [])
    .filter((s) => s.name.startsWith(partial) && PARTIAL_KINDS.has(s.kind))
    .sort((a, b) => a.name.length - b.name.length)
    .slice(0, MAX_PARTIAL_MATCHES)
    .map((s) => ({ uri: s.location.uri, line: s.location.range.start.line }));
}

/** Definition sites for `symbols`: partial-word matches first, then each ref in order. */
export async function lookupDefinitions(
  document: vscode.TextDocument,
  symbols: CursorSymbols,
  opts: LookupOptions,
): Promise<DefinitionSite[]> {
  const [partial, refs] = await Promise.all([
    partialTargets(symbols.partial),
    definitionTargets(document, symbols, opts.lineOffset),
  ]);
  const self = document.uri.toString();
  const seen = new Set<string>();
  const texts = new Map<string, string | undefined>();
  const sites: DefinitionSite[] = [];
  for (const t of [...partial, ...refs.flat()]) {
    const key = `${t.uri.toString()}#${t.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (t.uri.toString() === self && t.line >= opts.window.start && t.line <= opts.window.end) continue;
    if (t.uri.toString() !== self && !inWorkspace(t.uri)) continue;
    if (!texts.has(t.uri.toString())) texts.set(t.uri.toString(), await readText(t.uri));
    const text = texts.get(t.uri.toString());
    if (text === undefined || text.length > MAX_FILE_CHARS) continue;
    sites.push({ path: vscode.workspace.asRelativePath(t.uri), text, line: t.line, endLine: t.endLine });
  }
  return sites;
}
