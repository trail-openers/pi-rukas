# Why the fan-out is shaped this way

Read this before changing `scripts/`. Each rule below was established by measurement or
by reading source, not chosen for style. The failure modes they prevent are all silent.

## 1. One full clone per worker — never a worktree

The tempting shape is N worktrees of one checkout. It does not work.

`review-ledger-path.ts` resolves the per-clone review ledger from
`git rev-parse --git-common-dir`, and the #912 merge guard **fails closed** unless that
ledger contains both an `adversarial_loop` row and a `dispatch_lens_review` row for the
branch. The integration lockfile and `.worktrees/` resolve there too.

A git **worktree's** common dir is the *main* clone's `.git` — measured, not inferred:

```
main        --git-common-dir -> /path/to/repo/.git
worktree w1 --git-common-dir -> /path/to/repo/.git     <-- same
worktree w2 --git-common-dir -> /path/to/repo/.git     <-- same
```

Only `--git-dir` differs per worktree. So N worktree-hosted drivers share one ledger, one
integration lock and one worktree namespace. They do not merely contend — they corrupt the
gate that is supposed to stop unreviewed merges.

A full clone gets its own `.git` and is therefore isolated. Use `git clone --shared`, which
gives a ~300 KB `.git` that alternates to the main object store: isolation at clone cost.

## 2. Never GC, repack, or prune

`--shared` points `objects/info/alternates` at the main clone's object directory. Both
clones read the **same** objects. A `git gc` / `git repack` / `git prune` / `git worktree
prune` in a worker can delete objects the main checkout still needs.

Belt and braces, in order:
1. No script in this skill runs those commands.
2. Each clone sets `receive.autogc=false` and `gc.auto=0`, so an incidental `fetch`/`push`
   cannot schedule a background gc.
3. `remote.<name>.prune` is left false, so no remote-tracking ref pruning either.

This is the one rule where a mistake damages the user's working checkout, not just the run.

## 3. Repoint origin before anything else reads it

`git clone --shared <local-path>` sets `origin` to the **local path**. Left alone, the
worker pushes into the parent checkout and the PR never reaches the forge — a cycle that
looks like it worked and shipped nothing. Always `git remote set-url origin <forge-url>`.

## 4. Every resource bound is per-process, so divide by N explicitly

Three limits look host-wide and are not:

| bound | site | default | why it does not compose |
|---|---|---|---|
| spawn cap | `spawn-semaphore.ts` `spawnCap()`, `let active` | 64 | module-scope JS state → one counter per process |
| verify concurrency | `host-resources.ts` `withVerifySlot` | min(cpus/2, GiB/2) | same module-scope shape |
| host budget | `host-resources.ts` `hostBudget()` | memoised `cached ??=` | each process re-derives the *full* machine |

N workers therefore yield up to **N × 64** concurrent children and each independently
allocates the whole machine. There is no shared coordinator. Until the upstream host-wide
bound exists, the operator must divide by N; `worker.sh` does it, floored so a worker is
never starved below 4 slots / 1 verify / 1 workstream.

Two traps when dividing:
- `PI_ENSEMBLE_SPAWN_CAP=0` **disables** the semaphore (returns unguarded), it does not mean
  "zero children". An operator setting 0 to "limit" concurrency removes the bound entirely.
- Setting `PI_ENSEMBLE_PARALLEL_GROUPS` or `PI_ENSEMBLE_MAX_WORKSTREAMS` explicitly
  **short-circuits the host budget** for that limit, reintroducing the unbounded shape.

## 5. Headless is one cycle per process — fan out by process count

`headless/run.ts` runs grouped issues **one group at a time**; the per-group queue is not
used because it needs an interactive host's job registry. So `PI_ENSEMBLE_PARALLEL_GROUPS`
has no effect on a headless worker. Parallelism comes from running N processes, and the
scripts set `PI_ENSEMBLE_PARALLEL_WORK=0` to make the intra-process shape explicit.

## 6. Never pass `--restart`

`work <issue>` refuses to start when a live cycle owns the state file (exit 40,
`resumable: false`). `--restart` **skips that live-owner check** and wipes the state file.
Two workers pointed at one issue then both drive the same cycle, each writing its state file
and creating worktrees for it. The refusal is the only protection a cycle has against another
process owning it. The scripts refuse the flag in argv rather than merely omitting it.

## 7. Never pass merge or sandbox flags

`--merge`, `--auto-merge`, `--allow-unreviewed`, `--sandboxed` are not headless flags at all
(`parseHeadlessArgs` rejects anything that is not a number, `--restart`, `--json`,
`--timeout`). Headless merge authority comes only from the project's `AGENTS.md` read at the
cycle's base commit, citation-verified by the policy judge. A cycle that reaches the gate
merges under the project's own doctrine; otherwise it parks as `awaiting-human-merge`, which
is the correct unattended outcome. Do not attempt these flags, and never pass
`--allow-protected` to make a gate land — a cycle that can grant itself `.pi/` access can
grant itself access to what it is judged against.

## 8. `HANDOFF_CHANNEL=host` for unattended runs

The default `forge` channel posts a handoff comment and applies `needs-human-attention`.
Under a fleet, 60 parked cycles posting comments is spam. `host` posts nothing and returns
the handoff body in the JSON result, so the driver decides what the operator sees.

The attention gate still **reads** that label, so a host that wants handed-off issues to
refuse plain re-runs must apply the label itself; `--restart` is then how it runs them again.

## 9. Memory, not CPU, is usually the binding constraint

`hostBudget()` reads `os.totalmem()` and finds no cgroup on macOS, so it advertises the whole
machine while the machine is starved. Observed on a 24 GiB host: **954 MiB free+speculative
with nothing running** and a 4 GiB compressor. So size workers from observed free memory:

```
max_workers ≈ observed_free_bytes / observed_worker_rss
```

Never from `totalmem`. The heap cap in `worker.sh` is a ceiling that turns an OOM into a loud
exit 30 rather than the kernel picking a victim — and the victim may be the user's own cycle.

## 10. The provider is rarely the limit

Measured: 8 children each sleeping 20 s returned inside a 1.0 s window, ~974k tokens.
Set model concurrency generously and spend tuning effort on the verify gate instead.
