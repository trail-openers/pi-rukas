# Environment knobs

The scripts hold no repo paths, forge URLs, provider settings or usernames. Everything
environment-specific arrives through the environment or an argument, and is validated.

## Required inputs

| var | meaning |
|---|---|
| `FANOUT_REPO` | absolute path to a **clean** checkout of the target repo (`--repo` sets it). Must be a git repo; validated. |
| `FANOUT_FORGE_URL` | the push url. Derived from `origin` when omitted. A local path is refused (exit 3). |

**The local-origin trap.** `git clone --shared <local-path>` makes `origin` the local path.
`worker.sh` repoints it to the forge. If the repo was itself seeded from a local clone, pass
`--forge-url` explicitly.

## Concurrency and budgets

| var | default | notes |
|---|---|---|
| `FANOUT_WORKERS` | 1 | requested N. `drive.sh` passes its `--parallel` down. Must be 1..4. |
| `FANOUT_SPAWN_CAP` | `64 / divisor`, floor 4 | overrides the division entirely |
| `FANOUT_VERIFY_CONCURRENCY` | `4 / divisor`, floor 1 | |
| `FANOUT_MAX_WORKSTREAMS` | `6 / divisor`, floor 1 | |
| `FANOUT_CAP_DEFAULT`, `FANOUT_CONC_DEFAULT`, `FANOUT_WS_DEFAULT` | 64, 4, 6 | the undivided values the division starts from |
| `FANOUT_NODE_OPTIONS` | `--max-old-space-size=<heap>` | set it and the heap heuristic is ignored |
| `FANOUT_LEAN`, `FANOUT_HEAP_MB` | off, 3072 | read by `capacity.sh` only; heap must be a positive whole number |

The **divisor** is `max(requested N, live workers on this WORKERS_DIR)`. The floors and the N
ceiling are in host-limits.md.

If `runner.log` shows `spawn_cap=64` when you asked for 3 workers, N did not propagate. Check
that line; it is printed at start so the mistake is visible rather than inferred from an OOM.

## Timeouts

| var | default | on expiry |
|---|---|---|
| `FANOUT_TIMEOUT_GH` | 60 | exit 5 (forge state unknown) |
| `FANOUT_TIMEOUT_FETCH` | 120 | warning; the cycle runs on local refs |
| `FANOUT_TIMEOUT_INSTALL` | 600 | exit 10 |

## SSH identity and the trust boundary

Pushes go out over SSH. A cycle is autonomous and runs as your user, so **whatever identities
the inherited agent holds, every cycle can use.** That is the trust boundary, and it is the
default. A cycle that is misjudged can push to any repo those keys reach.

| var | effect |
|---|---|
| *(unset)* | reuse the inherited agent if it has identities; otherwise start a private agent. Refuse before the clone if no identity is loaded (exit 3). |
| `FANOUT_SSH_KEY=<path>` | start a private agent holding **only** that key, and set `GIT_SSH_COMMAND` with `IdentitiesOnly=yes`. Use this for a fleet. The key must not need a passphrase prompt, because the run is unattended. |
| `FANOUT_SKIP_PUSH_CHECK=1` | skip the identity refusal. Pushes will then fail after the whole cycle. Use it only for runs that do not push (dry runs, tests). |

## JS runtime and provider

The JSON readers run under **bun**, pi-rukas's own runtime. Node is a fallback. The scripts are
`require`-style CommonJS, which both runtimes load.

| var | notes |
|---|---|
| `FANOUT_JS` | explicit runtime. Wins over everything. Set but not executable is an error (exit 2). |
| `FANOUT_NODE` | alias for `FANOUT_JS`, kept for old setups. Same rule. |
| *(order)* | `FANOUT_JS`, then `FANOUT_NODE`, then `type -P bun`, then `type -P node`, then exit 2. |
| `FANOUT_NODE_TLS_INSECURE` | **unset by design.** Set to `0` only for a provider you trust with a self-signed certificate. pi-rukas forwards `NODE_TLS_REJECT_UNAUTHORIZED` to every child, so a global value disables TLS verification for the whole fleet. |

## Gates

| var | effect |
|---|---|
| `FANOUT_FORGE_CHECK` | `1` reads the forge (closed and attention gates). `0` skips the reads and warns on each skipped gate. Dry runs default to 0 and say `NOT CHECKED` in their output. |
| `FANOUT_ALLOW_ATTENTION=1` | run an issue carrying `needs-human-attention` anyway (the gate warns). |
| `FANOUT_SKIP_STALE=1` | skip the whole staleness gate (warns). |
| `FANOUT_TRIAGE_FILE` | a different triage table. Default `<root>/triage.tsv`. |

## Paths, runner and claims

| var | default | notes |
|---|---|---|
| `FANOUT_ROOT` | `<repo>/tmp/fanout` | inside the repo's scratch dir, never the repo root |
| `FANOUT_RUNNER` | `<clone>/bin/pi-rukas-headless` | the runner the worker executes. No source fallback: a missing runner is exit 12. |
| `FANOUT_CLAIMS_RELPATH` | `.pi/work-state/path-claims.json` | where the claims file sits inside the repo and each clone. Relative, no `..`. |
| `FANOUT_CLAIMS_SOURCE` | unset | replaces the whole claims search with one file (a test hook and an explicit override). |
| `FANOUT_TRANSCRIPTS_DIR` | `<root>/runs/issue-<N>/transcripts` | |
| `FANOUT_SUMMARY_LOCK_WAIT` | 60 | seconds a worker waits for the summary lock. Whole number. |

Repo-root debris is a real failure mode: an untracked file left at the root makes
`git status --porcelain` dirty, which has aborted the branch step of live cycles.

## Pi-rukas variables the scripts set for you

Do not also set these in your shell unless you mean to override the fleet globally.

| var | value | why |
|---|---|---|
| `PI_ENSEMBLE_PARALLEL_WORK` | `0` | headless runs one group at a time already; this makes the shape explicit |
| `PI_ENSEMBLE_HANDOFF_CHANNEL` | `host` | no forge comment, no `needs-human-attention` label; the handoff body returns in the JSON result |
| `PI_ENSEMBLE_RUNS_DIR` | per-run | transcripts with the run they belong to |

`HANDOFF_CHANNEL=host` has one consequence: the attention gate still **reads** that label. To
make handed-off issues refuse plain re-runs, apply the label yourself.

## Test hook

`FANOUT_RUNNER_ENV_DUMP=<file>` makes a real worker write the environment its runner will
inherit, then exit 0 before any clone. The selftest uses it to check the budget reaches the
runner. Do not set it in production.

## Verifying before a fleet

```bash
cd "$REPO" && bin/pi-rukas-headless --capabilities
```

`resources.limits` shows the caps a cycle will run under. `resources.budget` shows what
`hostBudget()` derived, which on a pressured host is the number to distrust. `version`
identifies the build every worker will run. This starts no cycle and touches no network.
