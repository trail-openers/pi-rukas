# Codemode

Subagent children run with Pi's **codemode** tool: one script per tool call, executed in a sandbox that exposes this session's callable tools as `tools.<name>`. When a command would burn context, use it.

## When to use

- **Batch independent reads/searches.** One script with `Promise.allSettled` beats N separate tool calls (each call costs a round trip and a result block).
- **Run checks, return only failures.** A suite that emits hundreds of lines? The script runs it, collects the ✗ lines with their indented detail, and returns the digest (exit code included) — not the full transcript.
- **Filter large outputs.** Read the full thing in the script, return the lines that matter.
- **Use native limiting flags directly** — most commands need no script at all: `git log --oneline -10`, `git diff --stat`, `gh issue list --limit N --json number,title`.

## When not to

- A single small command with small output — a plain bash call is simpler.
- Steps that need inspection between them — if step 2 depends on reading step 1's result, run them as separate calls.

## Script notes

- One codemode call = one tool call, so the **no-shell-chaining rule does not apply inside scripts** — `&&`, pipes, and multi-line JS are fine in the script body; the permission matcher only sees the call itself.
- Guards still apply to every `tools.*` call inside the script: excluded tools (reviewer write/edit) are absent from the sandbox, and each nested call passes through the same tool_call hooks.
- The output you `return` is the only result the transcript sees — return verdicts, not transcripts.
- Verifying the offline suite? Run `bash smoke-tests/lib/verify-loop.sh --digest smoke-tests/test-*.ts` (or `oo` with it — see the injected allowlist rules above) and return the digest it prints.
