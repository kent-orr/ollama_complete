# Pawplete: minimal inline code completion for VS Code via Ollama

- **Name:** Pawplete (`name: pawplete`, `displayName: Pawplete`)
- **Publisher:** Pawpaw Analytics, ltd. (`publisher: pawpaw-analytics`)
- **License:** MIT (`LICENSE` file in repo, `license: MIT` in manifest)
- **Distribution:** private `.vsix` only. No marketplace or Open VSX publishing.

## 1. Brief (original intent, kept verbatim in spirit)

A minimal auto-complete VS Code extension backed by a local LLM (Ollama).
The user can configure, at minimum:

- thinking on/off (default off)
- model choice
- context size (max lines above and below the cursor)
- custom instructions (with a good default prompt)
- keybindings (default: Tab accepts a suggestion)
- max lines to auto-generate

There are other extensions that do this, but this one is deliberately simple,
slimmed down, and specific to Ollama. Default model and test target: `qwen3.5:2b`.

## 2. Review of the brief

The brief is sound. Expanding it surfaced four things that change the design:

1. **Two prompt strategies are needed, not one.** Fill-in-the-middle (FIM) gives
   much better completions than chat prompting, but it has no place for
   "custom instructions" or "thinking". So the extension gets a `mode` setting:
   `fim` (default, fast, instruction-free) and `chat` (instructions + optional
   thinking). The brief's "thinking" and "custom instructions" settings only
   apply in `chat` mode, and the settings UI should say so.
2. **Tab-to-accept is free.** VS Code's `InlineCompletionItemProvider` renders
   ghost text and binds Tab to accept out of the box. We don't define a Tab
   keybinding; we only add commands for manual trigger and accept-next-line,
   which users can rebind in the normal Keybindings UI.
3. **Model load latency dominates first use.** Cold load of qwen3.5:2b measured
   ~8 s; after that, generation is ~330 tok/s and a typical completion returns
   in well under a second. The extension must warm the model on activation and
   keep it resident via `keep_alive`.
4. **Node is not installed on this machine**, and the editor is VSCodium
   (snap, 1.105), not VS Code. Both are handled in the prerequisites.

## 3. Verified environment (checked 2026-10-20)

| Item | Finding |
|---|---|
| Ollama | 0.31.2 running at `http://localhost:11434` |
| Model | `qwen3.5:2b`, Q8_0, 262k context, capabilities: completion, vision, tools, thinking |
| Raw FIM (`raw: true`, `<\|fim_prefix\|>…<\|fim_suffix\|>…<\|fim_middle\|>`) | Works. Clean, correctly indented function body, stopped on its own, no thinking emitted |
| Ollama `suffix` parameter | Rejected: "qwen3.5:2b does not support insert". We must build the FIM prompt ourselves |
| `/api/chat` with `think: false` | Works, no thinking returned, but weaker completion (wrong indentation, hallucinated name) |
| Editor | VSCodium 1.105.17075 at `/snap/bin/codium`; no `code` on PATH |
| Node / npm | Not installed |

Decision: default to `fim` mode using `/api/generate` with `raw: true`.
Use `/api/chat` for `chat` mode.

## 4. Non-goals

- No chat panel, no refactoring commands, no multi-file or repo indexing.
- No support for providers other than Ollama.
- No telemetry, no network calls other than to the configured Ollama host.
- No runtime npm dependencies. VS Code's Node (20+) has `fetch` and
  `AbortController` built in, so the Ollama client is a thin hand-written module.

## 5. Settings (contributes.configuration, prefix `pawplete`)

| Setting | Type / default | Notes |
|---|---|---|
| `enabled` | boolean, `true` | Global on/off. Also toggled from the status bar item |
| `host` | string, `http://localhost:11434` | Ollama base URL |
| `model` | string, `qwen3.5:2b` | Any model name from `ollama list` |
| `mode` | enum `fim` \| `chat`, `fim` | See §6 |
| `thinking` | boolean, `false` | Chat mode only. Sends `think: true/false` |
| `instructions` | string, default in §6.2 | Chat mode only. System prompt |
| `contextLinesAbove` | integer, `100` | Max lines of prefix sent |
| `contextLinesBelow` | integer, `30` | Max lines of suffix sent |
| `maxLines` | integer, `5` | Completion is truncated to this many lines. `1` adds `"\n"` as a stop sequence |
| `maxTokens` | integer, `128` | `num_predict`. Hard cap regardless of `maxLines` |
| `temperature` | number, `0.2` | Low by default; the model card's default of 1.0 is too hot for completion |
| `debounceMs` | integer, `300` | Wait after the last keystroke before requesting |
| `triggerMode` | enum `automatic` \| `manual`, `automatic` | Manual = only on the trigger command |
| `keepAlive` | string, `30m` | Passed as `keep_alive` so the model stays loaded |
| `disabledLanguages` | string[], `["plaintext","markdown"]` | Language IDs that never trigger |

