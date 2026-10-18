# Troubleshooting the fleet

Ordered by how often it happens. Each entry is symptom → cause → fix, with the check that
confirms the cause rather than a guess.

## Worker refuses: which exit code, and is the refusal right?

The refusal is usually right, but read it first. Every refusal exits with a distinct code and
names its reason.

| exit | meaning | where to look |
|---|---|---|
| 2 | usage, a forbidden flag, or N above 4 | the message names the flag |
| 3 | forge url, ssh identity, or `FANOUT_SSH_KEY` | `ssh-add -l`; `git remote -v` |
| 4 | no `triage.tsv`, or it lacks a required column | the message names the column |
| 5 | triage verdict, closed or attention-labelled issue, named file gone, or forge read failed or timed out | `summary.tsv`, then the message |
| 6 | another worker already holds this issue | `<lockdir>/pid`, `started`, `label` |
| 7 | a live cycle or reservation owns one of the declared paths | the message names the owner |
| 8 | clone exists (`--force-clone` rebuilds it) | the clone's `.pi/work-state/` |
| 9 | clone, origin or checkout failed | `git -C <clone> remote -v` |
| 10 | `bun install` failed or timed out | `FANOUT_TIMEOUT_INSTALL`; the install tail |
| 11 | prompt build failed (tail is in the message), or a claims file is unreadable or corrupt | `<run>/build.log`; the named claims file |
| 12 | runner not executable in the clone | `FANOUT_RUNNER`; the build |
| 13 | reservation lock held for 30 s | a live worker in `WORKERS_DIR` |
| 14 | reservation could not be written | disk space; `WORKERS_DIR` permissions |

The runner's own codes are a separate contract, returned when a cycle ran: **0** merged,
**10** handoff, **11** needs clarification, **20** aborted, **21** interrupted, **30** crash,
**40** refused (a live cycle already owns the issue). `40` is not an error. It means another
process owns that cycle, so wait or pick another issue. Never force it.

**Exit 10 is ambiguous on its own.** It is a runner handoff *or* a failed dependency install.
`drive.sh` reads the runner's `exitCode` from `result.json` to tell them apart, so check that
file rather than the worker's exit alone.

## `drive.sh` exited 1

One or more workers did not finish cleanly. Exit 0 means every worker merged or handed off
(runner `exitCode` 10). Exit 1 means at least one did not. The per-issue status is in
`<root>/summary.tsv`. Read the `status` and `failedStep` columns, then look up that row's code
in the table above.

## `skipped-triage` on every issue

No `triage.tsv`, or the table lacks a required column (`issue`, `files-likely-touched`,
`verdict`, `blocked-reason`). Exit 4 names the missing column.

**Fix.** Generate it (`scripts/triage.sh` or `scripts/gen-triage.js`), fill the verdicts, and
re-run. `--override-triage` skips the gate. Use it only when you have read the issue yourself,
and expect to pay for it if the issue is unbuildable.

## A stale lock, after a killed worker

`worker.sh` reports "a worker for issue N is already running".

**Cause.** The pidfile directory survived its process. A lock whose pid is dead is cleared
automatically. A lock with **no pid** is treated as live for 5 s, because another worker may be
between its `mkdir` and its pid write. A lock stuck in `<dir>.clearing` for more than 10 s is a
clearer that died mid-clear, and it is aged out.

If it still refuses, either the pid is alive, or the OS has reused the pid for an unrelated
process, which makes `kill -0` succeed.

**Check.** Read `<lockdir>/pid`, `label` and `started`. Confirm the process is not a live cycle
before removing anything. Remove the `*.lock` directory by hand. Never `pkill` on a pattern: that
kills other users' cycles and the user's own session alike.

A `<dir>.stale.<pid>` directory is a lock that was displaced during an unlucky clear. It is
left in place for you to inspect. Remove it once its pid is dead.

## Pushes go nowhere; PR never appears

**Cause.** `origin` still points at a local path. A `--shared` clone's origin *is* the local
path, so pushes land in the parent clone. `worker.sh` repoints both fetch and push URLs to the
forge and re-reads them.

**Check.** `git -C <clone> remote -v`. Both URLs must be the forge. Since the ssh check moved
ahead of the clone, a missing identity now stops the worker with exit 3 before anything is
cloned. If you bypassed that with `FANOUT_SKIP_PUSH_CHECK=1`, it is expected to fail here.

## A cycle hangs in the forge read, the fetch or the install

Each of these is bounded, and a timeout is reported by name.

| step | bound | timeout reads as |
|---|---|---|
| `gh issue view` | `FANOUT_TIMEOUT_GH` (60 s) | exit 5, "timed out after Ns" |
| `git fetch` | `FANOUT_TIMEOUT_FETCH` (120 s) | warning; the cycle runs on local refs |
| `bun install` | `FANOUT_TIMEOUT_INSTALL` (600 s) | exit 10, "timed out after Ns" |

A bound kills the named process. It does not kill that process's children. A `bun` that
spawned `git` can leave the `git` running until it finishes. Check with `ps` before assuming the
worker is free.

## Workers all start and everything is slow

N is above what the host can hold, and the machine is compressing rather than running.

**Check.** `vm_stat` (free and speculative pages), `memory_pressure`, and `<run>/rss.log` for
measured worker RSS. If available memory is under the reserve, lower N. Raise it again from
`capacity.sh --observed`, which uses measured peak RSS rather than the heap ceiling.

## A second drive.sh is slower than the first

The budget divides by the **live** workers on this `WORKERS_DIR`, so two drives split the host
between them. A worker started earlier keeps the larger share it started with, because the
division is a snapshot taken at worker start. Look for `host share:` in the worker's output.

## Two workers opened PRs over the same files

A path reservation is taken at worker start under a lock, and it covers workers that have not
cloned yet. Two overlapping workers can no longer both pass. If an overlap still happened, check
the issue's `files-likely-touched`: a blank cell declares no path, and the worker warns that it is
blind for that issue. The gate checks only paths that were declared.

Overlap between two issues queued in the **same** `drive.sh` run is still a sequencing decision,
which `gen-triage.js` makes for you.

## Before reporting a bug in these scripts

Reproduce with `--dry-run`, which spawns nothing and prints every refusal with its reason. Then
capture `runner.log`, the `budget:` line in it, the tail of `ndjson.log`, and `result.json`.
The `budget:` line is what separates "the fleet is misconfigured" from "pi-rukas did this".
