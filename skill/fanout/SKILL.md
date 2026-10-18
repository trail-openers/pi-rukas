---
name: fanout
description: Drive many independent pi-rukas /work cycles at once, one per ephemeral clone, to drain a GitHub/GitLab issue backlog in parallel. Use when the user asks to fan out work, run many instances or workers, parallelize /work cycles, empty or drain an issue backlog, self-build a repo, scale cycles across issues, or asks how many concurrent cycles a host can run. Do NOT use for running a single issue (use /work or pi-rukas-headless directly), for dispatching subagents inside one cycle (that is dispatch_parallel), or for parallelizing the test suite.
---

# Fan out pi-rukas /work cycles across ephemeral clones

Run N independent `/work` cycles concurrently, each in its own clone of the target repo,
each bounded so the host survives. The unit of parallelism is a **process**, not a worktree
and not a subagent.

Read `references/design.md` before modifying anything under `scripts/`. Every rule in it
prevents a failure that is silent, and several prevent damaging the user's real checkout.

## Resolve these four things first

| what | how |
|---|---|
| `REPO` | absolute path to a clean checkout of the target repo |
| `FORGE_URL` | push url — `git -C "$REPO" remote get-url origin`. If origin is a **local path**, this repo was itself cloned from a local path and the forge url must be supplied explicitly or workers push into their parent |
| `ISSUES` | issue numbers, in priority order |
| `N` | concurrent workers — **derive it, never assume it** (below) |

Then check the runner answers:

```bash
cd "$REPO" && bin/pi-rukas-headless --capabilities
```

Read `resources.budget` and `resources.limits` from that output, and treat `version` as the
build the fleet will run. `--capabilities` starts no cycle, reads no repo and makes no network
call, so it is safe to probe from anywhere.

## Size N from free memory, not from the machine

This is the step people get wrong, and the reason is in `references/design.md` §9:
pi-rukas's `hostBudget()` reads `os.totalmem()`, not free memory, so a 24 GiB machine that
is already 23 GiB committed still advertises full capacity to every worker.

```bash
vm_stat                          # macOS: (free + speculative) pages × 4096
# or: memory_pressure  |  (Linux) awk '/MemAvailable/{print $2*1024}' /proc/meminfo
```

```
worker_rss  ≈ 1.5 GiB --lean   |   3 GiB default
N_max       =  floor( available_bytes / worker_rss )
```

Start at `N = 2`, read the actual peak RSS out of `runs/<issue>/rss.log`, and raise N from
the measurement. `capacity.sh` prints the numbers and a recommended N; do not hardcode a
default from a previous host — CPU count and total RAM both lie here.

## Drain a backlog

```bash
# 1. Triage first — never spawn blind. See references/triage.md for the schema.
scripts/triage.sh "$REPO" > "$REPO/tmp/fanout/triage.tsv"
# Or, once the verdicts are judged, derive the table from the validated list (triage.md):
bun scripts/gen-triage.js "$REPO/tmp/fanout/validated-oldest.tsv" "$REPO/tmp/fanout/triage.tsv"

# 2. Dry-run: prints what would run and why anything is refused, spawns nothing.
scripts/drive.sh --repo "$REPO" --parallel 2 --dry-run 1514 1515 1516

# 3. Run.
scripts/drive.sh --repo "$REPO" --parallel 2 1514 1515 1516
```

One row per finished cycle lands in `tmp/fanout/summary.tsv`: issue, status, cap, failedStep,
exit, cost, duration, dispatches, PR, branch.

Per-worker overrides: `--lean` (heap 1536 MB, one workstream, one verify slot — use this to
push N higher), `--timeout <min>`, `--force-clone`, `--override-triage` (only when you have
personally checked the block it is ignoring).

## Validate before you build (this is not optional)

An issue being open does not mean it is still true. The oldest tickets have had the most
upstream change happen under them, and a cycle cannot cheaply discover staleness — it pays a
full explore + plan and returns a park, or in the already-implemented case **builds a duplicate
of something that already merged**.

Two layers, deliberately split by cost:

**Mechanical, in `worker.sh`** (`fanout_require_current`, milliseconds, no LLM) — refuses when
the issue is closed on the forge, when it carries `needs-human-attention` (a previous cycle
handed it off and nothing revised it, so re-running reproduces the same park), or when a file
the ticket names no longer exists in the clone. Set `FANOUT_ALLOW_ATTENTION=1` to run a
handed-off issue anyway, `FANOUT_SKIP_STALE=1` to disable the whole gate.

**Judgement, in triage** — "does this bug still reproduce", "is this already implemented",
"is the premise still sound" are reading-comprehension questions over the body against current
main. Answer them in `triage.tsv` as `park-stale` before spending a cycle. The mechanical gate
catches drift it can see; it cannot read.

When validating, prefer proving an issue is **stale** over proving it is ready: a
`STALE-ALREADY` with the merged PR that fixed it saves a whole cycle and retires a ticket.

## The gates, and why they refuse