Keybindings are not a setting. They are contributed commands (§8) that the user
rebinds through VS Code's standard keybindings editor.

## 6. Prompt strategy

### 6.1 `fim` mode (default)

Request: `POST /api/generate` with `raw: true`, `stream: true`, `think: false`,
`keep_alive`, and options `{ temperature, num_predict, stop }`.

Prompt layout (Qwen FIM tokens):

```
<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>
```

- `prefix` = up to `contextLinesAbove` lines ending at the cursor, including the
  partial current line.
- `suffix` = text from the cursor to the end of the current line plus up to
  `contextLinesBelow` lines.
- Stop sequences: `<|endoftext|>`, `<|fim_pad|>`, `<|repo_name|>`, `<|file_sep|>`,
  plus `"\n"` when `maxLines` is 1.

FIM token names are a per-model detail. Keep them in one table keyed by model
family so another FIM-capable model can be added with one line. Models that do
not know the tokens will produce garbage in `fim` mode; the README says to switch
to `chat` mode for those.

### 6.2 `chat` mode

Request: `POST /api/chat` with `stream: true`, `think: <setting>`, `keep_alive`,
messages = `[system: instructions, user: <prefix>␣<CURSOR>␣<suffix>]`.

Default `instructions`:

```
You are an inline code completion engine inside a code editor.
You will receive a file excerpt containing the marker <CURSOR>.
Reply with ONLY the code that should be inserted at <CURSOR>.
Rules:
- Do not repeat any code that already appears before or after the marker.
- Do not add explanations, comments about your reasoning, or markdown fences.
- Match the indentation, naming, and style of the surrounding code.
- Stop as soon as the immediate statement, block, or expression is complete.
```

When `thinking` is true, the `thinking` field of the stream is discarded and
only `content` is shown. The status bar shows a spinner during thinking since
latency will be noticeably higher.

### 6.3 Post-processing (both modes, pure function, heavily unit-tested)

In order:

1. Strip a leading/trailing markdown fence (```lang … ```).
2. Strip any stray FIM/special tokens.
3. If the completion starts by repeating the text after the cursor on the same
   line, drop that overlap.
4. If the completion ends with text that duplicates the start of the suffix,
   drop the duplicate tail.
5. Truncate to `maxLines` lines.
6. Trim trailing whitespace on the last line; return empty string if nothing is
   left (so no ghost text is shown).

## 7. Architecture

```
ollama_complete/
  LICENSE                   MIT, copyright Pawpaw Analytics, ltd.
  package.json              manifest: activation, commands, settings, keybindings
  tsconfig.json
  esbuild.mjs               bundle src/extension.ts -> dist/extension.js
  src/
    extension.ts            activate(): wire config, provider, status bar, commands
    provider.ts             InlineCompletionItemProvider: debounce, cancel, cache
    context.ts              pure: build {prefix, suffix} from a document + position
    prompt.ts               pure: FIM prompt / chat messages from {prefix, suffix}
    postprocess.ts          pure: §6.3
    ollama.ts               fetch-based client: generate(), chat(), listModels(), warm()
    config.ts               typed accessor over workspace.getConfiguration
    statusBar.ts            "$(sparkle) qwen3.5:2b" / spinner / "off"; click toggles
  test/
    unit/                   vitest, no vscode import: context, prompt, postprocess, ollama (mocked fetch)
    live/                   vitest, runs only if OLLAMA_LIVE=1: real request to qwen3.5:2b
    integration/            @vscode/test-electron: activation, settings, command registration
  fixtures/                 small source files in several languages for context/prompt tests
  README.md
  CHANGELOG.md
```

Everything that can be tested without VS Code lives in pure modules that take
plain strings and objects. `provider.ts` and `extension.ts` are the only files
that import `vscode`, and they stay thin.

### 7.1 Completion flow

1. Editor calls `provideInlineCompletionItems(doc, pos, ctx, token)`.
2. Bail out early if: extension disabled, language in `disabledLanguages`,
   `triggerMode` is manual and this is an automatic invocation, or the cursor
   is in the middle of a word with non-whitespace immediately to the right
   (configurable later; keeps noise down).
