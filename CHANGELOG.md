# Changelog

## Unreleased

- fim prompts include definitions from the language server for the call being
  typed, nearby identifiers, and workspace symbols that start with a partly
  typed name, including from files that are not open. New setting
  `pawplete.definitionContextChars` (default 1500). Qwen and StarCoder only.

## 0.3.0 (2026-10-20)

- Adaptive suggestion length: one line when the cursor line has code, up to
  `maxLines` on a blank line. New setting `pawplete.adaptiveLines` (default on).
- fim prompts include the file path and related code from other open files
  (Qwen and StarCoder). New setting `pawplete.crossFileContextChars` (default 2000).
- `presence_penalty` is sent as 0; qwen3.5's default of 1.5 hurt code.
- Trailing spaces on a code line are left out of the fim prompt (they
  tokenised badly and produced stray characters).
- Clean-up: leading newlines dropped and the block re-indented to the cursor
  line; continuations after `<-`, `=`, `(`, `|>` and similar join the current
  line; suggestions stop where they repeat the next line or leave the block.

## 0.2.0 (2026-10-20)

- Sidebar settings panel (paw icon in the activity bar) with a model dropdown
  and a trigger button. New command **Pawplete: Open Sidebar**.

## 0.1.0 (2026-10-20)

- Initial release: inline completions via Ollama, FIM and chat modes, model
  picker, status bar toggle, manual trigger on `Alt+\`.
