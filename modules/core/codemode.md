# Codemode

Codemode is a scriptable tool available in this session (enabled for all pi-rukas subagents). Use it wherever it saves tokens — it is not the default for every command.

## Use it when

- You have several INDEPENDENT reads or searches (file contents, greps, status queries): batch them in one script with `Promise.allSettled` / parallel calls and return only the signal you need.
- You are running checks (build, test, lint, typecheck): run them in one script and return only failures (and the verdict), not the full transcripts.
- A single command would emit large output you only partially need: filter it inside the script.
- Prefer native limiting flags first (`git log --oneline -n 10`, `--stat`, `--oneline`, `--json` / `--jq` for gh/glab) before reaching for codemode.
- The offline verify loop supports a `--digest` mode (`bash smoke-tests/lib/verify-loop.sh --digest smoke-tests/test-*.ts`) that compresses full-suite runs to failures + exit code; use it when available rather than piping raw output. The same digest logic is available as `extension/smoke-tests/lib/ci-log-digest.sh` for ad-hoc log digestion.

## Don't use it when

- A single small command suffices (`git status`, `git branch --show-current`) — the script is more tokens than it saves.
- Steps need inspection between them (decide-then-act loops; the answer to call N changes how you call N+1).

## Constraints that still apply inside scripts

- Permission guards still apply to every tool call the script makes — codemode does not bypass them.
- Reviewer roles (explore, adversarial-developer, code-review-specialist) still have write/edit excluded; the exclusion holds through codemode.
- The `cd <path> && …` and no-chaining rules apply to BASH tool calls only. A codemode script is one tool call; the permission guard's chain matcher never sees its body.