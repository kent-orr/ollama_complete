# Pawplete

Minimal inline code completion for VS Code / VSCodium, backed by a local
[Ollama](https://ollama.com) model. Ghost text appears as you type; Tab accepts it.

- Default model: `qwen3.5:2b`
- No runtime dependencies, no telemetry, talks only to your Ollama host
- Two prompt strategies: fill-in-the-middle (fast, default) or chat (custom
  instructions, optional thinking)

## Install

Download `pawplete-<version>.vsix` from the
[Releases](https://github.com/kent-orr/ollama_complete/releases) page, then:

```sh
ollama pull qwen3.5:2b
codium --install-extension pawplete-<version>.vsix   # or: code --install-extension ...
```

## Use

- Click the paw icon in the activity bar for a settings panel: model dropdown
  (filled from your Ollama host), mode, generation limits, chat instructions,
  and a **Trigger completion** button. Changes save to your user settings as
  you make them.
- Type. After a short pause a suggestion appears as ghost text.
- `Tab` accepts, `Esc` dismisses, `Alt+]` / `Alt+[` cycle alternatives (VS Code built-ins).
- `Alt+\` requests a completion right now (command **Pawplete: Trigger Completion**).
- Click the status bar item to turn Pawplete off and on.
- **Pawplete: Select Model** lists the models your Ollama host has pulled.
- **Pawplete: Accept Next Line of Suggestion** has no default key; bind it in Keyboard Shortcuts.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `pawplete.enabled` | `true` | |
| `pawplete.host` | `http://localhost:11434` | |
| `pawplete.model` | `qwen3.5:2b` | |
| `pawplete.mode` | `fim` | `fim` or `chat` |
| `pawplete.thinking` | `false` | Chat mode only. Slower; usually not worth it for completion |
| `pawplete.instructions` | (built in) | Chat mode only. System prompt |
| `pawplete.contextLinesAbove` | `100` | |
| `pawplete.contextLinesBelow` | `30` | |
| `pawplete.crossFileContextChars` | `2000` | fim mode. Related code from other open files; `0` disables |
| `pawplete.definitionContextChars` | `1500` | fim mode. Definitions of symbols near the cursor, from the language server; `0` disables |
| `pawplete.maxLines` | `5` | `1` forces single-line suggestions |
| `pawplete.adaptiveLines` | `true` | One line when the cursor line has code; up to `maxLines` on a blank line |
| `pawplete.maxTokens` | `128` | Hard cap on generated tokens |
| `pawplete.temperature` | `0.2` | |
| `pawplete.debounceMs` | `300` | |
| `pawplete.triggerMode` | `automatic` | `manual` = only on `Alt+\` |
| `pawplete.keepAlive` | `30m` | Keeps the model resident between keystrokes |
| `pawplete.disabledLanguages` | `["plaintext","markdown"]` | |

### fim vs chat

`fim` sends a raw fill-in-the-middle prompt and ignores `instructions` and
`thinking`. It is the fast, accurate default. It only works with model families
whose FIM tokens Pawplete knows: Qwen, CodeLlama, DeepSeek-Coder, StarCoder,
CodeGemma. Only Qwen has been verified against a live model. For any other
model switch `pawplete.mode` to `chat`.

For Qwen and StarCoder, fim prompts also carry the file's workspace path and
the best-matching chunks of your other open files (ranked by shared
identifiers, capped by `crossFileContextChars`), so suggestions can call your
own helpers with the right names and arguments.

They also carry definitions looked up through the editor's language servers,
including from files that are not open: the function whose call you are typing,
other identifiers on the last few lines, and workspace symbols that start with
a partly typed name. Each definition comes with its doc comment and signature
(roxygen, JSDoc, docstrings) and a few lines of body. Only code inside the
workspace is used, since the model already knows the standard library and
packages. A language server that takes longer than 250 ms is skipped for that
request. Capped by `definitionContextChars`.

### Suggestion clean-up

Small models often start a completion with a newline and guess the
indentation. Pawplete drops that newline and re-bases the block on the
indentation the editor already gave the line. After code that clearly
continues on the same line (`x <- `, `foo(`, `|>`), it joins the suggestion
onto the line. It cuts a suggestion where it starts repeating the code below
the cursor, or where it dedents out of the block you are in. It also overrides
the model's `presence_penalty` to 0, because qwen3.5 ships with 1.5 and that
penalises the repetition code needs.

## Development

```sh
npm install
npm test                  # unit tests (vitest, no Ollama needed)
npm run test:live         # real requests to qwen3.5:2b on localhost
npm run test:integration  # launches VS Code, uses a stub Ollama
npm run package           # typecheck + unit tests + bundle + .vsix
```

### Release

`.github/workflows/vsix.yml` builds the `.vsix` on every push to `main` and
every pull request (download it from the run's **vsix** artifact). Pushing a
`v*` tag also publishes a GitHub release with the `.vsix` attached. The tag
must match the `version` in `package.json`:

```sh
npm version 0.4.0 --no-git-tag-version   # bump package.json + lockfile
git commit -am "Release 0.4.0" && git push
git tag v0.4.0 && git push origin v0.4.0
```

### Manual smoke checklist

Run after `codium --install-extension pawplete-<version>.vsix` with Ollama running.

1. Open `fixtures/example.py`, put the cursor on the blank line inside
   `fibonacci`, type four spaces. Ghost text with a function body (up to
   5 lines) appears, starting on the cursor line at the right indentation.
   At the end of a line that already has code, the suggestion is one line.
2. `Tab` inserts it. `Esc` on a new suggestion dismisses it.
3. Status bar shows `$(sparkle) qwen3.5:2b`; it spins while a request runs.
4. Click the status bar item: it reads "Pawplete" with a slash and no ghost
   text appears. Click again to re-enable.
5. **Pawplete: Select Model** lists `qwen3.5:2b` and the other pulled models.
6. Open `fixtures/notes.txt` and type: no ghost text (plaintext is disabled).
7. Set `pawplete.mode` to `chat`, type in `example.py` again: still usable
   text, a little slower. Set `pawplete.thinking` to `true`: slower again,
   still text only, no reasoning leaks into the editor.
8. Stop Ollama (`systemctl stop ollama` or kill the process) and type: one
   warning notification with an "Open Settings" button, status bar shows a
   warning icon, and no further notifications on subsequent keystrokes.
9. Click the paw icon in the activity bar. The form shows current values, the
   model dropdown lists pulled models, changing a value updates
   `settings.json`, and changing a setting elsewhere updates the form.
10. First completion after a cold start takes a few seconds while the model
   loads (about 8 s for qwen3.5:2b here); later ones return well under 1 s.

## License

MIT, Pawpaw Analytics, ltd.
