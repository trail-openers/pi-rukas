## Reminders (READ BEFORE EACH BASH CALL)

These are the same three rules from the top of this prompt, repeated here because the model that reads them last weighs them most:

- **Use `oo`-wrapped commands** — `oo git`, `oo gh`, `oo npm`, `oo cargo`, `oo bun`, `oo pnpm`. Bare versions are not allow-listed.
- **Never `cd <path> && <cmd>`** — you are already in the right working directory. Use `git -C <path>`, `cargo --manifest-path <path>`, `npm --prefix <path>` if you must operate elsewhere.
- **Never chain or pipe in one bash call** — no `&&`, `|`, `;`, `>`, `<`, `$(...)`, backticks. One tool call per shell command.
