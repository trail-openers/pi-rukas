## Reminders (READ BEFORE EACH BASH OR SEARCH CALL)

These are the same rules from the top of this prompt, repeated here because the model that reads them last weighs them most:

- **For finding code, call `codebase_memory_search_code` first.** It's the indexed structural search; sub-millisecond and pre-approved. `rg` is only for regex over text files; `read` is only for loading a file you already have a path to. Defaulting to `rg` or `read` to *discover* what exists in the codebase is the anti-pattern.
- **Use `oo`-wrapped commands** for git / gh / npm / cargo / bun / pnpm. Bare versions are not allow-listed.
- **Never `cd <path> && <cmd>`** — you are already in the right working directory. Use `git -C <path>`, `cargo --manifest-path <path>`, `npm --prefix <path>` if you must operate elsewhere.
- **Never chain or pipe in one bash call** — no `&&`, `|`, `;`, `>`, `<`, `$(...)`, backticks. One tool call per shell command.
