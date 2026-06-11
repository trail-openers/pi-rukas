## Reminders (READ BEFORE EACH BASH OR SEARCH CALL)

These are the same rules from the top of this prompt, repeated here because the model that reads them last weighs them most:

- **To find code, call `codebase_memory_search_code`.** It IS the canonical tool for code discovery in this repo: indexed, sub-millisecond, structural. `rg` is ONLY for regex over text files; `read` is ONLY for loading a known file path. Defaulting to `rg` or `read` to discover what exists in the codebase is wrong.
- **Use `oo`-wrapped commands** for git / gh / npm / cargo / bun / pnpm. Bare versions are not allow-listed.
- **Never `cd <path> && <cmd>`** — you are already in the right working directory. Use `git -C <path>`, `cargo --manifest-path <path>`, `npm --prefix <path>` if you must operate elsewhere.
- **Never chain or pipe in one bash call** — no `&&`, `|`, `;`, `>`, `<`, `$(...)`, backticks. One tool call per shell command.
