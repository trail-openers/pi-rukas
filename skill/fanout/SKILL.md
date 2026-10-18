---
name: fanout
description: Drive many independent pi-rukas /work cycles at once, one per ephemeral clone, to drain a GitHub/GitLab issue backlog in parallel. Use when the user asks to fan out work, run many instances or workers, parallelize /work cycles, empty or drain an issue backlog, self-build a repo, scale cycles across issues, or asks how many concurrent cycles a host can run. Do NOT use for running a single issue (use /work or pi-rukas-headless directly), for dispatching subagents inside one cycle (that is dispatch_parallel), or for parallelizing the test suite.
---

# Fan out pi-rukas /work cycles across ephemeral clones

Run up to four independent `/work` cycles at once, each in its own clone of the target repo,
each bounded so the host survives. The unit of parallelism is a **process**, not a worktree and
not a subagent.

Read `references/design.md` before changing anything under `scripts/`. Each rule there prevents a
silent failure, and several prevent damage to the user's real checkout. Settings are in
`references/environment.md`. Host numbers are in `references/host-limits.md`.

## Resolve these first

| what | how |
|---|---|
| `REPO` | absolute path to a clean checkout of the target repo |
| `FORGE_URL` | push url, from `git -C "$REPO" remote get-url origin`. A local-path origin means you must pass `--forge-url`. |
| `ISSUES` | issue numbers, in priority order |
| `N` | concurrent workers, 1 to 4. Derive it, never assume it. |

Check that the runner answers, without starting a cycle:

```bash
cd "$REPO" && bin/pi-rukas-headless --capabilities
```

## Size N from free memory

pi-rukas reads `os.totalmem()`, which on macOS advertises a machine that is already committed.
Size from free memory instead, using the measured RSS of a real run:

```bash
scripts/capacity.sh --repo "$REPO"          # heap-ceiling estimate
scripts/capacity.sh --repo "$REPO" --observed  # after one cycle at --parallel 1
```

Start at `N=2`, read the peak RSS in `runs/<issue>/rss.log`, and raise N from the measurement.
N above 4 is refused. The reason is in `references/host-limits.md`.

## Drain a backlog

```bash
# 1. Triage first. Never spawn blind. See references/triage.md for the schema.
scripts/triage.sh "$REPO" > "$REPO/tmp/fanout/triage.tsv"
# Or, from a validated verdict table:
bun scripts/gen-triage.js "$REPO/tmp/fanout/validated-oldest.tsv" "$REPO/tmp/fanout/triage.tsv"

# 2. Dry run: prints what would run and why anything is refused. Spawns nothing.
scripts/drive.sh --repo "$REPO" --parallel 2 --dry-run 1514 1515 1516

# 3. Run.
scripts/drive.sh --repo "$REPO" --parallel 2 1514 1515 1516
```

One row per finished cycle goes to `tmp/fanout/summary.tsv`: issue, status, cap, failedStep,
exit, cost, duration, dispatches, PR, branch.

**Exit status of `drive.sh`:** 0 when every worker merged or handed off cleanly; 1 when any did
not. Read `summary.tsv` for which, and `references/troubleshooting.md` for what each code means.

Per-worker flags: `--lean` (heap 1536 MB, one workstream; spawn cap and verify slots still divide),
`--timeout <min>`, `--force-clone`, and `--override-triage`. Use the last only when you have
personally checked the block it is ignoring.

## The gates, and why they refuse

A refusal is usually correct. Read it instead of reaching for `--override-triage`. The codes are in
`references/troubleshooting.md`.

1. **Triage verdict must be `ready`.** `blocked`, `needs-human`, `park-wont-merge` and `park-stale`
   are refused with the recorded reason. `park-wont-merge` means the body is too thin to resolve.
   `park-stale` means the ticket's premise no longer holds on main, so close it.
2. **Forge state.** The worker reads the issue once (`state` and `labels`). It refuses a CLOSED or
   MERGED issue, and one carrying `needs-human-attention`, unless `FANOUT_ALLOW_ATTENTION=1`. Files the
   ticket names must still exist in the clone. A failed or timed-out read refuses (exit 5).
3. **Path claims and reservations.** Declared paths are checked against live cycles and against
   reservations other workers hold. A reservation is taken at start, so two workers launched together
   cannot both pass.
4. **One worker per issue.** A `mkdir` pidfile is the atomic claim.

Judgement belongs in triage, not in the mechanical gate. "Does this bug still reproduce" and "is this
already done" are reading questions, and the mechanical gate cannot answer them.

## Flags these scripts will never pass

Do not add them, and do not route around the refusal. Reasons are in `references/design.md` §6–§7.

| flag | why |
|---|---|
| `--restart` | skips the live-owner check and wipes the state file. |
| `--merge`, `--auto-merge`, `--allow-unreviewed` | merge authority is the project's `AGENTS.md`, judged by the policy judge. Unattended cycles park as `awaiting-human-merge`. |
| `--sandboxed` | would claim a trust mode the environment never granted. |
| `--allow-protected` | operator-only. A cycle that can grant itself `.pi/` access can grant itself access to what it is judged against. |
| `git gc` / `repack` / `prune` / `worktree prune` | **the dangerous one.** `--shared` clones alternate to the main object store, so a GC in a worker can delete objects the user's checkout still needs. |

## Trust boundary: the ssh-agent

Cycles run unattended as your user. By default they can push with **every key the inherited agent
holds.** For a fleet, set `FANOUT_SSH_KEY=<path>` to restrict pushes to one key. The decision and its
reasons are in `references/design.md` §13, and the variables are in `references/environment.md`.

## Before scaling up

Every bound in pi-rukas is per-process, and the scripts divide each one explicitly. Verify the
`budget:` line in `runner.log` shows the divided values, not the defaults. If `spawn_cap=64` appears
when you asked for 3 workers, N did not propagate. `references/host-limits.md` has the numbers.

## Tests

```bash
bash skill/fanout/scripts/selftest.sh     # from the repo root, or by absolute path
```

The selftest runs offline. It uses a stub `gh`, fake toolchain and fixture repos under `/tmp`, and
never touches the forge.

## Running these scripts from inside an agent session

A command guard on some hosts refuses commands by literal token. Refused forms include `for ... in`
loops, `command -v`, and `grep -rn`. Every command in this skill is written in a shape that survives
it. If a command here is refused, record it verbatim and move on. Do not probe for a bypass. The full
account is in `references/design.md` §17.

## Troubleshooting

Symptom → cause → fix is in `references/troubleshooting.md`. It covers exit codes, stale locks, the
timeouts, and the `drive.sh` exit status.