3. Debounce `debounceMs`. If `token` is cancelled during the wait, return.
4. Build context and prompt, compute a cache key
   (`model + mode + prefix + suffix`). Return the cached result if present.
5. Abort any in-flight request, start a new one with an `AbortController` tied
   to `token.onCancellationRequested`.
6. Stream tokens, accumulate, stop early once `maxLines` newlines are seen.
7. Post-process. Cache. Return one `InlineCompletionItem` with the text and
   a range starting at the cursor.
8. Status bar reflects idle / working / error; errors (host down, model
   missing) are shown once per session as a warning with a "Pull model" or
   "Open settings" action, not on every keystroke.

## 8. Commands and keybindings

| Command | Default key | Purpose |
|---|---|---|
| `pawplete.trigger` | `alt+\` | Request a completion now (works in manual mode) |
| `pawplete.toggle` | none | Enable / disable |
| `pawplete.selectModel` | none | Quick-pick from `GET /api/tags` and write to settings |
| `pawplete.acceptLine` | none | Accept only the first line of the shown suggestion |

Tab accept, Escape dismiss, and alt+] / alt+[ cycling are VS Code built-ins for
inline completions and need no code.

## 9. Testing (test-first)

Each milestone below starts with its tests. Nothing is merged without them.

- **Unit (vitest).** `context.ts`, `prompt.ts`, `postprocess.ts`, `ollama.ts`.
  Ollama client tests mock `globalThis.fetch` and feed canned NDJSON streams,
  including a mid-stream abort and an HTTP error body. Table-driven cases for
  post-processing: fenced output, suffix overlap, maxLines truncation, empty
  result, CRLF documents.
- **Live (vitest, opt-in).** `OLLAMA_LIVE=1 npm run test:live` sends the
  fibonacci FIM prompt from §3 to the real server and asserts a non-empty,
  fence-free, indented body. This is the regression test for the model/prompt
  pairing; it is skipped in normal runs so the suite stays hermetic.
- **Integration (@vscode/test-electron).** Downloads a VS Code build on first
  run. Asserts: extension activates, all commands are registered, settings have
  the documented defaults, provider is registered for `*` and returns no items
  for a disabled language. Ollama is stubbed by pointing `host` at a tiny local
  HTTP server started by the test.
- **Manual smoke (checklist in README).** Install the `.vsix` in VSCodium,
  open `fixtures/`, confirm ghost text appears, Tab accepts, Escape dismisses,
  status bar toggles, model picker lists `qwen3.5:2b`, cold-start warms within
  ~10 s, and `chat` mode with thinking on still returns usable text.

## 10. Milestones

**M0. Prerequisites (this machine)**
- Install Node LTS via nvm (no sudo needed). Confirm `node --version` ≥ 20.
- `npm init`, TypeScript, esbuild, vitest, `@types/vscode`, `@vscode/vsce`,
  `@vscode/test-electron`. No runtime deps.
- `npm run build`, `npm test`, `npm run package` scripts. A `.vscodeignore`.
- Tests: `npm test` runs and passes with a single placeholder test.

**M1. Pure core**
- Tests first for `context.ts`, `prompt.ts`, `postprocess.ts`.
- Implement until green. Include the §6.2 default prompt as an exported constant
  so the test can assert the manifest default matches it.
- Tests for `ollama.ts` with mocked fetch; implement `generate`, `chat`,
  `listModels`, `warm`, streaming parser, abort.
- Live test against `qwen3.5:2b` passes with `OLLAMA_LIVE=1`.

**M2. Extension glue**
- Integration tests for activation, commands, settings defaults.
- `config.ts`, `statusBar.ts`, `provider.ts` (debounce, cancel, cache),
  `extension.ts`. Warm the model on activation.
- Error UX from §7.1 step 8.

**M3. Package and smoke**
- `vsce package` → `pawplete-0.1.0.vsix`.
- `codium --install-extension pawplete-0.1.0.vsix`.
- Run the manual checklist in §9 on `qwen3.5:2b`; record timings in the README.

**M4. Polish (only if M3 is solid)**
- `acceptLine` command, per-language `disabledLanguages` tuning, small LRU
  cache size setting, CHANGELOG. No public publishing; the `.vsix` is the
  deliverable.

## 11. Risks and open questions

- **Model swaps.** FIM tokens differ by model family. `gemma4` and others on
  this machine will not work in `fim` mode; the model picker should hint
  "use chat mode" for unknown families.
- **Thinking in chat mode** can take many seconds on small models and produce
  nothing useful for completion. It stays available because the brief asks for
  it, but it defaults off and the README says why.
- **Partial-word triggering** is the main source of noisy suggestions. Start
  conservative (step 2 in §7.1) and loosen if it feels sluggish.
- **Decided:** name Pawplete, publisher Pawpaw Analytics, ltd., MIT license,
  private `.vsix` distribution only.
- **Still open:** is installing Node LTS via nvm acceptable, or is there a
  preferred toolchain on this machine?
## 12. Status (2026-10-20)

| Milestone | State |
|---|---|
| M0 prerequisites | Done. Node v24 LTS via nvm (`. ~/.nvm/nvm.sh` in new shells), toolchain installed, scripts wired |
| M1 pure core | Done. 55 unit tests pass; 3 live tests pass against `qwen3.5:2b` (`npm run test:live`) |
| M2 extension glue | Done. 7 integration tests pass in a downloaded VS Code (`npm run test:integration`) |
| M3 package and smoke | `pawplete-0.1.0.vsix` built and installed in VSCodium. Manual checklist in README §"Manual smoke checklist" not yet run by a human |
| M4 polish | Not started |

Deviation from §7: the editor-agnostic pipeline (bail-outs, debounce, cache,
cancellation) lives in `src/engine.ts` with its own unit tests, and
`src/provider.ts` is a thin adapter over it. The `acceptLine` command simply
forwards to VS Code's built-in `editor.action.inlineSuggest.acceptNextLine`.

### 0.3.0 harness upgrades (2026-10-20)

Measured against live `qwen3.5:2b` before changing anything:

- The model card's `presence_penalty: 1.5` produced worse code (off-target
  comments, wrong indentation). Requests now send `presence_penalty: 0`.
- The model opens most completions with `\n`, even mid-line. A plain `"\n"`
  stop sequence would therefore return nothing for single-line suggestions, so
  the newline stop was removed. Line limits are enforced in `onToken` (leading
  blank lines not counted), and `postprocess` re-bases or joins the text.
- A prompt ending in a space (`orders <- `) gave stray characters
  (`'fetch_table(...)`). Trailing spaces on a code line are trimmed from the fim prefix.
