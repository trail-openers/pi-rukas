# Environment knobs

Everything environment-specific arrives via the environment or an argument — the scripts
contain no repo paths, forge URLs, provider settings, or usernames. These are the
variables, with what happens if you set them wrong.

## Required inputs

| var | meaning |
|---|---|
| `FANOUT_REPO` | absolute path to a **clean** checkout of the target repo (`--repo` sets it). Must be a git repo; validated. |
| `FANOUT_FORGE_URL` | the push url. Derived from `origin` when omitted — but see the local-origin trap below. |

**The local-origin trap.** `git clone --shared <local-path>` makes `origin` the local path.
`lib.sh` repoints it to the forge, and refuses to proceed when the derived URL is itself a
local path (`/*`, `~/*`, `./*`) — a worker pushing to a local path ships nothing while
looking successful. If the repo was seeded from a local clone, pass `--forge-url` explicitly.

## Concurrency and budgets

| var | default | notes |
|---|---|---|
| `FANOUT_WORKERS` | 1 | N, used for the division. Must match `--parallel`; `drive.sh` passes it down automatically. |
| `FANOUT_SPAWN_CAP` | `64 / N`, floor 4 | overrides the division entirely |
| `FANOUT_VERIFY_CONCURRENCY` | `4 / N`, floor 1 | |
| `FANOUT_MAX_WORKSTREAMS` | `6 / N`, floor 1 | |
| `FANOUT_NODE_OPTIONS` | `--max-old-space-size=<heap>` | set it and the heap heuristic is ignored |
| `FANOUT_LEAN`, `FANOUT_HEAP_MB` | off, 3072 | read by `capacity.sh` only |

If `runner.log` shows `spawn_cap=64` when you asked for 3 workers, **N did not propagate** —
every worker then believes it owns the machine. Check that line; it is printed at start
precisely so this is visible rather than inferred from an OOM.

## JS runtime and provider

The skill runs its JSON readers under **bun**, because pi-rukas is a bun-first project (bun is
its package manager, test runner, and the runtime the extension itself executes under). Node is
only a fallback for a host without bun; the scripts are CommonJS `require`-style, which both
runtimes load identically, so no code branches on the choice.

| var | notes |
|---|---|
| `FANOUT_JS` | explicit runtime binary (bun or node). Wins over everything. |
| `FANOUT_NODE` | legacy alias for `FANOUT_JS`; still honoured. Resolution order: `FANOUT_JS` > `FANOUT_NODE` > `~/.bun/bin/bun` and the usual bun locations > `type -P bun` > `type -P node` > `command -v node` > the usual node locations > `/usr/bin/env bun`. |
| `FANOUT_NODE_TLS_INSECURE` | **unset by design.** Set to `0` only for a provider you trust with a self-signed certificate — pi-rukas forwards `NODE_TLS_REJECT_UNAUTHORIZED` to every child, so a global value silently disables TLS verification for the whole fleet. Never set it on a host that also talks to real CAs. |

Why pinning exists: some host configurations run a mode-independent bash guard that
refuses read-only command shapes (`command -v X`, `grep -rn`, `git -C <path>`) as probes of
the review findings store. Pinning the binary avoids the probe entirely. If the runtime genuinely
cannot be found the scripts fail with a named reason rather than degrading — every
structured reader needs it.

## Paths and output

| var | default |
|---|---|
| `FANOUT_ROOT` | `<repo>/tmp/fanout` — deliberately inside the repo's scratch dir, never the repo root |
| `FANOUT_TRIAGE_FILE` | `<root>/triage.tsv` |
| `FANOUT_CLAIMS_SOURCE` | `<repo>/.pi/work-state/path-claims.json` |
| `FANOUT_TRANSCRIPTS_DIR` | `<root>/runs/issue-<N>/transcripts` |

Repo-root debris is a real failure mode: an untracked file left at the root makes
`git status --porcelain` dirty, which has aborted the branch step of live cycles.

## Pi-rukas variables the scripts set for you

Do not also set these in your shell unless you mean to override the fleet globally.

| var | value | why |
|---|---|---|
| `PI_ENSEMBLE_PARALLEL_WORK` | `0` | headless runs one group at a time already; this makes the shape explicit |
| `PI_ENSEMBLE_HANDOFF_CHANNEL` | `host` | no forge comment, no `needs-human-attention` label; the handoff body returns in the JSON result. 60 parked cycles commenting on the forge is spam. |
| `PI_ENSEMBLE_RUNS_DIR` | per-run | transcripts with the run they belong to |

`HANDOFF_CHANNEL=host` has one consequence to know: the attention gate still **reads** that
label, so if you want handed-off issues to refuse plain re-runs, apply the label yourself.
`--restart` is then how you run them again — but only outside this skill, since the scripts
refuse the flag.

## Verifying before a fleet

```bash
cd "$REPO" && bin/pi-rukas-headless --capabilities
```

`resources.limits` shows the caps a cycle will actually run under; `resources.budget` shows
what `hostBudget()` derived, which on a pressured host is the number to distrust. `version`
identifies the build every worker will run. This starts no cycle and touches no network.