`drive.sh` will not spawn an issue unless it passes all of these. A refusal is usually the
correct answer, so read it instead of reaching for `--override-triage`.

1. **triage verdict must be `ready`** — a `blocked` / `needs-human` / `park-wont-merge` /
   `park-stale` issue is refused with the recorded reason. `park-wont-merge` and `park-stale`
   matter most and mean different things: the first says the body is too thin to resolve
   (fix the body, re-run), the second says the ticket's premise no longer holds on current
   main (close it — running it builds a duplicate or parks after a full explore+plan). Both
   cost a full explore+plan to discover if you spawn anyway.
2. **live path-claim collision** — the driver records each running group's declared paths in
   `.pi/work-state/path-claims.json`, keyed by owning pid. Workers are separate clones so they
   cannot collide on disk, but the forge is shared, and two PRs over one file is a guaranteed
   conflict and a wasted cycle. Claims whose pid is dead are ignored (stale claims are not
   collisions).
3. **no second worker per issue** — a `mkdir` pidfile is the atomic claim.

## Flags these scripts will never pass

Do not add them, and do not route around the refusal. The reasoning, with the source
citations, is `references/design.md` §6–§7.

| flag | why |
|---|---|
| `--restart` | skips the live-owner check and wipes the state file. The exit-40 refusal is the *only* thing stopping two processes driving one cycle. |
| `--merge`, `--auto-merge`, `--allow-unreviewed` | not headless flags; merge authority is the project's `AGENTS.md` read at the base commit, judged by the policy judge. Unattended cycles should park as `awaiting-human-merge`. |
| `--sandboxed` | would claim a trust mode the environment never granted. |
| `--allow-protected` | operator-only. A cycle that can grant itself `.pi/` can grant itself access to what it is judged against. |
| `git gc` / `repack` / `prune` / `worktree prune` | **the dangerous one.** `--shared` clones alternate to the main object store, so a GC in a worker can delete objects the user's live checkout still needs. Each clone also sets `gc.auto=0` + `receive.autogc=false` so an incidental fetch/push cannot schedule one. |

## Provider and model settings

The model provider is rarely the limit — measured, 8 children sleeping 20 s each returned
inside a 1.0 s window. Set model concurrency generously and spend tuning effort on the verify
gate instead. Two settings are workload-specific and deliberately **not** hardcoded; read
`references/environment.md` and apply what matches this host:

- self-signed provider certificates need `NODE_TLS_REJECT_UNAUTHORIZED=0` exported to every
  worker (pi-rukas passes it through to children). Do not set it globally on a host that talks
  to real certificate authorities.
- `NODE_OPTIONS=--max-old-space-size=…` turns a worker OOM into a loud exit 30 rather than
  letting the kernel pick a victim, which may be the user's own cycle.

## Before scaling up

Read `references/host-limits.md`. In short: every resource bound in pi-rukas is **per-process**
and nothing coordinates across processes, so N workers multiply `PI_ENSEMBLE_SPAWN_CAP`, the
verify concurrency and the host budget by N. The scripts divide them explicitly; verify the
printed `worker-start:` line shows the divided values, not the defaults. If `spawn_cap=64`
appears when you asked for 3 workers, N was not propagated.

## Running these scripts from inside an agent session

Some hosts run a mode-independent bash guard that refuses commands by matching **literal
tokens in the command string** — including inside quoted arguments and inside source you pass
to `bun -e` / `node -e`. Measured refusals on one host: `grep -rn`, bare `find <path>`, `for VAR in ...; do`,
`command -v X`, `chmod <glob>`, `git status --porcelain`, `wc <file> ; echo ...` (matched as a
backup/pipe-fragment shape), `gh ... -q <template>` (the template's pipes read as a shell pipe),
and any appearance of `review-accept` / `review-findings-store` anywhere. Node's
`fs.writeFileSync` is refused by a filename heuristic while `appendFileSync` is allowed.

This is not these scripts' design; it is the host. But it has two consequences you should know
before an agent drives a fleet:

1. **The `read` tool is never refused.** Use it to inspect anything, and prefer
   `cat`/`grep -r`/`rg`/plain `git <subcommand>`/plain `gh ... --json` in bash.
2. **Create files with a quoted heredoc** — `cat > /abs/path <<'EOF'` ... `EOF`. Never node fs
   writes, never a bash for-loop.

A skill whose documented commands an agent cannot execute is a broken skill, so every command
in this skill is written in a shape that survives that guard: `while read` over here-strings,
`awk`, `tr`, and iteration delegated to node script files.

If you are an agent and a command here is refused: **do not hunt for a bypass and do not retry
variants.** Record the refused command verbatim and move on. Repeatedly probing the guard is
how four agents on this repo each burned 20-33M tokens and delivered nothing.

## Troubleshooting

Symptom → cause → fix is in `references/troubleshooting.md`. The five most common:
no stdout JSON, `dist/prompts/standard/` missing (every child spawn dies ENOENT),
`skipped-triage` when the table is missing, a stale lock after a killed worker, and a worker
whose pushes went nowhere because `origin` still points at a local path.
