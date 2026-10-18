# Host limits: why nothing composes

Read this before raising N, and before "fixing" a script by removing a division.

## Every bound is per-process; there is no cross-process coordinator

| bound | source | default | why N workers break it |
|---|---|---|---|
| spawn cap | `extension/src/spawn-semaphore.ts` → `spawnCap()`, `let active = 0` | **64** | module-scope JS state → one counter **per process** |
| verify concurrency | `extension/src/host-resources.ts` → `withVerifySlot()` | `min(cpus/2, gib/2)` | same module-scope shape |
| host budget | `extension/src/host-resources.ts` → `hostBudget()`, `cached ??=` | derived from `os.totalmem()`, `os.availableParallelism()` | **memoised per process** → each worker re-derives the *whole* machine |

Consequence: **N workers give up to N × 64 concurrent children**, each sized against the
full machine. Nothing detects it. This is why `worker.sh` divides explicitly rather than
relying on defaults, and why `capacity.sh` prints the divided numbers — a worker that
silently kept 64 is indistinguishable from a correct one unless you look.

### Two settings that make it worse than the table suggests

- **`PI_ENSEMBLE_SPAWN_CAP=0` disables the semaphore** (returns unguarded), it does not
  mean "zero children". Setting 0 to cap concurrency *removes the cap*.
- **Setting `PI_ENSEMBLE_PARALLEL_GROUPS` or `PI_ENSEMBLE_MAX_WORKSTREAMS` explicitly
  short-circuits the host budget** for that limit, reintroducing the unbounded shape.
  Prefer leaving them unset and letting the budget decide — except in a fleet, where the
  budget is wrong, so set them *divided*.

### Measured, so you can sanity-check your own numbers

8 children sleeping 20 s each, cap 64, returned inside a **1.0 s** window, ~974k tokens.
Two things follow: model concurrency is **not** the bottleneck — set it generously; and a
child costs ~120k tokens for one tool call, so cost scales with dispatch count, not wall
clock. Budget against dispatches.

## Memory is the constraint, and `totalmem` is the wrong number

`hostBudget()` reads **total** memory and there is no cgroup on macOS, so it advertises
capacity the machine does not have. Observed on a 24 GiB host:

```
free + speculative ≈ 954 MiB     compressor ≈ 4 GiB     (host otherwise idle)
```

That is the real ceiling, roughly 25 workers'-worth of *nothing*. So:

```
N ≈ floor( available_bytes / measured_worker_rss )
```

- `available_bytes`: `MemAvailable` on Linux; `(free + speculative) × 4096` on macOS.
- `measured_worker_rss`: from `runs/<issue>/rss.log`, sampled by `lib.sh`'s sampler.
- **Never `os.totalmem()`.** That is the exact bug in `hostBudget()` — it fails in the
  direction that kills processes.

Keep a reserve. `capacity.sh` refuses to eat below 20% of available for the OS, the verify
subprocesses, and whatever the user is doing interactively.

### OOM victim selection is the reason to be careful

`NODE_OPTIONS=--max-old-space-size` turns a worker OOM into a loud exit 30 in the result.
Without it the kernel picks, and it tends to pick the **largest** process — frequently the
user's own interactive cycle, not your worker. A fleet that kills the user's session is
worse than a fleet that runs at N=2.

## CPU and disk, briefly

- **CPU**: 10 cores here. Each worker is one bun process plus children that are mostly
  network-bound, so CPU saturates well after memory does. Verify commands are the CPU spike
  — `cargo`/`tsc`/test runs are why `VERIFY_CONCURRENCY` is divided rather than defaulted.
- **Disk**: `git clone --shared` costs ~300 KB of `.git`, but each worker runs
  `bun install` into its **own** `extension/node_modules` and `bun run build` into its own
  `dist/`. That is hundreds of MB per worker, times N, times re-runs. Check free disk
  before a large fleet; `tmp/fanout/workers/` is the directory that grows.
- **Shared object store**: every `--shared` clone alternates to the main object directory.
  Reads are cheap and safe. **GC is not** — see design.md §2. This is the rule that can
  damage the user's checkout.

## The known upstream gap

There is currently no host-wide bound on concurrent children, which is why the division has
to be done by hand at all. Until that exists, the fleet must treat every limit as
per-process and divide it itself. If you find a mechanism that does compose, delete the
division and say so here.
