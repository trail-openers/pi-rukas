# Troubleshooting the fleet

Ordered by how often it actually happens. Each entry is symptom → cause → fix, with the
check that confirms it rather than a guess.

## No stdout JSON, exit code from the runner only

`<run>/result.json` is empty; `ndjson.log` has content.

**Cause.** The runner writes NDJSON v1 to **stderr** and exactly one JSON document to
**stdout** with `--json`. Something wrote to the wrong stream, or the process died before
emitting. `stderr.ts` reroutes every stray trace/console line into NDJSON precisely so
stdout stays parseable — so a non-JSON stdout is usually a crash, not pollution.

**Check.** `tail -20 <run>/ndjson.log` — the last NDJSON event names the step that died.
Exit 30 means the heap ceiling was hit; see host-limits.md on the OOM-victim reasoning.

## Every child spawn dies with ENOENT

**Cause.** `dist/prompts/standard/<role>.md` is missing. It is gitignored, so a fresh clone
has none, and `spawnSpecialist` reads that path from the worktree.

**Check.** `ls <clone>/dist/prompts/standard/`. `worker.sh` builds it and asserts
`explore.md` exists — asserting the *file* rather than the build's exit code, because a
build can succeed and still emit nothing. If you bypassed the build, that is the cause.

## `skipped-triage` on every issue

**Cause.** No `triage.tsv`. The gate refuses to spawn blind rather than spawning into an
untriaged backlog.

**Fix.** `scripts/triage.sh <repo> > <repo>/tmp/fanout/triage.tsv`, fill the verdict
column (references/triage.md), re-run. `--override-triage` skips the gate — use it only
when you have personally read the issue, and expect to pay for it if the issue was
unbuildable.

## A stale lock, after a killed worker

`worker.sh` reports "a worker for issue N is already running".

**Cause.** The pidfile directory survived. `lib.sh` already clears a lock whose pid is dead
— so if it still refuses, either the pid is genuinely alive, or the pid has been **reused**
by the OS for an unrelated process, which makes `kill -0` succeed.

**Check.** Read `<lockdir>/pid`, `<lockdir>/label`, `<lockdir>/started`, then verify it is
actually your worker before removing anything. `rm -rf` the `*.lock` directory only once you
have confirmed the process is not a live cycle. Never `pkill` on a pattern — that kills
other users' cycles and the user's own session alike.

## Pushes go nowhere; PR never appears

**Cause.** `origin` still points at a local path. A `--shared` clone's origin *is* the local
path, so pushes land in the parent clone.

**Check.** `git -C <clone> remote -v`. Both fetch and push URLs must be the forge.
`worker.sh` repoints both and re-reads to confirm; if it passed, the push genuinely failed —
check `ssh-add -l`, since an agent without identities fails authentication silently enough
to look like a network problem.

## Workers all start and everything is slow

N is above what the host can hold; the machine is compressing rather than running.

**Check.** `memory_pressure` / swap in `vm_stat`, and `<run>/rss.log` for measured worker RSS.
If available memory is under the reserve, lower N. Raise it back from `capacity.sh
--observed`, which uses measured peak RSS rather than the heap ceiling.

## Two workers opened PRs over the same files

The path-claim gate was blind, because `files-likely-touched` was blank in `triage.tsv` for
one of them — the gate warns rather than silently passing, but the warning is easy to miss.

**Also note** the gate only checks against *currently live* claims. Two issues queued in the
same batch are both alive, so both spawn: overlapping `files-likely-touched` within one
`drive.sh` invocation is a sequencing decision you must make, not something the script can
catch.

## A worker refuses and you think the refusal is wrong

The refusal is probably right — but read it first. Every refusal exits with a distinct code
and names its reason.

| exit | meaning |
|---|---|
| 2 | usage / a forbidden flag |
| 3 | environment: no forge URL, no ssh-agent |
| 4 | no triage.tsv |
| 5 | triage says do not run this issue |
| 6 | another worker already owns this issue |
| 7 | live path-claim collision |
| 8 | clone exists (use `--force-clone`) |
| 9 | clone / remote / checkout failed |
| 10 | `bun install` failed |
| 11 | prompt build failed or emitted nothing |
| 12 | could not enter the clone |

The runner's own exit codes are a separate namespace and are the real contract:
**0** merged, **10** handoff, **11** needs clarification, **20** aborted, **21** interrupted,
**30** crash, **40** refused (a live cycle already owns the issue). `40` is not an error — it
means another process legitimately owns that cycle, and the correct response is to wait or
pick a different issue, never to force it.

## Before reporting a bug in these scripts

Reproduce with `--dry-run` (spawns nothing, prints every refusal and its reason), and
capture: `runner.log`, the `budget:` line, the tail of `ndjson.log`, and `result.json`. The
`budget:` line is what distinguishes "the fleet is misconfigured" from "pi-rukas did this" —
which is the distinction that matters most when N > 1.