- Repo-level fim (`<|file_sep|>path` blocks before the current file) made both
  qwen3.5:2b and starcoder2:7b call a helper defined in another open file
  correctly. Without it, both invented a function.

Stale `tsc` output (`src/*.js`, from before 0.2.0) was shadowing the `.ts`
sources in vitest and was moved out of `src/`.


### Definition lookup (2026-10-20, unreleased)

`src/definitions.ts` (pure) picks the symbols at the cursor: the callee of the
innermost open `(` first, then other identifiers on the last 5 lines, nearest
first, at most 6, plus any unfinished word of 3+ characters at the cursor.
`src/definitionSource.ts` resolves them with `vscode.executeDefinitionProvider`
and `vscode.executeWorkspaceSymbolProvider`, keeps workspace files only, skips
anything already in the visible window, and reads closed files with
`workspace.fs` so they never join the open-document neighbours. Definitions are
trimmed to doc comment + signature + up to 12 lines of body, deduplicated
against cross-file snippets, and placed last before the current file. The
lookup gets 250 ms.

Measured on an R helper with an unguessable name (`wh_pull_ord_snapshot`) in a
closed file, temperature 0:

| Prompt | qwen3.5:2b | starcoder2:15b |
|---|---|---|
| `orders <- wh_`, no lookup | nothing | `get_orders(con, ...)` (invented) |
| `orders <- wh_`, lookup | `get_orders(con, as_of = ..., region = "na")` | `pull_ord_snapshot(con, as_of = ..., region = "na")` |
| `wh_pull_ord_snapshot(con, `, no lookup | `"")` | two made-up date strings |
| `wh_pull_ord_snapshot(con, `, lookup | `"2019-05-31")` | `as.Date("2018-05-31"))` |

The 2B model takes the arguments from a definition but not the name; 15B gets
both. qwen3.5:4b returned nothing in every case, with or without lookup (not
investigated).

Test host note: VS Code's test instance sends go-to-definition to the
syntax-only tsserver, which cannot see other files. The integration suite sets
`typescript.tsserver.useSyntaxServer: never` for its lookup tests.
